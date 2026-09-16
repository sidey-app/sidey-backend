package app.sidey.server.common;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
public class BaseSecurity {
    @Bean
    SecurityFilterChain security(HttpSecurity http, app.sidey.server.auth.AuthService auth) throws Exception {
        return http.csrf(csrf -> csrf.disable())
                .cors(org.springframework.security.config.Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(a -> a.requestMatchers("/actuator/health/**",
                        "/api/auth/challenge","/api/auth/login","/api/auth/legacy-claim","/api/auth/refresh",
                        "/api/commerce/checkout","/api/commerce/complete","/api/commerce/portone/webhook","/internal/commerce/refund").permitAll()
                        .requestMatchers("/actuator/**").denyAll().anyRequest().authenticated())
                .oauth2ResourceServer(o -> o.jwt(org.springframework.security.config.Customizer.withDefaults()))
                .addFilterAfter(new app.sidey.server.auth.SessionAuthorizationFilter(auth),
                        org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter.class).build();
    }
}
