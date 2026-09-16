package app.sidey.server.common;

import java.util.function.Supplier;
import org.springframework.stereotype.Component;

@Component
public final class CoordinationLocks {
    private final ScopedLocks locks = new ScopedLocks();
    public <T> T with(String key, Supplier<T> body) {
        try (var lease=locks.acquire(key,true)) { return body.get(); }
    }
    public int size() { return locks.size(); }
}
