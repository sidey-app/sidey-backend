package app.sidey.server;

import app.sidey.server.common.CoordinationLocks;
import app.sidey.server.room.RoomMembershipBoundary;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class BoundaryTest {
    @Test void queuedReferencesDoNotSplitLockAndAreReleased() throws Exception {
        var locks=new CoordinationLocks();var count=new AtomicInteger();var active=new AtomicInteger();
        try(var pool=Executors.newFixedThreadPool(12)) {
            var tasks=new java.util.ArrayList<Future<?>>();
            for(int i=0;i<1000;i++) tasks.add(pool.submit(()->locks.with("same",()->{
                assertEquals(1,active.incrementAndGet());count.incrementAndGet();active.decrementAndGet();return null;
            })));
            for(var task:tasks) task.get(10,TimeUnit.SECONDS);
        }
        assertEquals(1000,count.get());assertEquals(0,locks.size());
    }
    @Test void commitUpdateFailureAndUncertainTransactionOutcomeBothInvalidate() {
        var boundary=new RoomMembershipBoundary();UUID id=UUID.randomUUID();var invalid=new AtomicInteger();
        boundary.observe(new RoomMembershipBoundary.Observer(){
            public void committed(UUID room){throw new IllegalStateException("simulated_update_failure");}
            public void invalidate(UUID room){invalid.incrementAndGet();}
        });
        assertEquals("committed",boundary.mutate(id,()->"committed"));assertEquals(1,invalid.get());
        assertThrows(IllegalStateException.class,()->boundary.mutate(id,()->{throw new IllegalStateException("rollback");}));
        assertEquals(2,invalid.get());assertEquals(0,boundary.lockCount());
    }
}
