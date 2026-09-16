package app.sidey.server.room;

import app.sidey.server.common.ScopedLocks;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Supplier;
import org.springframework.stereotype.Component;

/** A mutation supplier must return only after its PostgreSQL transaction commits. */
@Component
public final class RoomMembershipBoundary {
    public interface Observer {
        void committed(UUID roomId);
        void invalidate(UUID roomId);
    }
    private final ScopedLocks locks = new ScopedLocks();
    private final List<Observer> observers = new CopyOnWriteArrayList<>();
    public void observe(Observer observer) { observers.add(observer); }
    public <T> T read(UUID roomId, Supplier<T> snapshot) {
        try (var lease=locks.acquire(roomId.toString(),false)) { return snapshot.get(); }
    }
    public <T> T mutate(UUID roomId, Supplier<T> transaction) { return mutateAll(List.of(roomId),transaction); }
    public <T> T mutateAll(List<UUID> roomIds, Supplier<T> transaction) {
        List<UUID> ordered=roomIds.stream().distinct().sorted().toList();
        List<ScopedLocks.Lease> leases=new ArrayList<>();
        try {
            for(UUID id:ordered) leases.add(locks.acquire(id.toString(),true));
            T result=transaction.get();
            for(UUID id:ordered) for(Observer observer:observers) {
                try { observer.committed(id); }
                catch(RuntimeException failed) { observer.invalidate(id); }
            }
            return result;
        } finally {
            Collections.reverse(leases);
            for(var lease:leases) lease.close();
        }
    }
    public int lockCount() { return locks.size(); }
}
