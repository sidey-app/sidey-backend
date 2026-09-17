package app.sidey.server.realtime;

import app.sidey.server.auth.AuthService;
import app.sidey.server.common.ApiException;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

@Component
public final class WsHandshake implements HandshakeInterceptor {
    public static final String USER_ID="sidey.userId";
    public static final String SESSION_ID="sidey.sessionId";
    private final AuthService auth;
    public WsHandshake(AuthService auth){this.auth=auth;}
    @Override public boolean beforeHandshake(ServerHttpRequest request,ServerHttpResponse response,WebSocketHandler handler,Map<String,Object> attributes){
        if(!(request.getPrincipal() instanceof JwtAuthenticationToken principal) || !principal.isAuthenticated())return rejected(response);
        try {
            UUID user=UUID.fromString(principal.getToken().getSubject());
            UUID sid=UUID.fromString(principal.getToken().getClaimAsString("sid"));
            auth.authorize(user,sid);
            attributes.put(USER_ID,user);attributes.put(SESSION_ID,sid);
            return true;
        } catch(ApiException|IllegalArgumentException|NullPointerException rejected){return rejected(response);}
    }
    private boolean rejected(ServerHttpResponse response){response.setStatusCode(HttpStatus.UNAUTHORIZED);return false;}
    @Override public void afterHandshake(ServerHttpRequest request,ServerHttpResponse response,WebSocketHandler handler,Exception exception) {}
}
