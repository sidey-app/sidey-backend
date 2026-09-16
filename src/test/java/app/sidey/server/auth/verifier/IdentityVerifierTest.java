package app.sidey.server.auth.verifier;

import static org.junit.jupiter.api.Assertions.*;
import app.sidey.server.common.ApiException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import java.time.Instant;
import java.util.Date;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;

class IdentityVerifierTest {
    private static final String NONCE="server-challenge-at-least-16";
    private final RSAKey key;
    IdentityVerifierTest() throws Exception { key=new RSAKeyGenerator(2048).generate(); }

    private ProductionIdentityVerifier verifier() throws Exception {
        var decoder=NimbusJwtDecoder.withPublicKey(key.toRSAPublicKey()).build();
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(
                JwtValidators.createDefaultWithIssuer("https://accounts.google.com"),
                ProductionIdentityVerifier.audienceValidator(Set.of("client-id"))));
        return new ProductionIdentityVerifier(Map.of("GOOGLE",decoder));
    }
    private String token(String issuer,String audience,String nonce,long expiryOffset,RSAKey signer) throws Exception {
        var claims=new JWTClaimsSet.Builder().issuer(issuer).audience(audience).subject("provider-subject")
                .issueTime(new Date()).expirationTime(Date.from(Instant.now().plusSeconds(expiryOffset)))
                .claim("nonce",nonce).build();
        var token=new SignedJWT(new JWSHeader(JWSAlgorithm.RS256),claims);
        token.sign(new RSASSASigner(signer)); return token.serialize();
    }
    @Test void validatesSignatureAndBoundClaims() throws Exception {
        var verifier=verifier();
        assertEquals(new IdentityVerifier.VerifiedIdentity("GOOGLE","provider-subject"),verifier.verify("GOOGLE",
                token("https://accounts.google.com","client-id",NONCE,120,key),NONCE));
        assertThrows(ApiException.class,()->verifier.verify("GOOGLE",
                token("https://attacker.invalid","client-id",NONCE,120,key),NONCE));
        assertThrows(ApiException.class,()->verifier.verify("GOOGLE",
                token("https://accounts.google.com","other-client",NONCE,120,key),NONCE));
        assertThrows(ApiException.class,()->verifier.verify("GOOGLE",
                token("https://accounts.google.com","client-id","different-nonce",120,key),NONCE));
        assertThrows(ApiException.class,()->verifier.verify("GOOGLE",
                token("https://accounts.google.com","client-id",NONCE,-120,key),NONCE));
        RSAKey attacker=new RSAKeyGenerator(2048).generate();
        assertThrows(ApiException.class,()->verifier.verify("GOOGLE",
                token("https://accounts.google.com","client-id",NONCE,120,attacker),NONCE));
    }
    @Test void missingProductionConfigurationDisablesLogin() {
        var verifier=new ProductionIdentityVerifier("","");
        assertThrows(ApiException.class,()->verifier.verify("GOOGLE","anything",NONCE));
        assertThrows(ApiException.class,()->verifier.verify("APPLE","anything",NONCE));
    }
    @Test void rejectsStaleIssuedAtAndMissingExpiry() throws Exception {
        for (boolean stale : new boolean[]{true,false}) {
            var claims=new JWTClaimsSet.Builder().issuer("https://accounts.google.com").audience("client-id")
                    .subject("provider-subject").claim("nonce",NONCE)
                    .issueTime(Date.from(Instant.now().minusSeconds(stale ? 301 : 0)));
            if(stale) claims.expirationTime(Date.from(Instant.now().plusSeconds(120)));
            var jwt=new SignedJWT(new JWSHeader(JWSAlgorithm.RS256),claims.build());
            jwt.sign(new RSASSASigner(key));
            assertThrows(ApiException.class,()->verifier().verify("GOOGLE",jwt.serialize(),NONCE));
        }
    }
    @Test void appleRequiresHashedRawNonce() throws Exception {
        var decoder=NimbusJwtDecoder.withPublicKey(key.toRSAPublicKey()).build();
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(
                JwtValidators.createDefaultWithIssuer("https://appleid.apple.com"),
                ProductionIdentityVerifier.audienceValidator(Set.of("client-id"))));
        var verifier=new ProductionIdentityVerifier(Map.of("APPLE",decoder));
        String hashed=java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                .digest(NONCE.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        assertEquals("provider-subject",verifier.verify("APPLE",
                token("https://appleid.apple.com","client-id",hashed,120,key),NONCE).subject());
        assertThrows(ApiException.class,()->verifier.verify("APPLE",
                token("https://appleid.apple.com","client-id",NONCE,120,key),NONCE));
    }
}
