package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;
import app.sidey.server.common.ApiException;
import app.sidey.server.realtime.MembershipRegistry;
import app.sidey.server.room.RoomMembershipBoundary;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class MembershipRegistryTest extends PostgresTest {
    @Test void exceptionAfterCommittedTransactionAlsoInvalidatesAuthority(){
        var f=new CoreFixture(db,tx);UUID owner=f.user(),member=f.user();var room=f.rooms.create(owner,"불확실방");f.rooms.join(member,room.inviteCode());
        var registry=new MembershipRegistry(db,f.boundary);registry.require(room.room().id(),member);
        assertThrows(IllegalStateException.class,()->f.boundary.mutate(room.room().id(),()->{
            f.tx.run(()->{db.execute("delete from room_members where room_id=? and user_id=?",room.room().id(),member);return null;});
            throw new IllegalStateException("after_commit_listener_failure");
        }));
        assertEquals(0,registry.size());assertThrows(ApiException.class,()->registry.require(room.room().id(),member));assertEquals(0,f.boundary.lockCount());
    }
    @Test void committedObserverFailureInvalidatesAndNextAccessRecoversFromDatabase() {
        UUID room=UUID.randomUUID(),owner=UUID.randomUUID(),member=UUID.randomUUID();
        tx.executeWithoutResult(status->{
            db.execute("insert into users(id,status) values (?,'LEGACY_ANONYMOUS_UNCLAIMED'),(?,'LEGACY_ANONYMOUS_UNCLAIMED')",owner,member);
            db.execute("insert into rooms(id,name,owner_id) values (?,'registry',?)",room,owner);
            db.execute("insert into room_members(room_id,user_id) values (?,?),(?,?)",room,owner,room,member);
        });
        var boundary=new RoomMembershipBoundary();
        var fail=new AtomicBoolean();
        var loads=new AtomicInteger();
        var registry=new MembershipRegistry(db,boundary) {
            @Override protected Set<UUID> load(UUID id) {
                loads.incrementAndGet();
                if(fail.get()) throw new IllegalStateException("injected_reload_failure");
                return super.load(id);
            }
        };
        assertEquals(Set.of(owner,member),registry.snapshot(room));
        assertThrows(UnsupportedOperationException.class,()->registry.snapshot(room).clear());
        registry.require(room,member);
        assertEquals(1,loads.get());
        fail.set(true);
        boundary.mutate(room,()->tx.execute(status->{
            db.execute("delete from room_members where room_id=? and user_id=?",room,member);return null;
        }));
        assertEquals(0,registry.size());
        fail.set(false);
        assertThrows(ApiException.class,()->registry.require(room,member));
        assertEquals(Set.of(owner),registry.snapshot(room));
        assertEquals(3,loads.get());
        assertEquals(0,boundary.lockCount());
    }
    @Test void cacheIsBoundedAndSnapshotConsumerRunsUnderTheReadGate() {
        var boundary=new RoomMembershipBoundary();
        UUID member=UUID.randomUUID();
        var loads=new AtomicInteger();
        var registry=new MembershipRegistry(null,boundary) {
            @Override protected Set<UUID> load(UUID room) { loads.incrementAndGet();return Set.of(member); }
        };
        UUID oldest=UUID.randomUUID();registry.require(oldest,member);
        for(int index=0;index<10_000;index++) registry.require(UUID.randomUUID(),member);
        assertEquals(10_000,registry.size());
        int count=registry.authorized(oldest,member,members->{
            assertEquals(1,boundary.lockCount());return members.size();
        });
        assertEquals(1,count);
        assertEquals(10_002,loads.get());
        assertEquals(0,boundary.lockCount());
    }
}
