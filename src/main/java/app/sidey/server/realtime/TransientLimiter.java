package app.sidey.server.realtime;

import app.sidey.server.common.ApiException;
import java.time.Clock;
import java.util.*;
import org.springframework.stereotype.Component;

/** Per-user windows survive socket reconnect; all state is bounded and disposable. */
@Component
public class TransientLimiter {
    private record Key(UUID user,String kind) {}
    private final Map<Key,ArrayDeque<Long>> windows=new HashMap<>();
    private final Clock clock;
    public TransientLimiter(Clock clock){this.clock=clock;}
    public synchronized void take(UUID user,String kind,int limit){
        long now=clock.millis(),cutoff=now-10_000;
        windows.values().forEach(q->{while(!q.isEmpty() && q.peekFirst()<=cutoff)q.removeFirst();});
        windows.values().removeIf(ArrayDeque::isEmpty);
        Key key=new Key(user,kind);
        if(!windows.containsKey(key) && windows.size()>=20_000)throw new ApiException(429,"transient_capacity");
        var window=windows.computeIfAbsent(key,k->new ArrayDeque<>());
        if(window.size()>=limit)throw new ApiException(429,"transient_rate_limited");
        window.addLast(now);
    }
}
