package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;

import app.sidey.server.auth.AccessTokens;
import app.sidey.server.auth.AuthService;
import app.sidey.server.auth.verifier.IdentityVerifier;
import app.sidey.server.common.*;
import app.sidey.server.room.*;
import app.sidey.server.user.UserService;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;

class RoomTest extends PostgresTest {
    private RoomService service() {
        return fixture().rooms();
    }

    private record Fixture(RoomService rooms, UserService users) {}

    private Fixture fixture() {
        var secret = Base64.getEncoder().encodeToString(Crypto.hash("room-test-key-only"));
        var auth = new AuthService(db, new Transactions(tx),
                (provider, credential, nonce) -> new IdentityVerifier.VerifiedIdentity(provider, credential),
                credential -> { throw new ApiException(401, "legacy_proof_invalid"); },
                new AccessTokens(secret, "sidey", "sidey-api"), Clock.systemUTC(), event -> {});
        var coordination = new CoordinationLocks();
        var boundary = new RoomMembershipBoundary();
        var rooms = new RoomService(db, new Transactions(tx), auth, coordination,
                boundary, new InviteCodes(Base64.getEncoder().encodeToString(Crypto.hash("room-test-pepper"))), event -> {});
        return new Fixture(rooms, new UserService(db, new Transactions(tx), coordination, boundary, auth, event -> {}));
    }

    private UUID user() { return user(UUID.randomUUID()); }

    private UUID user(UUID id) {
        tx.executeWithoutResult(status -> {
            db.execute("insert into users(id,status) values (?,'ACTIVE')", id);
            db.execute("insert into user_identities(user_id,provider,provider_subject) values (?,'GOOGLE',?)", id, id.toString());
            db.execute("insert into profiles(id,nickname) values (?,'친구')", id);
        });
        return id;
    }

    private List<String> concurrently(List<Callable<String>> calls) throws Exception {
        var start = new CyclicBarrier(calls.size());
        try (var workers = Executors.newFixedThreadPool(calls.size())) {
            var futures = new ArrayList<Future<String>>();
            for (var call : calls) {
                futures.add(workers.submit(() -> {
                    start.await(10, TimeUnit.SECONDS);
                    try { return call.call(); }
                    catch (ApiException rejected) { return rejected.code(); }
                }));
            }
            var results = new ArrayList<String>();
            for (var future : futures) results.add(future.get(15, TimeUnit.SECONDS));
            return results;
        }
    }

    private int members(UUID room) {
        return db.fetchOne("select count(*) n from room_members where room_id=?", room).get("n", Integer.class);
    }

    private UUID owner(UUID room) {
        return db.fetchOne("select owner_id from rooms where id=?", room).get("owner_id", UUID.class);
    }

    private void assertOwnerMembership(UUID room) {
        assertNotNull(db.fetchOne("select 1 from rooms r join room_members m on m.room_id=r.id and m.user_id=r.owner_id where r.id=?", room));
    }

    @Test void concurrentJoinsCannotExceedTwelveMembers() throws Exception {
        var rooms = service();
        var created = rooms.create(user(), "친구방");
        UUID room = created.room().id();
        for (int i = 0; i < 9; i++) rooms.join(user(), created.inviteCode());
        var calls = new ArrayList<Callable<String>>();
        for (int i = 0; i < 10; i++) {
            UUID candidate = user();
            calls.add(() -> { rooms.join(candidate, created.inviteCode()); return "ok"; });
        }
        var results = concurrently(calls);
        assertEquals(2, Collections.frequency(results, "ok"), results.toString());
        assertEquals(8, Collections.frequency(results, "member_limit_reached"), results.toString());
        assertEquals(12, members(room));
        assertOwnerMembership(room);
    }

    @Test void concurrentJoinAndCreateCannotExceedFiveRoomsPerUser() throws Exception {
        var rooms = service();
        UUID actor = user();
        for (int i = 0; i < 4; i++) rooms.create(actor, "내방");
        var first = rooms.create(user(), "첫방");
        var second = rooms.create(user(), "다른방");
        var results = concurrently(List.of(
                () -> { rooms.join(actor, first.inviteCode()); return "ok"; },
                () -> { rooms.join(actor, second.inviteCode()); return "ok"; },
                () -> { rooms.create(actor, "새방"); return "ok"; }));
        assertEquals(1, Collections.frequency(results, "ok"), results.toString());
        assertEquals(2, Collections.frequency(results, "room_limit_reached"), results.toString());
        assertEquals(5, db.fetchOne("select count(*) n from room_members where user_id=?", actor).get("n", Integer.class));
    }

