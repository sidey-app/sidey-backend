package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;
import app.sidey.server.auth.AuthService;
import app.sidey.server.auth.SessionEvents;
import app.sidey.server.common.CoordinationLocks;
import app.sidey.server.common.Transactions;
import app.sidey.server.room.RoomMembershipBoundary;
import app.sidey.server.user.UserService;
import java.time.Clock;
import java.util.ArrayList;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.context.ApplicationEventPublisher;

class UserDeletionTest extends PostgresTest {
    private UUID account() {
        UUID id=UUID.randomUUID();
        tx.executeWithoutResult(status->{
            db.execute("insert into users(id,status) values (?,'ACTIVE')",id);
            db.execute("insert into user_identities(user_id,provider,provider_subject) values (?,'GOOGLE',?)",id,id.toString());
            db.execute("insert into profiles(id,nickname) values (?,'tester')",id);
        });
        return id;
    }
    @Test void transfersOwnersAndPreservesAnonymizedPurchaseProvenance() {
        UUID owner=account(), first=account(), later=account(), room=UUID.randomUUID(), empty=UUID.randomUUID();
        UUID session=UUID.randomUUID(),order=UUID.randomUUID(),grant=UUID.randomUUID(),included=UUID.randomUUID();
        tx.executeWithoutResult(status->{
            db.execute("insert into rooms(id,name,owner_id) values (?,'shared',?),(?,'empty',?)",room,owner,empty,owner);
            db.execute("insert into room_members(room_id,user_id,joined_at) values (?, ?,now()-interval '3 days'),"
                    +"(?,?,now()-interval '2 days'),(?,?,now()-interval '1 day'),(?,?,now())",room,owner,room,first,room,later,empty,owner);
            db.execute("insert into messages(id,room_id,sender_id,body) values (?, ?,?,'hello')",UUID.randomUUID(),room,owner);
            db.execute("insert into user_sessions(id,user_id,refresh_token_hash,created_at,last_refreshed_at,expires_at,absolute_expires_at,device_platform) "
                    +"values (?,?,decode(repeat('a',64),'hex'),now(),now(),now()+interval '1 day',now()+interval '2 days','MACOS')",session,owner);
            db.execute("insert into commerce_orders(id,user_id,product_id,price_id,provider_order_id,amount_krw,currency,payment_environment,status,checkout_token_hash,checkout_token_expires_at,"
                    +"policy_version,policy_notice,policy_consented_at) select ?,?,'character_guinea_pig',id,?,1100,'KRW','test','approved',"
                    +"decode(repeat('b',64),'hex'),now()+interval '15 minutes','policy',repeat('x',80),now() from commerce_prices where product_id='character_guinea_pig' and active",order,owner,order.toString());
            db.execute("insert into commerce_grants(id,user_id,entitlement_key,source_kind,source_reference,status,included_entitlement_key) "
                    +"values (?,?,'character:pixel_guinea_pig','portone',?,'active','throwable:throwable_mini_paprika')",grant,owner,"order:"+order);
            db.execute("insert into commerce_grants(id,user_id,entitlement_key,source_kind,source_reference,status,parent_grant_id) "
                    +"values (?,?,'throwable:throwable_mini_paprika','complimentary',?,'active',?)",included,owner,"included:"+grant,grant);
            db.execute("insert into commerce_entitlements(user_id,entitlement_key,status,granted_at) values (?,'character:pixel_guinea_pig','active',now())",owner);
            db.execute("insert into app_store_transactions(environment,transaction_id,original_transaction_id,product_id,store_product_id,user_id,app_account_token,status,binding_state,purchased_at,signed_at,signed_data_sha256) "
                    +"values ('Sandbox',?,?,'character_guinea_pig','character_guinea_pig',?,?,'active','bound',now(),now(),decode(repeat('c',64),'hex'))",order.toString(),order.toString(),owner,owner);
        });
        var events=new ArrayList<Object>();
        ApplicationEventPublisher publisher=events::add;
        var transactions=new Transactions(tx);
        var coordination=new CoordinationLocks();
        var boundary=new RoomMembershipBoundary();
        var auth=new AuthService(db,transactions,null,null,null,Clock.systemUTC(),publisher);
        new UserService(db,transactions,coordination,boundary,auth,publisher).delete(owner);
        assertEquals(first,db.fetchOne("select owner_id from rooms where id=?",room).get(0,UUID.class));
        assertNull(db.fetchOne("select 1 from rooms where id=?",empty));
        assertNull(db.fetchOne("select 1 from users where id=?",owner));
        assertNull(db.fetchOne("select 1 from profiles where id=?",owner));
        assertNull(db.fetchOne("select 1 from user_sessions where id=?",session));
        assertNull(db.fetchOne("select 1 from messages where sender_id=?",owner));
        assertNull(db.fetchOne("select user_id from commerce_orders where id=?",order).get(0));
        for(UUID id:new UUID[]{grant,included}) {
            var row=db.fetchOne("select * from commerce_grants where id=?",id);
            assertNull(row.get("user_id")); assertEquals("revoked",row.get("status"));assertNotNull(row.get("revoked_at"));
        }
        assertEquals(grant,db.fetchOne("select parent_grant_id from commerce_grants where id=?",included).get(0,UUID.class));
        assertEquals("order:"+order,db.fetchOne("select source_reference from commerce_grants where id=?",grant).get(0));
        var apple=db.fetchOne("select * from app_store_transactions where environment='Sandbox' and transaction_id=?",order.toString());
        assertNull(apple.get("user_id")); assertEquals("unbound",apple.get("binding_state"));
        assertEquals("active",apple.get("status")); assertEquals(owner,apple.get("app_account_token",UUID.class));
        assertTrue(events.contains(new SessionEvents(session,owner)));
    }
}
