package app.sidey.server.apple;

import app.sidey.server.auth.AuthService;
import app.sidey.server.commerce.GrantLedger;
import app.sidey.server.common.*;
import java.security.MessageDigest;
import java.sql.Timestamp;
import java.time.*;
import java.util.*;
import org.jooq.DSLContext;
import org.jooq.Record;
import org.springframework.stereotype.Service;

@Service
public class AppStoreService {
    private final DSLContext db;private final Transactions tx;private final AuthService auth;private final AppleVerification apple;private final GrantLedger grants;
    public AppStoreService(DSLContext db,Transactions tx,AuthService auth,AppleVerification apple,GrantLedger grants){this.db=db;this.tx=tx;this.auth=auth;this.apple=apple;this.grants=grants;}
    public record Result(String transactionId,String entitlementKey,String entitlementStatus,String bindingState) {}
    public Result submit(UUID actor,String signed){auth.active(actor);var verified=apple.device(signed);return tx.run(()->apply(actor,verified));}
    public boolean notification(String signed){var notification=apple.notification(signed);return tx.run(()->{
        Transactions.lock(db,"apple-notification:"+notification.id());
        var seen=db.fetchOne("select payload_sha256 from app_store_notification_events where notification_uuid=?",notification.id());byte[] hash=Crypto.hash(notification.signedData());
        if(seen!=null){if(!MessageDigest.isEqual(seen.get(0,byte[].class),hash))throw new ApiException(409,"apple_notification_conflict");return false;}
        String status="ignored";var transaction=notification.transaction();
        if(transaction!=null){
            if(!transaction.environment().equals(notification.environment()))throw new ApiException(400,"apple_environment_mismatch");
            if(db.fetchOne("select 1 from app_store_product_offers where store_product_id=?",transaction.storeProductId())!=null){apply(null,transaction);status="processed";}
        }
        db.execute("insert into app_store_notification_events(notification_uuid,environment,notification_type,transaction_id,signed_at,payload_sha256,processing_status,processed_at) values (?,?,?,?,?,?,?,now())",notification.id(),notification.environment(),notification.type(),transaction==null?null:transaction.id(),stamp(notification.signedAt()),hash,status);return true;
    });}
    private Result apply(UUID actor,AppleVerification.Transaction value){
        validate(value);Transactions.lock(db,"apple-transaction:"+value.environment()+":"+value.id());
        Record offer=db.fetchOne("select o.*,p.entitlement_key from app_store_product_offers o join commerce_products p on p.id=o.product_id where store_product_id=?",value.storeProductId());
        if(offer==null)throw new ApiException(400,"unknown_app_store_product");
        Record previous=read(value,false);UUID candidate=previous==null?actor:previous.get("user_id",UUID.class);if(candidate==null)candidate=actor;
        if(candidate!=null && db.fetchOne("select id from users where id=? for update",candidate)==null){if(actor!=null)throw new ApiException(401,"account_missing");}
        if(actor!=null)auth.active(actor);
        previous=read(value,true);String key=offer.get("entitlement_key",String.class);
        if(previous!=null){
            if(!value.storeProductId().equals(previous.get("store_product_id")) || !value.originalId().equals(previous.get("original_transaction_id")))throw new ApiException(409,"apple_transaction_product_mismatch");
            if(actor!=null && previous.get("user_id")!=null && !actor.equals(previous.get("user_id")))throw new ApiException(409,"apple_transaction_already_bound");
            if(value.signedAt().isBefore(previous.get("signed_at",OffsetDateTime.class).toInstant()))return new Result(value.id(),key,previous.get("status",String.class),previous.get("binding_state",String.class));
        }
        UUID user=previous==null?actor:previous.get("user_id",UUID.class);if(user==null)user=actor;
        if(previous==null && user!=null && !user.equals(value.accountToken()))throw new ApiException(403,"app_account_token_mismatch");
        String status=value.revokedAt()==null?"active":"refunded",binding=user==null?"unbound":"bound";
        db.execute("insert into app_store_transactions(environment,transaction_id,original_transaction_id,product_id,store_product_id,user_id,app_account_token,status,binding_state,purchased_at,revoked_at,signed_at,signed_data_sha256,price_milliunits,currency,price_signed_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(environment,transaction_id) do update set user_id=excluded.user_id,app_account_token=coalesce(app_store_transactions.app_account_token,excluded.app_account_token),status=excluded.status,binding_state=excluded.binding_state,revoked_at=excluded.revoked_at,signed_at=excluded.signed_at,signed_data_sha256=excluded.signed_data_sha256,price_milliunits=coalesce(excluded.price_milliunits,app_store_transactions.price_milliunits),currency=coalesce(excluded.currency,app_store_transactions.currency),price_signed_at=coalesce(excluded.price_signed_at,app_store_transactions.price_signed_at),updated_at=now()",
            value.environment(),value.id(),value.originalId(),offer.get("product_id"),value.storeProductId(),user,value.accountToken(),status,binding,stamp(value.purchasedAt()),stamp(value.revokedAt()),stamp(value.signedAt()),Crypto.hash(value.signedData()),value.priceMilliunits(),value.currency(),value.priceMilliunits()==null?null:stamp(value.signedAt()));
        if(user!=null)grants.apply(user,key,"app_store","transaction:"+value.environment()+":"+value.id(),status,value.purchasedAt(),offer.get("included_entitlement_key",String.class),value.revokedAt());
        return new Result(value.id(),key,status,binding);
    }
    /** Internal bounded historical enrichment; older signed money cannot roll back status. */
    public int backfillPrices(String environment,int limit){
        if(!Set.of("Sandbox","Production").contains(environment) || limit<1 || limit>100)throw new ApiException(400,"invalid_backfill_query");int changed=0;
        for(String id:db.fetch("select transaction_id from app_store_transactions where environment=? and price_milliunits is null order by purchased_at,transaction_id limit ?",environment,limit).getValues(0,String.class)){
            var value=apple.lookup(id,environment);validate(value);if(!id.equals(value.id()) || !environment.equals(value.environment()))throw new ApiException(409,"apple_transaction_mismatch");if(value.priceMilliunits()==null)continue;
            changed+=tx.run(()->{Transactions.lock(db,"apple-transaction:"+environment+":"+id);
                return db.execute("update app_store_transactions set price_milliunits=?,currency=?,price_signed_at=? where environment=? and transaction_id=? and store_product_id=? and price_milliunits is null",value.priceMilliunits(),value.currency(),stamp(value.signedAt()),environment,id,value.storeProductId());});
        }return changed;
    }
    private Record read(AppleVerification.Transaction value,boolean lock){return db.fetchOne("select * from app_store_transactions where environment=? and transaction_id=?"+(lock?" for update":""),value.environment(),value.id());}
    private void validate(AppleVerification.Transaction v){
        if(v==null || v.id()==null || v.id().isBlank() || v.id().length()>128 || v.originalId()==null || v.originalId().isBlank() || v.originalId().length()>128 || !Set.of("Sandbox","Production").contains(v.environment()) || v.purchasedAt()==null || v.signedAt()==null || v.signedData()==null || (v.priceMilliunits()==null)!=(v.currency()==null) || (v.priceMilliunits()!=null && (v.priceMilliunits()<0 || v.priceMilliunits()>9007199254740991L || !v.currency().matches("[A-Z]{3}"))))throw new ApiException(400,"invalid_apple_transaction");
    }
    private static Timestamp stamp(Instant time){return time==null?null:Timestamp.from(time);}
}
