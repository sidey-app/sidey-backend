package app.sidey.server.auth.verifier;

import java.util.UUID;

public interface LegacyCredentialVerifier {
    UUID verify(String accessToken);
}
