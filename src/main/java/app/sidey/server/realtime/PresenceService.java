package app.sidey.server.realtime;

import app.sidey.server.common.ApiException;
import app.sidey.server.room.RoomMembershipBoundary;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Clock;
import java.util.*;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class PresenceService implements ConnectionRegistry.Lifecycle,RoomMembershipBoundary.Observer {
    public enum Activity { ONLINE,AWAY }
    private static final class State {
        final UUID user,sid;UUID room;Activity activity=Activity.ONLINE;long heartbeat;
        State(UUID user,UUID sid,long now){this.user=user;this.sid=sid;heartbeat=now;}
    }
    private final Map<String,State> states=new HashMap<>();
    private final Set<UUID> dirty=new HashSet<>();
    private final ConnectionRegistry connections;
    private final MembershipRegistry members;
    private final Clock clock;
    public PresenceService(ConnectionRegistry connections,MembershipRegistry members,RoomMembershipBoundary boundary,Clock clock,MeterRegistry metrics){
        this.connections=connections;this.members=members;this.clock=clock;
        connections.observe(this);boundary.observe(this);metrics.gauge("sidey.presence.sessions",this,p->p.size());
    }
    @Override public synchronized void opened(String id,UUID user,UUID sid){states.put(id,new State(user,sid,clock.millis()));}
    @Override public synchronized void closed(String id){State old=states.remove(id);if(old!=null && old.room!=null)dirty.add(old.room);}
    public synchronized int size(){return states.size();}
    public synchronized void heartbeat(String id){state(id).heartbeat=clock.millis();}
    private State state(String id){State state=states.get(id);if(state==null)throw new ApiException(401,"connection_closed");return state;}
    public void focus(String id,UUID room,Activity activity){
        UUID user=connections.user(id);
        if(room==null){synchronized(this){update(state(id),null,activity);}return;}
        members.authorized(room,user,snapshot->{synchronized(this){update(state(id),room,activity);}return null;});
    }
    private void update(State state,UUID room,Activity activity){
        if(state.room!=null)dirty.add(state.room);state.room=room;state.activity=activity;state.heartbeat=clock.millis();if(room!=null)dirty.add(room);
    }
    public Map<UUID,String> snapshot(UUID room,UUID actor){return members.authorized(room,actor,current->aggregate(room,current));}
    private synchronized Map<UUID,String> aggregate(UUID room,Set<UUID> current){
        Map<UUID,String> result=new LinkedHashMap<>();current.forEach(user->result.put(user,"OFFLINE"));
        for(State s:states.values())if(room.equals(s.room) && current.contains(s.user) && clock.millis()-s.heartbeat<60_000){
            if(s.activity==Activity.ONLINE || !"ONLINE".equals(result.get(s.user)))result.put(s.user,s.activity.name());
        }
        return result;
    }
    @Override public void committed(UUID room){Set<UUID> current=members.snapshot(room);synchronized(this){
        states.values().stream().filter(s->room.equals(s.room) && !current.contains(s.user)).forEach(s->s.room=null);dirty.add(room);
    }}
    @Override public synchronized void invalidate(UUID room){states.values().stream().filter(s->room.equals(s.room)).forEach(s->s.room=null);dirty.add(room);}
    @Scheduled(fixedDelay=1000) public void tick(){
        List<String> expired;Set<UUID> changed;
        synchronized(this){long now=clock.millis();expired=states.entrySet().stream().filter(e->now-e.getValue().heartbeat>=60_000).map(Map.Entry::getKey).toList();}
        expired.forEach(id->{closed(id);connections.close(id);});
        synchronized(this){changed=Set.copyOf(dirty);dirty.clear();}
        for(UUID room:changed){var snapshot=members.recipients(room,current->aggregate(room,current));
            connections.publish(new RoomEventPublisher.RoomEvent(room,Map.of("type","presence","roomId",room,"members",snapshot),false));}
    }
}
