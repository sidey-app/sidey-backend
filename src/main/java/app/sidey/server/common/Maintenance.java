package app.sidey.server.common;

import app.sidey.server.auth.AuthService;
import app.sidey.server.message.Retention;
import app.sidey.server.realtime.PresenceService;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** An inactive deployment must not revoke sessions owned by the active JVM. */
@Component
public class Maintenance {
    private final ServingState state;
    private final AuthService auth;
    private final Retention retention;
    private final PresenceService presence;
    public Maintenance(ServingState state, AuthService auth, Retention retention, PresenceService presence) {
        this.state = state; this.auth = auth; this.retention = retention; this.presence = presence;
    }
    @Scheduled(fixedDelay = 60000, initialDelay = 60000)
    public void durable() {
        try (var lease = state.enter()) {
            if (lease != null) { auth.expireSessions(); retention.prune(); }
        }
    }
    @Scheduled(fixedDelay = 1000)
    public void presence() {
        try (var lease = state.enter()) { if (lease != null) presence.tick(); }
    }
}
