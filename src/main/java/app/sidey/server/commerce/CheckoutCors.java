package app.sidey.server.commerce;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.*;

@Configuration
public class CheckoutCors implements WebMvcConfigurer {
    private final String origin;
    public CheckoutCors(@Value("${sidey.commerce.web-origin:https://sidey-app.github.io}")String origin){this.origin=origin;}
    @Override public void addCorsMappings(CorsRegistry registry){registry.addMapping("/api/commerce/**").allowedOrigins(origin).allowedMethods("GET","POST","OPTIONS").allowedHeaders("Authorization","Content-Type").maxAge(600);}
}
