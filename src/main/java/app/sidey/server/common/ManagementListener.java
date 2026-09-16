package app.sidey.server.common;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.boot.web.server.context.WebServerInitializedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

@Component
public class ManagementListener {
    private volatile int port = -1;
    @EventListener public void started(WebServerInitializedEvent event) {
        if ("management".equals(event.getApplicationContext().getServerNamespace())) port = event.getWebServer().getPort();
    }
    public boolean permits(HttpServletRequest request) {
        return port > 0 && request.getLocalPort() == port && loopback(request.getRemoteAddr());
    }
    static boolean loopback(String address) {
        return "127.0.0.1".equals(address) || "::1".equals(address) || "0:0:0:0:0:0:0:1".equals(address);
    }
}
