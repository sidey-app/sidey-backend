package app.sidey.server.common;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.Lock;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/** Reference-counted lock leases: queued callers hold a reference too. */
public final class ScopedLocks {
    private static final class Entry {
        final ReentrantReadWriteLock lock = new ReentrantReadWriteLock(true);
        int references;
    }
    private final ConcurrentHashMap<String, Entry> entries = new ConcurrentHashMap<>();
    public Lease acquire(String key, boolean write) {
        Entry entry = entries.compute(key, (k, old) -> {
            Entry result = old == null ? new Entry() : old;
            result.references++;
            return result;
        });
        Lock lock = write ? entry.lock.writeLock() : entry.lock.readLock();
        lock.lock();
        return new Lease(key, entry, lock);
    }
    public int size() { return entries.size(); }
    public final class Lease implements AutoCloseable {
        private final String key;
        private final Entry entry;
        private final Lock lock;
        private boolean closed;
        private Lease(String key, Entry entry, Lock lock) { this.key=key; this.entry=entry; this.lock=lock; }
        @Override public void close() {
            if (closed) return;
            closed=true;
            lock.unlock();
            entries.compute(key, (k, existing) -> {
                if (existing != entry) throw new IllegalStateException("lock_lease_mismatch");
                return --entry.references == 0 ? null : entry;
            });
        }
    }
}