    @Test void ownerLeaveUsesEarliestJoinedThenUuidAndLastMemberDeletesRoom() {
        var rooms = service();
        UUID departing = user();
        UUID smaller = user(UUID.fromString("00000000-0000-4000-8000-000000000001"));
        UUID larger = user(UUID.fromString("00000000-0000-4000-8000-000000000002"));
        UUID later = user(UUID.fromString("00000000-0000-4000-8000-000000000003"));
        var created = rooms.create(departing, "순서방");
        UUID room = created.room().id();
        rooms.join(larger, created.inviteCode());
        rooms.join(smaller, created.inviteCode());
        rooms.join(later, created.inviteCode());
        db.execute("update room_members set joined_at='2026-01-01T00:00:00Z' where room_id=? and user_id in (?,?)", room, smaller, larger);
        db.execute("update room_members set joined_at='2026-01-02T00:00:00Z' where room_id=? and user_id=?", room, later);
        assertEquals(smaller, rooms.leave(departing, room));
        assertEquals(smaller, owner(room));
        assertOwnerMembership(room);
        assertEquals(larger, rooms.leave(smaller, room));
        assertEquals(later, rooms.leave(larger, room));
        rooms.leave(later, room);
        assertNull(db.fetchOne("select 1 from rooms where id=?", room));
        assertEquals(0, members(room));
        assertNull(db.fetchOne("select 1 from room_invites where room_id=?", room));
    }

    @Test void ownerCannotKickSelf() {
        var rooms = service();
        UUID actor = user();
        UUID room = rooms.create(actor, "안전방").room().id();
        assertEquals("owner_must_leave", assertThrows(ApiException.class, () -> rooms.kick(actor, room, actor)).code());
        assertEquals(actor, owner(room));
        assertEquals(1, members(room));
        assertOwnerMembership(room);
    }

    @Test void ownerLeaveRacingRenameOrKickNeverLeavesOwnerlessRoom() throws Exception {
        var rooms = service();
        for (int i = 0; i < 6; i++) {
            UUID actor = user();
            UUID successor = user();
            var created = rooms.create(actor, "경쟁방");
            UUID room = created.room().id();
            rooms.join(successor, created.inviteCode());
            final boolean rename = i % 2 == 0;
            var results = concurrently(List.of(
                    () -> { rooms.leave(actor, room); return "left"; },
                    () -> {
                        if (rename) rooms.rename(actor, room, "바뀐방");
                        else rooms.kick(actor, room, successor);
                        return "changed";
                    }));
            assertTrue(results.contains("left"), results.toString());
            assertTrue(results.contains("changed") || results.contains("owner_required"), results.toString());
            if (db.fetchOne("select 1 from rooms where id=?", room) != null) {
                assertEquals(successor, owner(room));
                assertEquals(1, members(room));
                assertOwnerMembership(room);
            } else {
                assertFalse(rename, "Rename cannot remove the remaining member");
                assertEquals(0, members(room));
            }
        }
    }

    @Test void accountDeletionRacingJoinAndCreateLeavesNoUserLinksOrOwnerlessRoom() throws Exception {
        for (int i = 0; i < 4; i++) {
            var fixture = fixture();
            var rooms = fixture.rooms();
            UUID deleting = user();
            UUID survivor = user();
            var owned = rooms.create(deleting, "所有방");
            rooms.join(survivor, owned.inviteCode());
            var target = rooms.create(user(), "가입방");
            var results = concurrently(List.of(
                    () -> { fixture.users().delete(deleting); return "deleted"; },
                    () -> { rooms.join(deleting, target.inviteCode()); return "joined"; },
                    () -> { rooms.create(deleting, "동시방"); return "created"; }));
            assertTrue(results.contains("deleted"), results.toString());
            assertNull(db.fetchOne("select 1 from users where id=?", deleting));
            assertNull(db.fetchOne("select 1 from profiles where id=?", deleting));
            assertEquals(0, db.fetchOne("select count(*) n from room_members where user_id=?", deleting).get("n", Integer.class));
            assertEquals(0, db.fetchOne("select count(*) n from rooms where owner_id=?", deleting).get("n", Integer.class));
            assertEquals(survivor, owner(owned.room().id()));
            assertOwnerMembership(owned.room().id());
            assertOwnerMembership(target.room().id());
            assertEquals(0, db.fetchOne("select count(*) n from rooms r where not exists (select 1 from room_members m where m.room_id=r.id and m.user_id=r.owner_id)").get("n", Integer.class));
        }
    }
}
