package app.sidey.server.auth.verifier;

import app.sidey.server.common.ApiException;
import java.net.URI;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/** Transitional outbound credential proof; never trusts a UUID supplied by the caller. */
@Component
public final class SupabaseLegacyCredentialVerifier implements LegacyCredentialVerifier {
    private final URI endpoint;
    private final String apiKey;
    private final RestClient client;

    @org.springframework.beans.factory.annotation.Autowired
    public SupabaseLegacyCredentialVerifier(
            @Value("${sidey.auth.legacy-supabase-origin:}") String origin,
            @Value("${sidey.auth.legacy-supabase-api-key:}") String apiKey) {
        this.apiKey = apiKey;
        endpoint = endpoint(origin);
        var http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5))
                .followRedirects(HttpClient.Redirect.NEVER).build();
        var factory = new JdkClientHttpRequestFactory(http);
        factory.setReadTimeout(Duration.ofSeconds(5));
        client = RestClient.builder().requestFactory(factory).build();
    }

    SupabaseLegacyCredentialVerifier(URI endpoint, String apiKey, RestClient client) {
        this.endpoint = endpoint;
        this.apiKey = apiKey;
        this.client = client;
    }

    static URI endpoint(String origin) {
        if (origin == null || origin.isBlank()) return null;
        URI uri = URI.create(origin);
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null
                || !uri.getHost().endsWith(".supabase.co") || uri.getUserInfo() != null
                || (uri.getPort() != -1 && uri.getPort() != 443) || uri.getQuery() != null
                || uri.getFragment() != null || !(uri.getPath().isEmpty() || "/".equals(uri.getPath())))
            throw new IllegalArgumentException("Legacy Supabase origin must be a configured HTTPS project origin");
        return uri.resolve("/auth/v1/user");
    }

    @Override public UUID verify(String accessToken) {
        if (endpoint == null || apiKey == null || apiKey.isBlank())
            throw new ApiException(401, "legacy_credential_verification_unavailable");
        if (accessToken == null || accessToken.length() < 40 || accessToken.length() > 16384
                || accessToken.chars().anyMatch(Character::isWhitespace)) throw invalid();
        try {
            Map<?, ?> response = client.get().uri(endpoint)
                    .header("Authorization", "Bearer " + accessToken).header("apikey", apiKey)
                    .retrieve().body(Map.class);
            if (response == null || !(response.get("id") instanceof String id)) throw invalid();
            UUID uuid = UUID.fromString(id);
            if (!uuid.toString().equalsIgnoreCase(id)) throw invalid();
            return uuid;
        } catch (RuntimeException exception) { throw invalid(); }
    }
    private static ApiException invalid() { return new ApiException(401, "invalid_legacy_credential"); }
}
