package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;
import app.sidey.server.apple.*;
import app.sidey.server.commerce.GrantLedger;
import app.sidey.server.common.*;
import app.sidey.server.user.UserService;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;

class AppStoreTest extends PostgresTest {
    static class Verifier implements AppleVerification {
        Transaction value;Notification notice;
        public Transaction device(String signed){if(!"verified".equals(signed))throw new ApiException(400,"invalid_apple_transaction");return value;}
        public Transaction lookup(String id,String environment){return value;}
        public Notification notification(String signed){return notice;}
    }
    class Setup {
        final CoreFixture f=new CoreFixture(db,tx);final UUID user=f.user();final Verifier apple=new Verifier();
        final AppStoreService service=new AppStoreService(db,f.tx,f.auth,apple,new GrantLedger(db,f.tx,e->{}));
        // Apple signedDate uses epoch milliseconds; nanoseconds round in PostgreSQL.
        final String id=UUID.randomUUID().toString();final Instant now=Instant.parse("2026-09-17T00:00:00.123Z");
        Setup(){apple.value=value("Sandbox",null,now,990000L,"KRW");}
        AppleVerification.Transaction value(String env,Instant revoked,Instant signed,Long price,String currency){return new AppleVerification.Transaction(id,id,"character_guinea_pig",user,env,now.minusSeconds(100),revoked,signed,"signed:"+env+":"+signed,price,currency);}
        String status(){return db.fetchOne("select status from commerce_entitlements where user_id=? and entitlement_key='character:pixel_guinea_pig'",user).get(0,String.class);}
    }
    @Test void sameTransactionConcurrentSubmitAndEnvironmentNamespacing()throws Exception{
        var s=new Setup();assertThrows(ApiException.class,()->s.service.submit(s.user,"forged"));
        try(var pool=Executors.newFixedThreadPool(8)){List<Future<AppStoreService.Result>> results=new ArrayList<>();for(int i=0;i<8;i++)results.add(pool.submit(()->s.service.submit(s.user,"verified")));for(var result:results)assertEquals("active",result.get(10,TimeUnit.SECONDS).entitlementStatus());}
        assertEquals(1,db.fetchOne("select count(*) from app_store_transactions where transaction_id=?",s.id).get(0,Integer.class));
        assertEquals(2,db.fetchOne("select count(*) from commerce_grants where user_id=?",s.user).get(0,Integer.class));
        s.apple.value=s.value("Production",null,s.now,990000L,"KRW");s.service.submit(s.user,"verified");
        assertEquals(2,db.fetchOne("select count(*) from app_store_transactions where transaction_id=?",s.id).get(0,Integer.class));
    }
    @Test void bindingRejectsDifferentUserAndMismatchedInitialAccountToken(){
        var s=new Setup();UUID other=s.f.user();
        assertEquals("app_account_token_mismatch",assertThrows(ApiException.class,()->s.service.submit(other,"verified")).code());
        s.service.submit(s.user,"verified");assertEquals("apple_transaction_already_bound",assertThrows(ApiException.class,()->s.service.submit(other,"verified")).code());
        var original=s.apple.value;s.apple.value=new AppleVerification.Transaction(s.id,s.id,"character_tree",s.user,"Sandbox",original.purchasedAt(),null,original.signedAt(),"other",null,null);
        assertEquals("apple_transaction_product_mismatch",assertThrows(ApiException.class,()->s.service.submit(s.user,"verified")).code());
    }
    @Test void refundIgnoresOlderSignedStateAndPreservesKnownMoneyAndOtherGrant(){
        var s=new Setup();s.service.submit(s.user,"verified");
        s.apple.value=s.value("Sandbox",s.now.plusSeconds(1),s.now.plusSeconds(2),null,null);s.service.submit(s.user,"verified");assertEquals("refunded",s.status());
        s.apple.value=s.value("Sandbox",null,s.now,1L,"USD");assertEquals("refunded",s.service.submit(s.user,"verified").entitlementStatus());
        var row=db.fetchOne("select * from app_store_transactions where transaction_id=?",s.id);assertEquals(990000L,row.get("price_milliunits",Long.class));assertEquals("KRW",row.get("currency"));
        assertEquals("refunded",db.fetchOne("select status from commerce_entitlements where user_id=? and entitlement_key='throwable:throwable_mini_paprika'",s.user).get(0));
    }
    @Test void deletedAccountCanRestoreToNewUuidWithoutChangingOriginalBindingToken(){
        var s=new Setup();s.service.submit(s.user,"verified");
        var users=new UserService(db,s.f.tx,new CoordinationLocks(),s.f.boundary,s.f.auth,e->{});users.delete(s.user);
        UUID restored=s.f.user();s.apple.value=s.value("Sandbox",null,s.now.plusSeconds(10),null,null);assertEquals("bound",s.service.submit(restored,"verified").bindingState());
        var row=db.fetchOne("select * from app_store_transactions where transaction_id=?",s.id);assertEquals(restored,row.get("user_id"));assertEquals(s.user,row.get("app_account_token"));
        assertEquals(2,db.fetchOne("select count(*) from commerce_grants where user_id=? and status='active'",restored).get(0,Integer.class));
    }
    @Test void notificationFirstDoesNotGrantAndAuditConflictRollsBack(){
        var s=new Setup();UUID event=UUID.randomUUID();s.apple.notice=new AppleVerification.Notification(event,"ONE_TIME_CHARGE","Sandbox",s.now,s.apple.value,"verified-notification");
        assertTrue(s.service.notification("verified"));assertFalse(s.service.notification("verified"));assertEquals(0,db.fetchOne("select count(*) from commerce_grants where user_id=?",s.user).get(0,Integer.class));
        assertEquals("unbound",db.fetchOne("select binding_state from app_store_transactions where transaction_id=?",s.id).get(0));
        assertEquals("bound",s.service.submit(s.user,"verified").bindingState());
        s.apple.notice=new AppleVerification.Notification(event,"REFUND","Sandbox",s.now.plusSeconds(5),s.value("Sandbox",s.now,s.now.plusSeconds(5),null,null),"different-signed-body");
        assertEquals("apple_notification_conflict",assertThrows(ApiException.class,()->s.service.notification("verified")).code());assertEquals("active",s.status());
    }
    @Test void historicalMoneyBackfillCannotOverwriteNewerRevocation(){
        var s=new Setup();s.apple.value=s.value("Sandbox",s.now,s.now.plusSeconds(5),null,null);s.service.submit(s.user,"verified");
        s.apple.value=s.value("Sandbox",null,s.now,0L,"USD");assertTrue(s.service.backfillPrices("Sandbox",100)>=1);
        var row=db.fetchOne("select * from app_store_transactions where transaction_id=?",s.id);assertEquals("refunded",row.get("status"));assertEquals(0L,row.get("price_milliunits",Long.class));assertEquals("USD",row.get("currency"));
    }
}
