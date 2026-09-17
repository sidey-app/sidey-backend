package app.sidey.server.message;

import app.sidey.server.common.ScopedLocks;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Concurrent sends share a lease. A recovery watermark waits for their commits. */
@Component
public final class RecoveryBoundary {
    private final ScopedLocks locks=new ScopedLocks();
    public <T> T sending(UUID room,Supplier<T> transaction){
        var lease=locks.acquire(room.toString(),false);
        if(TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization(){
                @Override public void afterCompletion(int status){lease.close();}
            });
            return transaction.get();
        }
        try(lease){return transaction.get();}
    }
    public <T> T checkpoint(UUID room,Supplier<T> snapshot){try(var lease=locks.acquire(room.toString(),true)){return snapshot.get();}}
    public int size(){return locks.size();}
}
