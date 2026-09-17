package app.sidey.server.common;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.IOException;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 1)
public class ServingFilter extends OncePerRequestFilter {
    private final ServingState state;
    public ServingFilter(ServingState state) { this.state = state; }
    @Override protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        return !(path.equals("/api") || path.startsWith("/api/") || path.startsWith("/internal/commerce/"));
    }
    @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        try (var lease = state.enter()) {
            if (lease == null) {
                response.setStatus(503);
                response.setHeader("Retry-After", "2");
                response.setHeader("Cache-Control", "no-store");
                response.setContentType("application/json");
                response.getWriter().write("{\"code\":\"server_restarting\"}");
                return;
            }
            chain.doFilter(request, response);
        }
    }
}
