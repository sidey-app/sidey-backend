package app.sidey.server;

import app.sidey.server.auth.*;
import app.sidey.server.auth.verifier.IdentityVerifier;
import app.sidey.server.common.*;
import app.sidey.server.message.MessageService;
import app.sidey.server.room.*;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Clock;
import java.util.*;
import org.jooq.DSLContext;
import org.springframework.transaction.support.TransactionTemplate;

final class CoreFixture {
    final DSLContext db;
    final Transactions tx;
    final AuthService auth;
    final RoomMembershipBoundary boundary=new RoomMembershipBoundary();
    final RoomService rooms;
    final MessageService messages;
    CoreFixture(DSLContext db,TransactionTemplate tx){
        this.db=db;this.tx=new Transactions(tx);
        String secret=Base64.getEncoder().encodeToString(Crypto.hash("test-key"));
        auth=new AuthService(db,this.tx,(provider,credential,nonce)->new IdentityVerifier.VerifiedIdentity(provider,credential),old->{throw new ApiException(401,"invalid_legacy");},new AccessTokens(secret,"sidey","sidey-api"),Clock.systemUTC(),e->{});
        rooms=new RoomService(db,this.tx,auth,new CoordinationLocks(),boundary,new InviteCodes(secret),e->{});
        messages=new MessageService(db,this.tx,auth,new SimpleMeterRegistry());
    }
    UUID user(){UUID id=UUID.randomUUID();tx.run(()->{
        db.execute("insert into users(id,status) values (?,'ACTIVE')",id);
        db.execute("insert into user_identities(user_id,provider,provider_subject) values (?,'GOOGLE',?)",id,id.toString());
        db.execute("insert into profiles(id,nickname) values (?,'친구')",id);return null;
    });return id;}
}
