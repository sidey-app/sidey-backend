package app.sidey.server.auth.verifier;

import app.sidey.server.common.ApiException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.stereotype.Component;

@Component
public final class ProductionIdentityVerifier implements IdentityVerifier {
    private final Map<String, JwtDecoder> decoders;

    @org.springframework.beans.factory.annotation.Autowired
    public ProductionIdentityVerifier(
            @Value("${sidey.auth.google-audiences:}") String googleAudiences,
            @Value("${sidey.auth.apple-audiences:}") String appleAudiences) {
        var configured = new java.util.HashMap<String, JwtDecoder>();
        configure(configured, "GOOGLE", googleAudiences, "https://www.googleapis.com/oauth2/v3/certs", "https://accounts.google.com");
        configure(configured, "APPLE", appleAudiences, "https://appleid.apple.com/auth/keys", "https://appleid.apple.com");
        decoders = Map.copyOf(configured);
    }

    // Decoder injection is package-private and used only by deterministic signature tests.
    ProductionIdentityVerifier(Map<String, JwtDecoder> decoders) { this.decoders = Map.copyOf(decoders); }

    private static void configure(Map<String, JwtDecoder> target, String provider, String rawAudiences,
            String jwks, String issuer) {
        Set<String> audiences = Arrays.stream(rawAudiences.split(",")).map(String::trim)
                .filter(value -> !value.isEmpty()).collect(Collectors.toUnmodifiableSet());
        if (audiences.isEmpty()) return;
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withJwkSetUri(jwks).build();
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(
                JwtValidators.createDefaultWithIssuer(issuer), audienceValidator(audiences)));
        target.put(provider, decoder);
    }

    static OAuth2TokenValidator<Jwt> audienceValidator(Set<String> accepted) {
        return jwt -> jwt.getAudience().stream().anyMatch(accepted::contains)
                && (jwt.getClaimAsString("azp") == null ? jwt.getAudience().size() <= 1
                    : accepted.contains(jwt.getClaimAsString("azp")))
                ? OAuth2TokenValidatorResult.success()
                : OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", "Invalid audience", null));
    }

    @Override public VerifiedIdentity verify(String provider, String credential, String nonce) {
        JwtDecoder decoder = provider == null ? null : decoders.get(provider);
        if (decoder == null) throw new ApiException(401, "identity_provider_unavailable");
        if (credential == null || credential.length() > 32768 || nonce == null
                || nonce.length() < 16 || nonce.length() > 256) throw invalid();
        try {
            Jwt jwt = decoder.decode(credential);
            String expected = "APPLE".equals(provider) ? sha256(nonce) : nonce;
            String actual = jwt.getClaimAsString("nonce");
            String subject = jwt.getSubject();
            Instant now = Instant.now();
            if (subject == null || subject.isBlank() || subject.length() > 255
                    || jwt.getExpiresAt() == null || !jwt.getExpiresAt().isAfter(now)
                    || jwt.getIssuedAt() == null || jwt.getIssuedAt().isBefore(now.minusSeconds(300))
                    || jwt.getIssuedAt().isAfter(now.plusSeconds(30))
                    || actual == null || !MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                            actual.getBytes(StandardCharsets.UTF_8))) throw invalid();
            return new VerifiedIdentity(provider, subject);
        } catch (ApiException exception) { throw exception;
        } catch (RuntimeException exception) { throw invalid(); }
    }

    private static String sha256(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException exception) { throw new IllegalStateException(exception); }
    }
    private static ApiException invalid() { return new ApiException(401, "invalid_identity_credential"); }
}
