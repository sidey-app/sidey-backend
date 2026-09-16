package app.sidey.server.room;

import app.sidey.server.auth.AuthService;
import app.sidey.server.common.*;
import app.sidey.server.profile.ProfileService;
import java.time.OffsetDateTime;
import java.util.*;
import java.util.function.Supplier;
import org.jooq.DSLContext;
import org.jooq.Record;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;

@Service
public class RoomService {
    private final DSLContext db;
    private final Transactions tx;
    private final AuthService auth;
    private final CoordinationLocks coordination;
    private final RoomMembershipBoundary boundary;
    private final InviteCodes codes;
    private final ApplicationEventPublisher events;
    public RoomService(DSLContext db,Transactions tx,AuthService auth,CoordinationLocks coordination,RoomMembershipBoundary boundary,InviteCodes codes,ApplicationEventPublisher events){this.db=db;this.tx=tx;this.auth=auth;this.coordination=coordination;this.boundary=boundary;this.codes=codes;this.events=events;}
    public record Member(UUID userId,OffsetDateTime joinedAt,ProfileService.Profile profile) {}
    public record Room(UUID id,String name,UUID ownerId,OffsetDateTime createdAt,String inviteCodeHint,long inviteVersion,List<Member> members) {}
    public record Created(Room room,String inviteCode) {}

    public List<Room> list(UUID user){
        List<UUID> ids=tx.run(()->{auth.active(user);return db.fetch("select room_id from room_members where user_id=? order by joined_at,room_id",user).map(r->r.get("room_id",UUID.class));});
        List<Room> visible=new ArrayList<>();
        for(UUID room:ids)boundary.read(room,()->tx.run(()->{auth.active(user);if(db.fetchOne("select 1 from room_members where room_id=? and user_id=?",room,user)!=null)visible.add(read(room));return null;}));
        return List.copyOf(visible);
    }
    public Room get(UUID user,UUID room){return boundary.read(room,()->tx.run(()->{auth.active(user);member(room,user);return read(room);}));}
    public Created create(UUID user,String name){String normalized=name(name);UUID room=UUID.randomUUID();return userCoordinated(user,()->boundary.mutate(room,()->tx.run(()->{
        auth.active(user);userLock(user);profile(user);userCapacity(user);
        String code=codes.generate();
        db.execute("insert into rooms(id,name,owner_id) values (?,?,?)",room,normalized,user);
        db.execute("insert into room_members(room_id,user_id) values (?,?)",room,user);
        db.execute("insert into room_invites(room_id,code_hash,code_hint) values (?,?,?)",room,codes.hash(code),codes.hint(code));
        changed(room,user);return new Created(read(room),code);
    })));}
    public Room join(UUID user,String code){return userCoordinated(user,()->{
        // Rejections must not roll back the durable brute-force counter.
        boolean allowed=tx.run(()->{auth.active(user);userLock(user);
            Integer count=db.fetchOne("select count(*) as n from invite_attempts where user_id=? and attempted_at>=now()-interval '10 minutes'",user).get("n",Integer.class);
            if(count>=10)return false;
            db.execute("insert into invite_attempts(user_id) values (?)",user);return true;
        });
        if(!allowed)throw new ApiException(429,"invite_rate_limited");
        String normalized=code==null?"":code.strip().replace("-","").toUpperCase(Locale.ROOT);
        if(!normalized.matches("[0-9A-F]{32}"))throw new ApiException(400,"invalid_invite_code");
        byte[] hash=codes.hash(normalized);
        Record candidate=db.fetchOne("select room_id from room_invites where code_hash=?",hash);
        if(candidate==null)throw new ApiException(400,"invalid_invite_code");
        UUID room=candidate.get("room_id",UUID.class);
        return boundary.mutate(room,()->tx.run(()->{auth.active(user);userLock(user);
            Record locked=db.fetchOne("select id from rooms where id=? for no key update",room);
            if(locked==null || db.fetchOne("select 1 from room_invites where room_id=? and code_hash=?",room,hash)==null)throw new ApiException(400,"invalid_invite_code");
            if(db.fetchOne("select 1 from room_members where room_id=? and user_id=?",room,user)!=null)throw new ApiException(409,"already_a_member");
            profile(user);userCapacity(user);
            if(db.fetchOne("select count(*) as n from room_members where room_id=?",room).get("n",Integer.class)>=12)throw new ApiException(409,"member_limit_reached");
            db.execute("insert into room_members(room_id,user_id) values (?,?)",room,user);
            changed(room,user);return read(room);
        }));
    });}
    public Room rename(UUID user,UUID room,String name){String normalized=name(name);return boundary.mutate(room,()->tx.run(()->{auth.active(user);owner(room,user);db.execute("update rooms set name=? where id=?",normalized,room);changed(room,null);return read(room);}));}
    public Created rotate(UUID user,UUID room){return boundary.mutate(room,()->tx.run(()->{
        auth.active(user);owner(room,user);String code=codes.generate();
        db.execute("insert into room_invites(room_id,code_hash,code_hint) values (?,?,?) on conflict(room_id) do update set code_hash=excluded.code_hash,code_hint=excluded.code_hint,code_version=room_invites.code_version+1,rotated_at=now()",room,codes.hash(code),codes.hint(code));
        changed(room,null);return new Created(read(room),code);
    }));}
    public UUID leave(UUID user,UUID room){return userCoordinated(user,()->boundary.mutate(room,()->tx.run(()->{auth.active(user);userLock(user);lockRoom(room);member(room,user);return removeMembership(room,user); })));}
    public void kick(UUID user,UUID room,UUID target){if(user.equals(target))throw new ApiException(400,"owner_must_leave");boundary.mutate(room,()->tx.run(()->{auth.active(user);owner(room,user);member(room,target);removeMembership(room,target);return null;}));}
    public void delete(UUID user,UUID room){userCoordinated(user,()->boundary.mutate(room,()->tx.run(()->{auth.active(user);userLock(user);owner(room,user);db.execute("delete from rooms where id=?",room);changed(room,null);return null;})));}

