package app.sidey.server.auth.verifier;

public interface IdentityVerifier {
    VerifiedIdentity verify(String provider, String credential, String nonce);
    record VerifiedIdentity(String provider, String subject) {}
}
