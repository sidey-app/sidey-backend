package app.sidey.server.common;

import app.sidey.server.realtime.ConnectionRegistry;
import app.sidey.server.realtime.MembershipRegistry;
import jakarta.annotation.PreDestroy;
import jakarta.servlet.http.HttpServletRequest;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/internal/deployment")
public class DeploymentController {
    private final ServingState state;
    private final ConnectionRegistry connections;
    private final MembershipRegistry members;
    private final String key;
    public DeploymentController(ServingState state, ConnectionRegistry connections, MembershipRegistry members,
            @Value("${sidey.deployment.key:}") String key) {
        this.state = state; this.connections = connections; this.members = members; this.key = key;
    }
    private void authorize(HttpServletRequest request) {
        String supplied = request.getHeader("X-Sidey-Deployment-Key");
        if (!ManagementListener.loopback(request.getRemoteAddr()) || key.length() < 32 || supplied == null
                || !MessageDigest.isEqual(Crypto.hash(key), Crypto.hash(supplied)))
            throw new ApiException(401, "deployment_authentication_required");
    }
    private Map<String, Object> snapshot() {
        return Map.of("accepting", state.accepting(), "inFlight", state.inFlight(), "connections", connections.size());
    }
    @GetMapping("/status") public synchronized Object status(HttpServletRequest request) {
        authorize(request); return snapshot();
    }
    @PostMapping("/activate") public synchronized Object activate(HttpServletRequest request) {
        authorize(request);
        if (!state.accepting()) {
            if (state.inFlight() != 0) throw new ApiException(409, "deployment_not_quiescent");
            // The other JVM may have changed membership while this process was inactive.
            members.invalidateAll();
            state.activate();
        }
        return snapshot();
    }
    @PostMapping("/drain") public synchronized Object drain(HttpServletRequest request) throws InterruptedException {
        authorize(request); quiesce(); return snapshot();
    }
    private void quiesce() throws InterruptedException {
        state.stopAccepting();
        connections.closeAll(1012, "server_restarting");
        if (!state.awaitQuiescence(Duration.ofSeconds(30))) throw new ApiException(409, "deployment_drain_pending");
        // A handshake already admitted before the first close may finish during drain.
        connections.closeAll(1012, "server_restarting");
    }
    @PreDestroy public void shutdown() {
        try { quiesce(); }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        catch (ApiException pending) { /* Process termination forces reconnect; committed state is in PostgreSQL. */ }
    }
}
