package app.sidey.server.auth;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.*;
import com.nimbusds.jose.jwk.source.ImmutableSecret;

@Configuration
public class AccessTokens {
    private final JwtEncoder encoder;
    private final String issuer;
    private final String audience;
    private final SecretKeySpec key;
    public AccessTokens(@Value("${sidey.auth.jwt-secret}") String secret,
            @Value("${sidey.auth.issuer:sidey}") String issuer,
            @Value("${sidey.auth.audience:sidey-api}") String audience) {
        byte[] bytes = java.util.Base64.getDecoder().decode(secret);
        if (bytes.length < 32) throw new IllegalArgumentException("JWT key requires 256 bits");
        key = new SecretKeySpec(bytes, "HmacSHA256");
        encoder = new NimbusJwtEncoder(new ImmutableSecret<>(key));
        this.issuer=issuer; this.audience=audience;
    }
    public String issue(UUID user, UUID sid, Instant now) {
        var claims = JwtClaimsSet.builder().issuer(issuer).audience(List.of(audience))
                .subject(user.toString()).claim("sid",sid.toString()).issuedAt(now)
                .expiresAt(now.plus(Duration.ofMinutes(15))).build();
        return encoder.encode(JwtEncoderParameters.from(JwsHeader.with(MacAlgorithm.HS256).build(),claims)).getTokenValue();
    }
    @Bean
    JwtDecoder sideyJwtDecoder() {
        var decoder = NimbusJwtDecoder.withSecretKey(key).macAlgorithm(MacAlgorithm.HS256).build();
        decoder.setJwtValidator(new org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator<>(
                JwtValidators.createDefaultWithIssuer(issuer),
                new JwtClaimValidator<List<String>>("aud", value -> value != null && value.contains(audience))));
        return decoder;
    }
    @Bean Clock clock() { return Clock.systemUTC(); }
}
