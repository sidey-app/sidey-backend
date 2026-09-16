package app.sidey.server.profile;

import app.sidey.server.auth.AuthService;
import app.sidey.server.common.*;
import java.time.OffsetDateTime;
import java.util.*;
import org.jooq.DSLContext;
import org.jooq.Record;
import org.springframework.stereotype.Service;

@Service
public class ProfileService {
    private static final Set<String> FREE=Set.of("pixel_hamster","pixel_cat","pixel_puppy","pixel_rabbit","pixel_penguin");
    private static final Set<String> CHARACTERS=Set.of("pixel_hamster","pixel_cat","pixel_puppy","pixel_rabbit","pixel_penguin","pixel_guinea_pig","pixel_monkey","pixel_chinchilla","pixel_starlight_upalupa","pixel_otter","pixel_pig","pixel_tree","pixel_shiba","pixel_duck","pixel_poop","pixel_tteokbokki","pixel_quokka");
    private final DSLContext db;
    private final Transactions tx;
    private final AuthService auth;
    private final org.springframework.context.ApplicationEventPublisher events;
    public ProfileService(DSLContext db, Transactions tx, AuthService auth,org.springframework.context.ApplicationEventPublisher events){this.db=db;this.tx=tx;this.auth=auth;this.events=events;}
    public record Profile(UUID id,String nickname,String characterId,String equippedBubbleStyleId,String equippedThrowableId,boolean treeMovementPaused,long treeMovementRevision,OffsetDateTime createdAt,OffsetDateTime updatedAt) {}
    public Profile get(UUID actor,UUID target){return tx.run(()->{
        auth.active(actor);
        if(!actor.equals(target) && db.fetchOne("select 1 from room_members a join room_members b on a.room_id=b.room_id where a.user_id=? and b.user_id=? limit 1",actor,target)==null) throw new ApiException(403,"profile_not_visible");
        return read(target);
    });}
    public Profile save(UUID user,String nickname,String character){return tx.run(()->{
        lock(user);
        if(nickname==null || nickname.matches("(?s).*[\\n\\r\\t].*") || nickname.strip().codePointCount(0,nickname.strip().length())<2 || nickname.strip().codePointCount(0,nickname.strip().length())>8) throw new ApiException(400,"invalid_nickname");
        String selected="minty_pup".equals(character)?"pixel_hamster":"pixel_koala".equals(character)?"pixel_chinchilla":character;
        if(!CHARACTERS.contains(selected==null?"":selected)) throw new ApiException(400,"invalid_character_id");
        if(!FREE.contains(selected) && !owned(user,"character",selected)) throw new ApiException(403,"character_ownership_required");
        db.execute("insert into profiles(id,nickname,character_id) values (?,?,?) on conflict(id) do update set nickname=excluded.nickname,character_id=excluded.character_id,updated_at=now()",user,nickname.strip(),selected);
        events.publishEvent(new StructureChanged(null,user));
        return read(user);
    });}
    public Profile equipment(UUID user,String kind,String item){return tx.run(()->{
        lock(user);read(user);
        if(!Set.of("bubble_style","throwable").contains(kind==null?"":kind)) throw new ApiException(400,"invalid_product_kind");
        if(item!=null && !owned(user,kind,item)) throw new ApiException(403,"cosmetic_ownership_required");
        if("bubble_style".equals(kind)) db.execute("update profiles set equipped_bubble_style_id=?,updated_at=now() where id=?",item,user);
        else db.execute("update profiles set equipped_throwable_id=?,updated_at=now() where id=?",item,user);
        events.publishEvent(new StructureChanged(null,user));
        return read(user);
    });}
    public Profile tree(UUID user,boolean paused,long expectedRevision){return tx.run(()->{
        lock(user);Profile current=read(user);
        if(expectedRevision<0) throw new ApiException(400,"invalid_revision");
        if(current.treeMovementRevision()==expectedRevision && (current.treeMovementRevision()==0 || current.treeMovementPaused()!=paused)) {
            db.execute("update profiles set tree_movement_paused=?,tree_movement_revision=tree_movement_revision+1,updated_at=now() where id=?",paused,user);
            events.publishEvent(new StructureChanged(null,user));
        }
        return read(user);
    });}
    private void lock(UUID user){if(db.fetchOne("select id from users where id=? for update",user)==null) throw new ApiException(401,"account_missing");auth.active(user);}
    private boolean owned(UUID user,String kind,String item){return db.fetchOne("select 1 from commerce_products p join commerce_entitlements e on e.entitlement_key=p.entitlement_key where p.product_kind=? and p.catalog_item_id=? and p.active and e.user_id=? and e.status='active'",kind,item,user)!=null;}
    private Profile read(UUID user){Record r=db.fetchOne("select * from profiles where id=?",user);if(r==null) throw new ApiException(404,"profile_missing");return new Profile(r.get("id",UUID.class),r.get("nickname",String.class),r.get("character_id",String.class),r.get("equipped_bubble_style_id",String.class),r.get("equipped_throwable_id",String.class),r.get("tree_movement_paused",Boolean.class),r.get("tree_movement_revision",Long.class),r.get("created_at",OffsetDateTime.class),r.get("updated_at",OffsetDateTime.class));}
}
