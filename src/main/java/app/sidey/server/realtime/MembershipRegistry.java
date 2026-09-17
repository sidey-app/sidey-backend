package app.sidey.server.realtime;

import app.sidey.server.common.ApiException;
import app.sidey.server.room.RoomMembershipBoundary;
import java.util.LinkedHashMap;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import org.jooq.DSLContext;
import org.springframework.stereotype.Component;

/** Reconstructible membership snapshots. PostgreSQL remains authoritative. */
@Component
public class MembershipRegistry implements RoomMembershipBoundary.Observer {
    private static final int MAX_ROOMS=10_000;
    private static final long IDLE_NANOS=java.time.Duration.ofMinutes(5).toNanos();
    private final DSLContext db;
    private final RoomMembershipBoundary boundary;
    private final LinkedHashMap<UUID, Entry> cache=new LinkedHashMap<>(16,0.75f,true);
    private record Entry(Set<UUID> members,long accessed) {}
    private record Attempt<T>(boolean found,T value) {}

    public MembershipRegistry(DSLContext db,RoomMembershipBoundary boundary) {
        this.db=db;this.boundary=boundary;boundary.observe(this);
    }

    public Set<UUID> snapshot(UUID room) {
        return access(room,null,Function.identity());
    }
    public Set<UUID> roomsForUser(UUID user){return Set.copyOf(db.fetch("select room_id from room_members where user_id=?",user).getValues(0,UUID.class));}
    public <T> T recipients(UUID room,Function<Set<UUID>,T> snapshotFn) {
        return access(room,null,snapshotFn);
    }
    public void require(UUID room,UUID actor) {
        authorized(room,actor,members->null);
    }
    public <T> T authorized(UUID room,UUID actor,Function<Set<UUID>,T> snapshotFn) {
        if(actor==null) throw new ApiException(403,"membership_required");
        return access(room,actor,snapshotFn);
    }
    private <T> T access(UUID room,UUID actor,Function<Set<UUID>,T> snapshotFn) {
        if(room==null) throw new ApiException(400,"room_required");
        for(;;) {
            // A first miss rebuilds under the write gate, never under a read
            // gate and never via mutate(), which would recurse into observers.
            Attempt<T> attempt=boundary.read(room,()->{
                Set<UUID> members=cached(room);
                if(members==null) return new Attempt<T>(false,null);
                if(actor!=null && !members.contains(actor)) throw new ApiException(403,"membership_required");
                return new Attempt<>(true,snapshotFn.apply(members));
            });
            if(attempt.found()) return attempt.value();
            boundary.write(room,()->{
                if(cached(room)==null) store(room,load(room));
                return null;
            });
        }
    }

    protected Set<UUID> load(UUID room) {
        Set<UUID> members=Set.copyOf(db.fetch("select user_id from room_members where room_id=?",room)
                .getValues("user_id",UUID.class));
        if(members.size()>12) throw new IllegalStateException("room_membership_limit_violated");
        return members;
    }
    @Override public void committed(UUID room) {
        if(cached(room)==null) return;
        try {store(room,load(room));}
        catch(RuntimeException failure) {invalidate(room);throw failure;}
    }
    @Override public void invalidate(UUID room) {
        synchronized(cache){cache.remove(room);}
    }
    /** Only called after admission is disabled and all operations have quiesced. */
    public void invalidateAll() { synchronized(cache){cache.clear();} }
    public int size() {
        synchronized(cache){prune(System.nanoTime());return cache.size();}
    }
    private Set<UUID> cached(UUID room) {
        synchronized(cache) {
            long now=System.nanoTime();
            Entry entry=cache.get(room);
            if(entry==null) return null;
            if(now-entry.accessed()>IDLE_NANOS){cache.remove(room);return null;}
            cache.put(room,new Entry(entry.members(),now));
            return entry.members();
        }
    }
    private void store(UUID room,Set<UUID> members) {
        Set<UUID> snapshot=Set.copyOf(members);
        if(snapshot.size()>12) throw new IllegalStateException("room_membership_limit_violated");
        synchronized(cache) {
            long now=System.nanoTime();prune(now);
            cache.put(room,new Entry(snapshot,now));
            while(cache.size()>MAX_ROOMS) cache.remove(cache.keySet().iterator().next());
        }
    }
    private void prune(long now) {
        var iterator=cache.entrySet().iterator();
        while(iterator.hasNext()) {
            Entry entry=iterator.next().getValue();
            if(now-entry.accessed()>IDLE_NANOS) iterator.remove(); else break;
        }
    }
}
