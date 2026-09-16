package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;
import app.sidey.server.auth.*;
import app.sidey.server.common.*;
import app.sidey.server.profile.ProfileService;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;

class ProfileTest extends PostgresTest {
    private ProfileService service(){return new ProfileService(db,new Transactions(tx),new AuthService(db,new Transactions(tx),null,null,new AccessTokens(Base64.getEncoder().encodeToString(Crypto.hash("profile-test")),"sidey","api"),Clock.systemUTC(),event->{}),event->{});}
    private UUID user(){UUID id=UUID.randomUUID();tx.executeWithoutResult(s->{db.execute("insert into users(id,status) values (?,'ACTIVE')",id);db.execute("insert into user_identities(user_id,provider,provider_subject) values (?,'GOOGLE',?)",id,id.toString());});return id;}
    @Test void profileVisibilityAndPaidSelectionAreAuthoritative(){
        var profiles=service();UUID a=user(),b=user();profiles.save(a,"친구","pixel_cat");profiles.save(b,"다른친구","pixel_hamster");
        assertThrows(ApiException.class,()->profiles.get(a,b));
        UUID room=UUID.randomUUID();tx.executeWithoutResult(s->{db.execute("insert into rooms(id,name,owner_id) values (?,'room',?)",room,a);db.execute("insert into room_members(room_id,user_id) values (?,?),(?,?)",room,a,room,b);});
        assertEquals(b,profiles.get(a,b).id());
        assertThrows(ApiException.class,()->profiles.save(a,"친구","pixel_tree"));
        assertThrows(ApiException.class,()->profiles.save(a,"친구","pixel_unknown"));
        grant(a,"character:pixel_tree");assertEquals("pixel_tree",profiles.save(a,"친구","pixel_tree").characterId());
        assertThrows(ApiException.class,()->profiles.equipment(a,"throwable","throwable_timber"));
        grant(a,"throwable:throwable_timber");assertEquals("throwable_timber",profiles.equipment(a,"throwable","throwable_timber").equippedThrowableId());
        assertNull(profiles.equipment(a,"throwable",null).equippedThrowableId());
        assertThrows(ApiException.class,()->profiles.equipment(a,"bubble","bubble_bunny_pink"));
        grant(a,"bubble:bubble_bunny_pink");assertEquals("bubble_bunny_pink",profiles.equipment(a,"bubble","bubble_bunny_pink").equippedBubbleStyleId());
        var core=new CoreFixture(db,tx);UUID id=UUID.randomUUID();var message=core.messages.send(a,room,id,"snapshot");
        assertEquals("bubble_bunny_pink",message.bubbleStyleId());profiles.equipment(a,"bubble",null);
        assertEquals(message,core.messages.send(a,room,id,"snapshot"));
    }
    @Test void treeInitializationNoOpAndStaleWinner() throws Exception {
        var profiles=service();UUID user=user();profiles.save(user,"나무친구","pixel_hamster");
        assertEquals(1,profiles.tree(user,false,0).treeMovementRevision());
        assertEquals(1,profiles.tree(user,false,1).treeMovementRevision());
        assertFalse(profiles.tree(user,true,0).treeMovementPaused());
        var barrier=new CyclicBarrier(2);
        try(var pool=Executors.newFixedThreadPool(2)){
            Callable<ProfileService.Profile> change=()->{barrier.await();return profiles.tree(user,true,1);};
            var a=pool.submit(change);var b=pool.submit(change);
            assertEquals(2,a.get(10,TimeUnit.SECONDS).treeMovementRevision());assertEquals(2,b.get(10,TimeUnit.SECONDS).treeMovementRevision());
        }
        assertTrue(profiles.get(user,user).treeMovementPaused());
    }
    private void grant(UUID user,String key){db.execute("insert into commerce_entitlements(user_id,entitlement_key,status,granted_at) values (?,?,'active',now())",user,key);}
}
