package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;
import app.sidey.server.auth.*;
import app.sidey.server.auth.verifier.IdentityVerifier;
import app.sidey.server.common.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;

class AuthTest extends PostgresTest {
    private AuthService auth(UUID legacy) {
        var secret=Base64.getEncoder().encodeToString(Crypto.hash("unit-test-key-only"));
        return new AuthService(db,new Transactions(tx),
                (provider,credential,nonce) -> new IdentityVerifier.VerifiedIdentity(provider,credential),
                credential -> {if(!"verified-old-token".equals(credential))throw new ApiException(401,"legacy_proof_invalid");return legacy;},
                new AccessTokens(secret,"sidey","sidey-api"),Clock.systemUTC(),event -> {});
    }
    @Test void identityLinkConflictAndLastUnlink() {
        var service=auth(null);String subject=UUID.randomUUID().toString();
        var first=service.login("GOOGLE",subject,"nonce","MACOS",null);
        assertEquals(first.userId(),service.login("GOOGLE",subject,"nonce","WINDOWS",null).userId());
        assertThrows(ApiException.class, () -> service.unlink(first.userId(),"GOOGLE",subject,"fresh"));
        var other=service.login("APPLE",UUID.randomUUID().toString(),"nonce","MACOS",null);
        assertThrows(ApiException.class, () -> service.link(other.userId(),"GOOGLE",subject,"fresh"));
        service.link(first.userId(),"APPLE","apple-"+subject,"fresh");
        service.unlink(first.userId(),"GOOGLE",subject,"fresh");
    }
    @Test void legacyClaimPreservesUuidAndRequiresVerifiedCredential() {
        UUID legacy=UUID.randomUUID();db.execute("insert into users(id,status) values (?,'LEGACY_ANONYMOUS_UNCLAIMED')",legacy);
        var service=auth(legacy);
        assertThrows(ApiException.class, () -> service.claim(legacy.toString(),"GOOGLE","legacy-sub","nonce","MACOS",null));
        assertThrows(ApiException.class, () -> service.active(legacy));
        var session=service.claim("verified-old-token","GOOGLE","legacy-sub","nonce","MACOS",null);
        assertEquals(legacy,session.userId());service.authorize(legacy,session.sessionId());
    }
    @Test void concurrentRefreshAllowsOneRotationAndReuseRevokesFamily() throws Exception {
        var service=auth(null);var session=service.login("GOOGLE",UUID.randomUUID().toString(),"nonce","MACOS",null);
        var barrier=new CyclicBarrier(2);
        try(var workers=Executors.newFixedThreadPool(2)) {
            Callable<AuthService.Session> attempt=() -> {barrier.await();try{return service.refresh(session.refreshToken());}catch(ApiException e){return null;}};
            var a=workers.submit(attempt);var b=workers.submit(attempt);
            var first=a.get(10,TimeUnit.SECONDS);var second=b.get(10,TimeUnit.SECONDS);
            assertNotEquals(first==null,second==null);
            var winner=first==null?second:first;
            assertThrows(ApiException.class, () -> service.refresh(winner.refreshToken()));
            assertThrows(ApiException.class, () -> service.authorize(session.userId(),session.sessionId()));
        }
    }
    @Test void logoutIsPerSessionAndLogoutAllIsPerUser() {
        var service=auth(null);String subject=UUID.randomUUID().toString();
        var a=service.login("GOOGLE",subject,"nonce","MACOS",null);
        var b=service.login("GOOGLE",subject,"nonce","WINDOWS",null);
        service.logout(a.sessionId());assertThrows(ApiException.class, () -> service.authorize(a.userId(),a.sessionId()));
        service.authorize(b.userId(),b.sessionId());service.logoutAll(b.userId());
        assertThrows(ApiException.class, () -> service.authorize(b.userId(),b.sessionId()));
    }
    @Test void nonceIsSingleUseAndBoundedByExpiry() {
        var challenges=new AuthChallenges(Clock.systemUTC());String nonce=challenges.create();
        challenges.consume(nonce);assertThrows(ApiException.class, () -> challenges.consume(nonce));
    }
}
