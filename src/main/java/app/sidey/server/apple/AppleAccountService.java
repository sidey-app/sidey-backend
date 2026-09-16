package app.sidey.server.apple;

import app.sidey.server.auth.verifier.IdentityVerifier;
import app.sidey.server.common.ApiException;
import app.sidey.server.user.UserService;
import java.util.*;
import org.jooq.DSLContext;
import org.springframework.stereotype.Service;

@Service
public class AppleAccountService {
    private final DSLContext db;private final IdentityVerifier identities;private final AppleAuthorization authorization;private final UserService users;
    public AppleAccountService(DSLContext db,IdentityVerifier identities,AppleAuthorization authorization,UserService users){this.db=db;this.identities=identities;this.authorization=authorization;this.users=users;}
    public Map<String,Boolean> delete(UUID user,String credential,String nonce,String code){
        var proof=identities.verify("APPLE",credential,nonce);var identity=db.fetchOne("select provider_subject from user_identities where user_id=? and provider='APPLE'",user);
        if(identity==null || !proof.subject().equals(identity.get(0)))throw new ApiException(403,"apple_identity_mismatch");
        boolean revoked=authorization.revoke(code,proof.subject());users.delete(user);return Map.of("deleted",true,"appleCredentialRevoked",revoked);
    }
}
