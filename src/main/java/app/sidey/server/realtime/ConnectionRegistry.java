package app.sidey.server.realtime;

import app.sidey.server.auth.*;
import app.sidey.server.common.*;
import app.sidey.server.room.RoomMembershipBoundary;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionalEventListener;
import org.springframework.web.socket.*;
import tools.jackson.databind.ObjectMapper;

@Component
public class ConnectionRegistry implements RoomEventPublisher, RoomMembershipBoundary.Observer {
    private static final class State {
        final UUID user, sid;
        final OutboundConnection outbound;
        final ConcurrentHashMap<UUID,Long> rooms=new ConcurrentHashMap<>();
        State(UUID user,UUID sid,OutboundConnection outbound) { this.user=user;this.sid=sid;this.outbound=outbound; }
    }
    private final ConcurrentHashMap<String,State> connections=new ConcurrentHashMap<>();
    private final AtomicLong generations=new AtomicLong();
    private final MembershipRegistry members;
    private final AuthService auth;
    private final ObjectMapper json;
    private final Executor executor;
    private final CoordinationLocks coordination;
    public interface Lifecycle { void opened(String id,UUID user,UUID sid); void closed(String id); }
    private final java.util.concurrent.CopyOnWriteArrayList<Lifecycle> lifecycle=new java.util.concurrent.CopyOnWriteArrayList<>();
    public void observe(Lifecycle listener){lifecycle.add(listener);}
    public ConnectionRegistry(MembershipRegistry members,RoomMembershipBoundary boundary,AuthService auth,ObjectMapper json,
            Executor realtimeExecutor,CoordinationLocks coordination,MeterRegistry metrics) {
        this.members=members;this.auth=auth;this.json=json;this.executor=realtimeExecutor;this.coordination=coordination;
        boundary.observe(this);
        metrics.gauge("sidey.ws.connections",connections,Map::size);
        metrics.gauge("sidey.ws.subscriptions",this,r->r.connections.values().stream().mapToInt(s->s.rooms.size()).sum());
        metrics.gauge("sidey.ws.queued.bytes",this,r->r.connections.values().stream().mapToInt(s->s.outbound.queuedBytes()).sum());
    }
    public void open(WebSocketSession socket,UUID user,UUID sid) {
        coordination.with("ws-user:"+user,()->{
            if(connections.size()>=5000 || connections.values().stream().filter(s->s.user.equals(user)).count()>=16)
                throw new ApiException(503,"connection_limit");
            var outbound=new OutboundConnection(socket,executor,131072,()->close(socket.getId()));
            State state=new State(user,sid,outbound);
            connections.put(socket.getId(),state);
            try { auth.authorize(user,sid); }
            catch(RuntimeException revoked) { close(socket.getId());outbound.close(CloseStatus.POLICY_VIOLATION);throw revoked; }
            lifecycle.forEach(l->l.opened(socket.getId(),user,sid));
            if(connections.get(socket.getId())!=state)lifecycle.forEach(l->l.closed(socket.getId()));
            return null;
        });
    }
    public void close(String id) {
        State state=connections.remove(id);
        if(state!=null) { state.rooms.clear();lifecycle.forEach(l->l.closed(id)); state.outbound.close(CloseStatus.NORMAL); }
    }
    public void subscribe(String id,UUID room) {
        State state=state(id);
        members.authorized(room,state.user,snapshot->{
            if(state.rooms.size()>=5 && !state.rooms.containsKey(room)) throw new ApiException(400,"subscription_limit");
            state.rooms.computeIfAbsent(room,key->generations.incrementAndGet());return null;
        });
    }
    public void unsubscribe(String id,UUID room) { state(id).rooms.remove(room); }
    public void send(String id,Object payload,boolean durable) {
        State state=state(id);
        state.outbound.enqueue(json.writeValueAsString(payload),durable,()->connections.get(id)==state);
    }
    private State state(String id) {
        State state=connections.get(id);
        if(state==null) throw new ApiException(401,"connection_closed");return state;
    }
    private record Recipient(String id,State state,long generation) {}
    @Override public void publish(RoomEvent event) {
        publish(event,null,null);
    }
    public void publishFrom(UUID room,UUID actor,UUID target,Object payload) {publish(new RoomEvent(room,payload,false),actor,target);}
    private void publish(RoomEvent event,UUID actor,UUID targetUser) {
        java.util.function.Function<Set<UUID>,List<Recipient>> select=snapshot->{
            if(targetUser!=null && !snapshot.contains(targetUser))throw new ApiException(403,"target_membership_required");
            List<Recipient> result=new ArrayList<>();
            connections.forEach((id,state)->{
                Long generation=state.rooms.get(event.roomId());
                if(generation!=null && snapshot.contains(state.user))result.add(new Recipient(id,state,generation));
            });
            return result;
        };
        List<Recipient> recipients=actor==null?members.recipients(event.roomId(),select):members.authorized(event.roomId(),actor,select);
        String payload=json.writeValueAsString(event.payload());
        for(Recipient target:recipients) target.state.outbound.enqueue(payload,event.durable(),()->
            connections.get(target.id)==target.state && Objects.equals(target.state.rooms.get(event.roomId()),target.generation));
    }
    @Override public void committed(UUID room) {
        Set<UUID> current=members.snapshot(room);
        connections.values().stream().filter(s->!current.contains(s.user)).forEach(s->s.rooms.remove(room));
    }
    @Override public void invalidate(UUID room) { connections.values().forEach(s->s.rooms.remove(room)); }
    @TransactionalEventListener public void revoked(SessionEvents event) {
        connections.forEach((id,state)->{if(state.sid.equals(event.sessionId())) {
            connections.remove(id,state);state.rooms.clear();
            lifecycle.forEach(l->l.closed(id));
            executeClose(state,CloseStatus.POLICY_VIOLATION);
        }});
    }
    @TransactionalEventListener public void changed(StructureChanged event) {
        // Execute outside transaction/room gates; subscriber REST refreshes domain snapshots.
        executor.execute(()->{
            Set<UUID> rooms=event.roomId()!=null?Set.of(event.roomId()):connections.values().stream()
                .filter(s->s.user.equals(event.userId())).flatMap(s->s.rooms.keySet().stream()).collect(java.util.stream.Collectors.toSet());
            for(UUID room:rooms) publish(new RoomEvent(room,Map.of("type","room.changed","roomId",room),false));
        });
    }
    private void executeClose(State state,CloseStatus status) {
        try { executor.execute(()->state.outbound.close(status)); }
        catch(RejectedExecutionException overloaded) {
            // Never perform network I/O on the transactional membership caller.
            Thread.startVirtualThread(()->state.outbound.close(status));
        }
    }
    public void closeAll(int code,String reason) {
        connections.forEach((id,state)->{connections.remove(id,state);state.rooms.clear();lifecycle.forEach(l->l.closed(id));executeClose(state,new CloseStatus(code,reason));});
    }
    public int size() { return connections.size(); }
    public UUID user(String id) { return state(id).user; }
    public UUID session(String id) { return state(id).sid; }
    public Set<UUID> subscriptions(String id) { return Set.copyOf(state(id).rooms.keySet()); }
}
