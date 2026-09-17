package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;
import app.sidey.server.apple.*;
import app.sidey.server.auth.verifier.IdentityVerifier;
import app.sidey.server.common.*;
import app.sidey.server.user.*;
import org.junit.jupiter.api.Test;

class AppleAccountTest extends PostgresTest {
    @Test void freshLinkedIdentityIsRequiredAndProviderRevocationFailureDoesNotPreventDeletion(){
        var f=new CoreFixture(db,tx);var user=f.user();db.execute("insert into user_identities(user_id,provider,provider_subject) values (?,'APPLE',?)",user,"apple:"+user);
        var users=new UserService(db,f.tx,new CoordinationLocks(),f.boundary,f.auth,e->{});
        var accounts=new AppleAccountService(db,(provider,credential,nonce)->new IdentityVerifier.VerifiedIdentity(provider,credential),(code,subject)->false,users);
        assertThrows(ApiException.class,()->accounts.delete(user,"wrong-subject","nonce","code"));assertTrue(users.hasAppleIdentity(user));
        var result=accounts.delete(user,"apple:"+user,"nonce","code");assertTrue(result.get("deleted"));assertFalse(result.get("appleCredentialRevoked"));assertNull(db.fetchOne("select * from users where id=?",user));
    }
}
