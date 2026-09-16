package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;
import app.sidey.server.commerce.*;
import app.sidey.server.common.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class CommerceTest extends PostgresTest {
    static class Provider implements PaymentProvider {
        final Map<String,Payment> payments=new ConcurrentHashMap<>();final AtomicInteger queries=new AtomicInteger(),cancels=new AtomicInteger();boolean lostCancelResponse;
        public Payment lookup(String id){queries.incrementAndGet();return payments.get(id);}
        public void cancel(String id,UUID request,String reason,long total){cancels.incrementAndGet();var p=payments.get(id);payments.put(id,new Payment(p.id(),"CANCELLED",p.storeId(),p.channelKey(),p.channelType(),p.version(),p.transactionId(),p.total(),p.total(),p.currency(),p.method()));if(lostCancelResponse){lostCancelResponse=false;throw new ApiException(502,"response_lost");}}
        public void verifyWebhook(String body,String id,String signature,String timestamp){if(!"verified".equals(signature))throw new ApiException(400,"invalid_webhook_signature");}
        public String storeId(){return "store-test";}public String channelKey(){return "channel-test";}public void requireConfigured(){}
    }
    class Setup {
        final CoreFixture f=new CoreFixture(db,tx);final UUID user=f.user();final Provider provider=new Provider();final GrantLedger ledger=new GrantLedger(db,f.tx,e->{});
        final CommerceService service=new CommerceService(db,f.tx,f.auth,provider,ledger,new CoordinationLocks(),new ObjectMapper(),"https://example.test/");
        Setup(){db.execute("insert into commerce_runtime_settings(singleton,sales_enabled,payment_environment,policy_version,policy_notice) values (true,true,'test','v1',repeat('notice ',20)) on conflict(singleton) do update set sales_enabled=true");}
        CommerceService.Created create(){return service.create(user,"character_tree");}
        PaymentProvider.Payment paid(CommerceService.Created order){var row=db.fetchOne("select * from commerce_orders where id=?",order.orderId());var payment=new PaymentProvider.Payment(row.get("provider_order_id",String.class),"PAID","store-test","channel-test","TEST","V2","tx-1",row.get("amount_krw",Long.class),0,"KRW","PaymentMethodEasyPay");provider.payments.put(payment.id(),payment);return payment;}
        void consent(CommerceService.Created order){service.checkout(order.checkoutToken(),true,"v1");}
        String status(){return db.fetchOne("select status from commerce_entitlements where user_id=? and entitlement_key='character:pixel_tree'",user).get(0,String.class);}
    }
    @Test void checkoutAndProviderTruthAreRequiredBeforeOwnership(){
        var s=new Setup();var order=s.create();var p=s.paid(order);
        assertEquals("https://example.test/checkout/#token="+order.checkoutToken(),order.checkoutUrl());
        var prepared=s.service.checkout(order.checkoutToken(),false,null);
        assertEquals(order.orderId(),prepared.get("orderId"));
        assertEquals("character_tree",prepared.get("productId"));
        assertEquals(p.total(),((Number)prepared.get("amount")).longValue());
        assertEquals("KRW",prepared.get("currency"));
        assertEquals(true,prepared.get("requiresConsent"));
        assertFalse(prepared.containsKey("channelKey"));
        var catalog=s.service.catalog(s.user);
        assertTrue(catalog.stream().allMatch(row->row.get("tax_inclusive") instanceof Boolean));
        assertTrue(catalog.stream().allMatch(row->row.get("product_description") instanceof String));
        assertThrows(ApiException.class,()->s.service.complete(order.checkoutToken(),p.id()));assertTrue(s.service.entitlements(s.user).isEmpty());
        assertThrows(ApiException.class,()->s.service.checkout(order.checkoutToken(),true,"forged-policy"));
        var authorized=s.service.checkout(order.checkoutToken(),true,"v1");
        assertEquals("https://example.test/checkout-result/#token="+order.checkoutToken(),authorized.get("redirectUrl"));
        assertEquals("CURRENCY_KRW",authorized.get("portoneCurrency"));
        assertEquals(p.id(),authorized.get("paymentId"));
        assertThrows(ApiException.class,()->s.service.complete(Crypto.token(),p.id()));
        List<PaymentProvider.Payment> forged=List.of(
            new PaymentProvider.Payment(p.id(),"PAID",p.storeId(),p.channelKey(),p.channelType(),"V1",null,p.total(),0,"KRW",p.method()),
            new PaymentProvider.Payment(p.id(),"PAID","wrong-store",p.channelKey(),p.channelType(),"V2",null,p.total(),0,"KRW",p.method()),
            new PaymentProvider.Payment(p.id(),"PAID",p.storeId(),"wrong-channel",p.channelType(),"V2",null,p.total(),0,"KRW",p.method()),
            new PaymentProvider.Payment(p.id(),"PAID",p.storeId(),p.channelKey(),"LIVE","V2",null,p.total(),0,"KRW",p.method()),
            new PaymentProvider.Payment(p.id(),"PAID",p.storeId(),p.channelKey(),p.channelType(),"V2",null,1,0,"KRW",p.method()),
            new PaymentProvider.Payment(p.id(),"PAID",p.storeId(),p.channelKey(),p.channelType(),"V2",null,p.total(),0,"USD",p.method()));
        for(var invalid:forged){s.provider.payments.put(p.id(),invalid);assertEquals("payment_verification_failed",assertThrows(ApiException.class,()->s.service.complete(order.checkoutToken(),p.id())).code());assertTrue(s.service.entitlements(s.user).isEmpty());}
        s.provider.payments.put(p.id(),p);assertEquals("approved",s.service.complete(order.checkoutToken(),p.id()));assertEquals("active",s.status());
        assertThrows(ApiException.class,()->s.create());assertThrows(ApiException.class,()->s.service.order(s.f.user(),order.orderId()));
        assertThrows(ApiException.class,()->s.service.create(s.user,"unknown_product"));
    }
    @Test void concurrentCompletionHasOneGrantAndWebhookConflictIsDetected()throws Exception{
        var s=new Setup();var order=s.create();var p=s.paid(order);s.consent(order);
        try(var pool=Executors.newFixedThreadPool(6)){List<Future<String>> results=new ArrayList<>();for(int i=0;i<6;i++)results.add(pool.submit(()->s.service.complete(order.checkoutToken(),p.id())));for(var result:results)assertEquals("approved",result.get(10,TimeUnit.SECONDS));}
        assertEquals(1,db.fetchOne("select count(*) from commerce_grants where source_reference=?","order:"+order.orderId()).get(0,Integer.class));
        String body="{\"type\":\"Transaction.Paid\",\"data\":{\"paymentId\":\""+p.id()+"\"}}";
        String event=UUID.randomUUID().toString();int before=s.provider.queries.get();assertThrows(ApiException.class,()->s.service.webhook(body,event,"forged","0"));assertEquals(before,s.provider.queries.get());
        assertEquals("approved",s.service.webhook(body,event,"verified","0"));assertEquals("approved",s.service.webhook(body,event,"verified","0"));
        assertEquals("webhook_event_conflict",assertThrows(ApiException.class,()->s.service.webhook(body+" ",event,"verified","0")).code());
    }
    @Test void refundRetryRecoversProviderSuccessAndPreservesOtherSources(){
        var s=new Setup();var order=s.create();var p=s.paid(order);s.consent(order);s.service.complete(order.checkoutToken(),p.id());
        s.ledger.apply(s.user,"character:pixel_tree","complimentary","other:"+s.user,"active",Instant.now(),null);
        db.execute("update profiles set character_id='pixel_tree' where id=?",s.user);
        UUID request=UUID.randomUUID();s.provider.lostCancelResponse=true;
        assertThrows(ApiException.class,()->s.service.refund(order.orderId(),request,"duplicate_payment",null,"operator"));
        assertEquals("refunded",s.service.refund(order.orderId(),request,"duplicate_payment",null,"operator"));
        assertEquals("refunded",s.service.refund(order.orderId(),request,"duplicate_payment",null,"operator"));assertEquals(1,s.provider.cancels.get());
        assertEquals("active",s.status());assertEquals("pixel_tree",db.fetchOne("select character_id from profiles where id=?",s.user).get(0));
        assertThrows(ApiException.class,()->s.service.refund(order.orderId(),UUID.randomUUID(),"duplicate_payment",null,"operator"));
        s.ledger.apply(s.user,"character:pixel_tree","complimentary","other:"+s.user,"revoked",Instant.now(),null);assertEquals("refunded",s.status());assertEquals("pixel_hamster",db.fetchOne("select character_id from profiles where id=?",s.user).get(0));
        s.provider.payments.put(p.id(),p);assertEquals("refunded",s.service.complete(order.checkoutToken(),p.id()));assertEquals("refunded",s.status());
    }
    @Test void inclusionUsesOriginalGrantSnapshotAndIndependentItemSource(){
        var s=new Setup();String reference="bundle:"+s.user;
        UUID parent=s.ledger.apply(s.user,"character:pixel_tree","complimentary",reference,"active",Instant.now(),"throwable:throwable_timber");
        s.ledger.apply(s.user,"throwable:throwable_timber","complimentary","item:"+s.user,"active",Instant.now(),null);
        s.ledger.apply(s.user,"character:pixel_tree","complimentary",reference,"refunded",Instant.now(),"throwable:throwable_pork");
        assertEquals("active",db.fetchOne("select status from commerce_entitlements where user_id=? and entitlement_key='throwable:throwable_timber'",s.user).get(0));
        assertEquals("throwable:throwable_timber",db.fetchOne("select entitlement_key from commerce_grants where parent_grant_id=?",parent).get(0));
        assertEquals(0,db.fetchOne("select count(*) from commerce_entitlements where user_id=? and entitlement_key='throwable:throwable_pork'",s.user).get(0,Integer.class));
    }
    @Test void orderLimitSurvivesConcurrentCreates()throws Exception{
        var s=new Setup();try(var pool=Executors.newFixedThreadPool(8)){List<Future<Boolean>> results=new ArrayList<>();for(int i=0;i<8;i++)results.add(pool.submit(()->{try{s.create();return true;}catch(ApiException e){assertEquals("commerce_rate_limited",e.code());return false;}}));int accepted=0;for(var result:results)if(result.get(10,TimeUnit.SECONDS))accepted++;assertEquals(5,accepted);}
    }
}
