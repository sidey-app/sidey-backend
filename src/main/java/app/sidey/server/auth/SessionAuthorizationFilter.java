package app.sidey.server.auth;

import app.sidey.server.common.ApiException;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.IOException;
import java.util.UUID;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.filter.OncePerRequestFilter;

public class SessionAuthorizationFilter extends OncePerRequestFilter {
    private final AuthService auth;
    public SessionAuthorizationFilter(AuthService auth){this.auth=auth;}
    @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain) throws ServletException,IOException {
        var authentication=SecurityContextHolder.getContext().getAuthentication();
        if(authentication instanceof JwtAuthenticationToken token) {
            try{auth.authorize(UUID.fromString(token.getToken().getSubject()),UUID.fromString(token.getToken().getClaimAsString("sid")));}
            catch(ApiException|IllegalArgumentException e){response.setStatus(401);response.setContentType("application/json");response.getWriter().write("{\"code\":\"session_rejected\"}");return;}
        }
        chain.doFilter(request,response);
    }
}