    /** Internal operation: caller holds the room boundary and database transaction. */
    public UUID removeMembership(UUID room,UUID user){
        Record r=db.fetchOne("select owner_id from rooms where id=? for no key update",room);
        if(r==null)return null;
        if(db.execute("delete from room_members where room_id=? and user_id=?",room,user)==0)return r.get("owner_id",UUID.class);
        Record next=db.fetchOne("select user_id from room_members where room_id=? order by joined_at,user_id limit 1",room);
        if(next==null){db.execute("delete from rooms where id=?",room);changed(room,user);return null;}
        UUID successor=next.get("user_id",UUID.class);
        if(user.equals(r.get("owner_id",UUID.class)))db.execute("update rooms set owner_id=? where id=?",successor,room);
        changed(room,user);return successor;
    }
    private <T>T userCoordinated(UUID user,Supplier<T> work){return coordination.with("user-room:"+user,work);}
    private void userLock(UUID user){Transactions.lock(db,"user-room:"+user);}
    private void profile(UUID user){if(db.fetchOne("select 1 from profiles where id=?",user)==null)throw new ApiException(409,"profile_required");}
    private void userCapacity(UUID user){if(db.fetchOne("select count(*) as n from room_members where user_id=?",user).get("n",Integer.class)>=5)throw new ApiException(409,"room_limit_reached");}
    private void lockRoom(UUID room){if(db.fetchOne("select id from rooms where id=? for no key update",room)==null)throw new ApiException(403,"membership_required");}
    private void member(UUID room,UUID user){if(db.fetchOne("select 1 from room_members where room_id=? and user_id=?",room,user)==null)throw new ApiException(403,"membership_required");}
    private void owner(UUID room,UUID user){Record r=db.fetchOne("select owner_id from rooms where id=? for no key update",room);if(r==null || !user.equals(r.get("owner_id",UUID.class)))throw new ApiException(403,"owner_required");member(room,user);}
    private String name(String name){if(name==null || name.matches("(?s).*[\\n\\r\\t].*") || name.strip().isEmpty() || name.strip().codePointCount(0,name.strip().length())>20)throw new ApiException(400,"invalid_room_name");return name.strip();}
    private void changed(UUID room,UUID user){events.publishEvent(new StructureChanged(room,user));}
    private Room read(UUID room){
        Record r=db.fetchOne("select r.*,i.code_hint,i.code_version from rooms r left join room_invites i on i.room_id=r.id where r.id=?",room);
        if(r==null)throw new ApiException(404,"room_missing");
        List<Member> members=db.fetch("select m.user_id,m.joined_at,p.* from room_members m join profiles p on p.id=m.user_id where m.room_id=? order by m.joined_at,m.user_id",room).map(p->new Member(p.get("user_id",UUID.class),p.get("joined_at",OffsetDateTime.class),new ProfileService.Profile(p.get("id",UUID.class),p.get("nickname",String.class),p.get("character_id",String.class),p.get("equipped_bubble_style_id",String.class),p.get("equipped_throwable_id",String.class),p.get("tree_movement_paused",Boolean.class),p.get("tree_movement_revision",Long.class),p.get("created_at",OffsetDateTime.class),p.get("updated_at",OffsetDateTime.class))));
        return new Room(r.get("id",UUID.class),r.get("name",String.class),r.get("owner_id",UUID.class),r.get("created_at",OffsetDateTime.class),r.get("code_hint",String.class),r.get("code_version")==null?0:r.get("code_version",Long.class),members);
    }
}
