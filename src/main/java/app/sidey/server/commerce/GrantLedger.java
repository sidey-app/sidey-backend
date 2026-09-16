package app.sidey.server.commerce;

import app.sidey.server.common.*;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;
import org.jooq.DSLContext;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;

@Service
public class GrantLedger {
    private final DSLContext db;private final Transactions tx;private final ApplicationEventPublisher events;
    public GrantLedger(DSLContext db,Transactions tx,ApplicationEventPublisher events){this.db=db;this.tx=tx;this.events=events;}
    /** Caller owns provider serialization. User lock serializes projection with equipment/deletion. */
    public UUID apply(UUID user,String key,String kind,String reference,String status,Instant granted,String included){return tx.run(()->{
        if(user!=null && db.fetchOne("select id from users where id=? for update",user)==null)throw new ApiException(409,"grant_account_missing");
        Transactions.lock(db,"grant:"+kind+":"+reference);
        var existing=db.fetchOne("select * from commerce_grants where source_kind=? and source_reference=? for update",kind,reference);
        UUID id=existing==null?UUID.randomUUID():existing.get("id",UUID.class);
        if(existing!=null && (!Objects.equals(existing.get("entitlement_key"),key) || (existing.get("user_id")!=null && !Objects.equals(existing.get("user_id"),user))))throw new ApiException(409,"grant_source_conflict");
        String snapshot=existing==null?included:existing.get("included_entitlement_key",String.class);
        if(user==null && status.equals("active"))statusGuard();
        db.execute("insert into commerce_grants(id,user_id,entitlement_key,source_kind,source_reference,status,granted_at,revoked_at,included_entitlement_key) values (?,?,?,?,?,?,?,case when ?='active' then null else now() end,?) on conflict(id) do update set user_id=excluded.user_id,status=excluded.status,revoked_at=excluded.revoked_at,updated_at=now()",id,user,key,kind,reference,status,Timestamp.from(granted),status,snapshot);
        if(snapshot!=null){
            db.execute("insert into commerce_grants(user_id,entitlement_key,source_kind,source_reference,status,granted_at,revoked_at,parent_grant_id) values (?,?,'complimentary',?,?,?,case when ?='active' then null else now() end,?) on conflict(parent_grant_id) where parent_grant_id is not null do update set user_id=excluded.user_id,status=excluded.status,revoked_at=excluded.revoked_at,updated_at=now()",user,snapshot,"included:"+id,status,Timestamp.from(granted),status,id);
        }
        if(user!=null){refresh(user,key);if(snapshot!=null)refresh(user,snapshot);events.publishEvent(new StructureChanged(null,user));}return id;
    });}
    private void statusGuard(){throw new ApiException(409,"active_grant_requires_account");}
    private void refresh(UUID user,String key){
        db.execute("insert into commerce_entitlements(user_id,entitlement_key,status,granted_at,revoked_at) select user_id,entitlement_key,case when bool_or(status='active') then 'active' when bool_or(status='refunded') then 'refunded' else 'revoked' end,min(granted_at),case when bool_or(status='active') then null else coalesce(max(revoked_at),now()) end from commerce_grants where user_id=? and entitlement_key=? group by 1,2 on conflict(user_id,entitlement_key) do update set status=excluded.status,granted_at=excluded.granted_at,revoked_at=excluded.revoked_at,updated_at=now()",user,key);
        if(db.fetchOne("select 1 from commerce_entitlements where user_id=? and entitlement_key=? and status='active'",user,key)!=null)return;
        db.execute("update profiles f set character_id=case when p.product_kind='character' and f.character_id=p.catalog_item_id then 'pixel_hamster' else f.character_id end,equipped_bubble_style_id=case when p.product_kind='bubble' and f.equipped_bubble_style_id=p.catalog_item_id then null else f.equipped_bubble_style_id end,equipped_throwable_id=case when p.product_kind='throwable' and f.equipped_throwable_id=p.catalog_item_id then null else f.equipped_throwable_id end,updated_at=now() from commerce_products p where f.id=? and p.entitlement_key=?",user,key);
    }
}
