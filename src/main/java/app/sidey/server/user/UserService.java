package app.sidey.server.user;

import app.sidey.server.auth.AuthService;
import app.sidey.server.common.CoordinationLocks;
import app.sidey.server.common.Transactions;
import app.sidey.server.room.RoomMembershipBoundary;
import java.util.List;
import java.util.UUID;
import org.jooq.DSLContext;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;

@Service
public class UserService {
    private final DSLContext db;
    private final Transactions tx;
    private final CoordinationLocks coordination;
    private final RoomMembershipBoundary rooms;
    private final AuthService auth;
    private final ApplicationEventPublisher events;

    public UserService(DSLContext db, Transactions tx, CoordinationLocks coordination,
            RoomMembershipBoundary rooms, AuthService auth, ApplicationEventPublisher events) {
        this.db=db; this.tx=tx; this.coordination=coordination; this.rooms=rooms; this.auth=auth;this.events=events;
    }

    public void delete(UUID user) {
        String key="user-room:"+user;
        coordination.with(key,()->{
            // All room mutations for this user share the outer coordination key.
            // Obtain room locks before starting the transaction: publication and
            // membership revocation will later share this same JVM boundary.
            List<UUID> affected=db.fetch("select room_id from room_members where user_id=? order by room_id",user)
                    .getValues("room_id",UUID.class);
            return rooms.mutateAll(affected,()->tx.run(()->{
                Transactions.lock(db,key);
                auth.active(user);
                for(UUID room:affected) {
                    var row=db.fetchOne("select owner_id from rooms where id=? for no key update",room);
                    if(row==null || !user.equals(row.get("owner_id",UUID.class))) continue;
                    var successor=db.fetchOne("select user_id from room_members where room_id=? and user_id<>? "
                            +"order by joined_at,user_id limit 1",room,user);
                    if(successor==null) db.execute("delete from rooms where id=?",room);
                    else db.execute("update rooms set owner_id=? where id=?",successor.get("user_id",UUID.class),room);
                }
                db.execute("delete from room_members where user_id=?",user);
                // Publish revocation inside this transaction so AFTER_COMMIT
                // consumers receive session IDs even though rows then cascade.
                auth.logoutAll(user);
                db.execute("delete from commerce_entitlements where user_id=?",user);
                db.execute("update commerce_orders set user_id=null,updated_at=now() where user_id=?",user);
                db.execute("update commerce_grants set user_id=null,"
                        +"status=case when status='active' then 'revoked' else status end,"
                        +"revoked_at=case when status='active' then now() else revoked_at end,"
                        +"updated_at=now() where user_id=?",user);
                db.execute("update app_store_transactions set user_id=null,binding_state='unbound',updated_at=now() where user_id=?",user);
                db.execute("delete from users where id=?",user);
                affected.forEach(room->{
                    events.publishEvent(new app.sidey.server.common.RoomRevoked(room,java.util.Set.of(user)));
                    events.publishEvent(new app.sidey.server.common.StructureChanged(room,user));
                });
                return null;
            }));
        });
    }

    public boolean hasAppleIdentity(UUID user){return db.fetchOne("select 1 from user_identities where user_id=? and provider='APPLE'",user)!=null;}
}
