package app.sidey.server.auth;

import app.sidey.server.common.*;
import java.time.*;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

@Component
public class AuthChallenges {
    private final ConcurrentHashMap<String,Instant> pending=new ConcurrentHashMap<>();
    private final Clock clock;
    public AuthChallenges(Clock clock){this.clock=clock;}
    public synchronized String create() {
        Instant now=clock.instant();pending.entrySet().removeIf(e -> !now.isBefore(e.getValue()));
        if(pending.size()>=10000) throw new ApiException(429,"auth_challenge_capacity");
        String value=Crypto.token();pending.put(value,now.plus(Duration.ofMinutes(5)));return value;
    }
    public void consume(String value) {
        Instant expiry=value==null?null:pending.remove(value);
        if(expiry==null || !clock.instant().isBefore(expiry)) throw new ApiException(401,"auth_challenge_invalid");
    }
}
