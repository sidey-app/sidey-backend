package app.sidey.server.realtime;

import java.net.URI;
import java.util.Arrays;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.*;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

@Configuration
@EnableWebSocket
public class WebSocketConfiguration implements WebSocketConfigurer {
    private final RealtimeHandler handler;
    private final WsHandshake handshake;
    private final String[] origins;
    public WebSocketConfiguration(RealtimeHandler handler,WsHandshake handshake,@Value("${sidey.realtime.allowed-origins:}") String configuredOrigins){
        this.handler=handler;this.handshake=handshake;
        origins=Arrays.stream(configuredOrigins.split(",")).map(String::strip).filter(s->!s.isEmpty()).toArray(String[]::new);
        for(String origin:origins){
            URI uri=URI.create(origin);
            if(origin.contains("*") || uri.getHost()==null || !"https".equals(uri.getScheme()) || uri.getUserInfo()!=null || uri.getQuery()!=null || uri.getFragment()!=null || (uri.getPath()!=null && !uri.getPath().isEmpty()))throw new IllegalArgumentException("realtime_origin_must_be_exact_https_origin");
        }
    }
    @Override public void registerWebSocketHandlers(WebSocketHandlerRegistry registry){registry.addHandler(handler,"/api/realtime").addInterceptors(handshake).setAllowedOrigins(origins);}
    @Bean ServletServerContainerFactoryBean webSocketContainer(){
        var container=new ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(16384);container.setMaxBinaryMessageBufferSize(16384);
        return container;
    }
}
