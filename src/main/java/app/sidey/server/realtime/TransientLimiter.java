package app.sidey.server.realtime;

import app.sidey.server.common.ApiException;
import java.time.Clock;
import java.util.*;
import org.springframework.stereotype.Component;

/** Per-user windows survive socket reconnect; all state is bounded and disposable. */
@Component
public class TransientLimiter {
    private record Key(UUID user,String kind) {}
    // Ordered by the last accepted event. Only an expired prefix needs eviction.
    private final LinkedHashMap<Key,ArrayDeque<Long>> windows=new LinkedHashMap<>();
    private final Clock clock;
    private long observedTime=Long.MIN_VALUE;
    public TransientLimiter(Clock clock){this.clock=clock;}
    public synchronized void take(UUID user,String kind,int limit){
        long now=Math.max(clock.millis(),observedTime),cutoff=now-10_000;
        observedTime=now; // A backwards wall-clock correction cannot reopen a window.
        var expired=windows.values().iterator();
        while(expired.hasNext()){
            if(expired.next().peekLast()>cutoff)break;
            expired.remove();
        }
        Key key=new Key(user,kind);
        if(!windows.containsKey(key) && windows.size()>=20_000)throw new ApiException(429,"transient_capacity");
        var window=windows.computeIfAbsent(key,k->new ArrayDeque<>());
        while(!window.isEmpty() && window.peekFirst()<=cutoff)window.removeFirst();
        if(window.size()>=limit)throw new ApiException(429,"transient_rate_limited");
        window.addLast(now);
        windows.putLast(key,window);
    }
}
