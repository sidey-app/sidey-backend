package app.sidey.server.commerce;

import app.sidey.server.auth.AuthService;
import app.sidey.server.common.*;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;
import org.jooq.DSLContext;
import org.jooq.Record;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

@Service
public class CommerceService {
    private final DSLContext db;private final Transactions tx;private final AuthService auth;private final PaymentProvider provider;private final GrantLedger grants;private final CoordinationLocks locks;private final ObjectMapper json;private final String website;
    public CommerceService(DSLContext db,Transactions tx,AuthService auth,PaymentProvider provider,GrantLedger grants,CoordinationLocks locks,ObjectMapper json,@Value("${sidey.commerce.website:https://sidey-app.github.io/SIDEY/}")String website){this.db=db;this.tx=tx;this.auth=auth;this.provider=provider;this.grants=grants;this.locks=locks;this.json=json;this.website=website.endsWith("/")?website:website+"/";}
    public record Created(UUID orderId,String checkoutUrl,String checkoutToken) {}
    public List<Map<String,Object>> catalog(UUID user){auth.active(user);return db.fetch("select p.*,c.amount_krw,c.currency,o.store_product_id from commerce_products p join commerce_prices c on c.product_id=p.id and c.active left join app_store_product_offers o on o.product_id=p.id and o.current_offer where p.active order by p.sort_order,p.id").intoMaps();}
    public List<Map<String,Object>> entitlements(UUID user){auth.active(user);return db.fetch("select entitlement_key,status,granted_at,revoked_at from commerce_entitlements where user_id=? order by entitlement_key",user).intoMaps();}
    public Map<String,Object> order(UUID user,UUID id){auth.active(user);Record row=db.fetchOne("select id,product_id,amount_krw,currency,status,created_at,approved_at,refunded_at from commerce_orders where id=? and user_id=?",id,user);if(row==null)throw new ApiException(404,"order_missing");return row.intoMap();}
    public Created create(UUID user,String product){provider.requireConfigured();return tx.run(()->{
        lockUser(user);auth.active(user);Record settings=settings();
        if(!settings.get("sales_enabled",Boolean.class))throw new ApiException(503,"commerce_sales_disabled");
        if(db.fetchOne("select count(*) from commerce_orders where user_id=? and created_at>clock_timestamp()-interval '1 minute'",user).get(0,Integer.class)>=5)throw new ApiException(429,"commerce_rate_limited");
        Record price=db.fetchOne("select c.*,p.entitlement_key from commerce_prices c join commerce_products p on p.id=c.product_id where c.product_id=? and c.active and p.active for share of c,p",product);
        if(price==null)throw new ApiException(400,"commerce_product_unavailable");
        if(db.fetchOne("select 1 from commerce_entitlements where user_id=? and entitlement_key=? and status='active'",user,price.get("entitlement_key"))!=null)throw new ApiException(409,"already_owned");
        UUID id=UUID.randomUUID();String token=Crypto.token();
        db.execute("insert into commerce_orders(id,user_id,product_id,price_id,provider_order_id,amount_krw,currency,payment_environment,checkout_token_hash,checkout_token_expires_at) values (?,?,?,?,?,?,'KRW',?,?,clock_timestamp()+interval '15 minutes')",id,user,product,price.get("id"),"sidey-"+id,price.get("amount_krw"),settings.get("payment_environment"),Crypto.hash(token));
        return new Created(id,website+"checkout/#token="+token,token);
    });}
    public Map<String,Object> checkout(String token,boolean consent,String policyVersion){provider.requireConfigured();return tx.run(()->{
        Record order=tokenOrder(token,null);lockUser(order.get("user_id",UUID.class));auth.active(order.get("user_id",UUID.class));
        order=db.fetchOne("select * from commerce_orders where id=? for update",order.get("id"));
        if(!"pending".equals(order.get("status")))throw new ApiException(409,"checkout_not_pending");
        Record settings=settings();if(!settings.get("sales_enabled",Boolean.class))throw new ApiException(503,"commerce_sales_disabled");
        String version=order.get("policy_version",String.class),notice=order.get("policy_notice",String.class);
        if(version==null){version=settings.get("policy_version",String.class);notice=settings.get("policy_notice",String.class);}
        if(consent){if(!Objects.equals(version,policyVersion))throw new ApiException(409,"commerce_policy_version_mismatch");
            db.execute("update commerce_orders set policy_version=?,policy_notice=?,policy_consented_at=coalesce(policy_consented_at,now()),updated_at=now() where id=?",version,notice,order.get("id"));}
        Map<String,Object> result=new LinkedHashMap<>();result.put("orderId",order.get("id"));result.put("productId",order.get("product_id"));result.put("amount",order.get("amount_krw"));result.put("currency",order.get("currency"));result.put("policyVersion",version);result.put("policyNotice",notice);result.put("requiresConsent",!consent && order.get("policy_consented_at")==null);
        result.put("orderName",db.fetchOne("select display_name from commerce_products where id=?",order.get("product_id")).get(0));
        if(consent){result.put("storeId",provider.storeId());result.put("channelKey",provider.channelKey());result.put("paymentId",order.get("provider_order_id"));result.put("payMethod","EASY_PAY");result.put("portoneCurrency","CURRENCY_KRW");result.put("redirectUrl",website+"checkout-result/#token="+token);}
        return result;
    });}
    public String complete(String token,String paymentId){Record order=tokenOrder(token,paymentId);return locks.with("payment:"+paymentId,()->{
        var payment=provider.lookup(paymentId);verify(order,payment);if(!"PAID".equals(payment.status()))throw new ApiException(409,"payment_not_paid");
        return apply(order.get("id",UUID.class),payment,"complete:"+order.get("id"),"SIDEY_COMPLETE",Crypto.hash(json.writeValueAsString(payment)));
    });}
    public String webhook(String body,String id,String signature,String timestamp){provider.verifyWebhook(body,id,signature,timestamp);
        var payload=json.readTree(body);String paymentId=payload.path("data").path("paymentId").asString(null);
        if(paymentId==null || paymentId.length()>200)return "ignored";
        return locks.with("payment:"+paymentId,()->{Record order=db.fetchOne("select * from commerce_orders where provider_order_id=?",paymentId);if(order==null)return "ignored";
            var payment=provider.lookup(paymentId);return apply(order.get("id",UUID.class),payment,"portone:"+id,payload.path("type").asString("UNKNOWN"),Crypto.hash(body));});
    }
    private String apply(UUID id,PaymentProvider.Payment payment,String event,String eventType,byte[] hash){return tx.run(()->{
        Record initial=db.fetchOne("select * from commerce_orders where id=?",id);if(initial==null)throw new ApiException(404,"order_missing");
        UUID user=initial.get("user_id",UUID.class);if(user!=null)lockUser(user);
        Record order=db.fetchOne("select * from commerce_orders where id=? for update",id);verify(order,payment);
        Transactions.lock(db,"payment-event:"+event);
        Record seen=db.fetchOne("select * from commerce_webhook_events where provider='portone' and event_id=?",event);
        if(seen!=null){if(!MessageDigest.isEqual(seen.get("payload_sha256",byte[].class),hash) || !Objects.equals(seen.get("order_id"),id))throw new ApiException(409,"webhook_event_conflict");return order.get("status",String.class);}
        String status=order.get("status",String.class);
        if(payment.status().equals("PAID") && !status.equals("refunded")){
            if(order.get("policy_consented_at")==null)throw new ApiException(409,"commerce_consent_required");
            status="approved";
        } else if(payment.status().equals("CANCELLED") && payment.cancelled()==payment.total())status="refunded";
        else if(payment.status().equals("FAILED") && status.equals("pending"))status="failed";
        // A late provider snapshot must never resurrect a fully refunded payment.
        if(!order.get("status").equals("refunded") || payment.status().equals("CANCELLED")){
            int changed=db.execute("insert into commerce_payments(order_id,provider,provider_payment_id,provider_transaction_id,provider_status,store_id,channel_key,provider_version,channel_type,payment_method_type,amount_krw,balance_amount_krw,currency,last_verified_at) values (?,'portone',?,?,?,?,?,? ,?,'EASY_PAY',?,?,?,now()) on conflict(order_id) do update set provider_transaction_id=coalesce(excluded.provider_transaction_id,commerce_payments.provider_transaction_id),provider_status=excluded.provider_status,balance_amount_krw=excluded.balance_amount_krw,last_verified_at=now(),updated_at=now() where commerce_payments.provider='portone' and commerce_payments.provider_payment_id=excluded.provider_payment_id",id,payment.id(),payment.transactionId(),payment.status(),payment.storeId(),payment.channelKey(),payment.version(),payment.channelType(),payment.total(),payment.total()-payment.cancelled(),payment.currency());
            if(changed!=1)throw new ApiException(409,"payment_provider_conflict");
        }
        db.execute("update commerce_orders set status=?,approved_at=case when ?='approved' then coalesce(approved_at,now()) else approved_at end,refunded_at=case when ?='refunded' then coalesce(refunded_at,now()) else refunded_at end,updated_at=now() where id=?",status,status,status,id);
        if((status.equals("approved") || status.equals("refunded")) && user!=null){
            String key=db.fetchOne("select entitlement_key from commerce_products where id=?",order.get("product_id")).get(0,String.class);
            grants.apply(user,key,"portone","order:"+id,status.equals("approved")?"active":"refunded",Instant.now(),null);
        }
        db.execute("insert into commerce_webhook_events(provider,event_id,event_type,payload_sha256,order_id,processing_status,processed_at) values ('portone',?,?,?,?,'processed',now())",event,eventType,hash,id);
        return status;
    });}
    public String refund(UUID orderId,UUID requestId,String reason,String detail,String operator){
        if(orderId==null || requestId==null || !Set.of("not_provided","contract_mismatch","duplicate_payment","unauthorized_payment","minor_without_consent","other_statutory_reason","operations_live_smoke_cleanup").contains(reason==null?"":reason) || operator==null || operator.strip().length()<3 || operator.length()>80 || (detail!=null && (detail.isBlank() || detail.length()>500)))throw new ApiException(400,"invalid_refund_request");
        Record initial=db.fetchOne("select * from commerce_orders where id=?",orderId);if(initial==null)throw new ApiException(404,"order_missing");
        String paymentId=initial.get("provider_order_id",String.class);
        return locks.with("payment:"+paymentId,()->{
            tx.run(()->{Record order=db.fetchOne("select * from commerce_orders where id=? for update",orderId);
                Record operation=db.fetchOne("select * from commerce_refund_operations where order_id=?",orderId);
                if(operation!=null && (!requestId.equals(operation.get("request_id")) || !reason.equals(operation.get("reason_code")) || !Objects.equals(detail,operation.get("reason_detail"))))throw new ApiException(409,"refund_request_conflict");
                if(operation==null){if(!"approved".equals(order.get("status")))throw new ApiException(409,"refund_not_available");db.execute("insert into commerce_refund_operations(order_id,request_id,reason_code,reason_detail,requested_by) values (?,?,?,?,?)",orderId,requestId,reason,detail,operator.strip());}return null;});
            var before=provider.lookup(paymentId);verify(initial,before);
            if(before.status().equals("PAID"))provider.cancel(paymentId,requestId,detail==null?"SIDEY full refund":detail,before.total());
            var after=provider.lookup(paymentId);verify(initial,after);
            if(!after.status().equals("CANCELLED") || after.cancelled()!=after.total())throw new ApiException(409,"refund_verification_failed");
            String status=apply(orderId,after,"refund:"+requestId,"SIDEY_REFUND",Crypto.hash(json.writeValueAsString(after)));
            tx.run(()->{db.execute("update commerce_refund_operations set processing_status='completed',result_code=?,provider_status=?,processed_at=now(),updated_at=now() where order_id=?",status,after.status(),orderId);return null;});return status;
        });
    }
    private void verify(Record order,PaymentProvider.Payment p){
        String environment=order.get("payment_environment",String.class);
        if(environment==null || !Objects.equals(order.get("provider_order_id"),p.id()) || !Objects.equals(provider.storeId(),p.storeId()) || !Objects.equals(provider.channelKey(),p.channelKey()) || !(environment.equals("live")?"LIVE":"TEST").equals(p.channelType()) || !"V2".equals(p.version()) || order.get("amount_krw",Long.class)!=p.total() || !Objects.equals(order.get("currency"),p.currency()) || !"PaymentMethodEasyPay".equals(p.method()) || p.cancelled()<0 || p.cancelled()>p.total())throw new ApiException(409,"payment_verification_failed");
    }
    private Record tokenOrder(String token,String paymentId){
        if(token==null || !token.matches("[A-Za-z0-9_-]{43}"))throw new ApiException(400,"invalid_checkout_token");
        Record r=db.fetchOne("select * from commerce_orders where checkout_token_hash=? and checkout_token_expires_at>clock_timestamp()",Crypto.hash(token));
        if(r==null || (paymentId!=null && !paymentId.equals(r.get("provider_order_id"))))throw new ApiException(410,"checkout_expired");
        if(r.get("user_id")==null || r.get("payment_environment")==null)throw new ApiException(410,"checkout_expired");auth.active(r.get("user_id",UUID.class));return r;
    }
    private Record settings(){Record r=db.fetchOne("select * from commerce_runtime_settings where singleton for share");if(r==null)throw new ApiException(503,"commerce_sales_disabled");return r;}
    private void lockUser(UUID user){if(user==null || db.fetchOne("select id from users where id=? for update",user)==null)throw new ApiException(401,"account_missing");}
}
