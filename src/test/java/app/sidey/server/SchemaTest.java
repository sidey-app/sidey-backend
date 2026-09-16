package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class SchemaTest extends PostgresTest {
    @Test
    void ownerMustBeMemberAtCommit() {
        var user = UUID.randomUUID();
        tx.executeWithoutResult(s -> {
            db.execute("insert into users(id,status) values (?, 'ACTIVE')", user);
            db.execute("insert into user_identities values (?, 'GOOGLE', ?, now())", user,user.toString());
        });
        assertThrows(Exception.class, () -> db.execute(
                "insert into rooms(id,name,owner_id) values (?, 'room', ?)", UUID.randomUUID(), user));
        tx.executeWithoutResult(s -> {
            var room = UUID.randomUUID();
            db.execute("insert into rooms(id,name,owner_id) values (?, 'room', ?)", room, user);
            db.execute("insert into room_members(room_id,user_id) values (?,?)", room, user);
        });
    }

    @Test
    void providerSubjectsCannotBelongToTwoUsers() {
        var a = UUID.randomUUID(); var b = UUID.randomUUID();
        tx.executeWithoutResult(s -> {
            db.execute("insert into users(id,status) values (?, 'ACTIVE'), (?, 'LEGACY_ANONYMOUS_UNCLAIMED')", a,b);
            db.execute("insert into user_identities values (?, 'GOOGLE', 'unique-subject', now())", a);
        });
        assertThrows(Exception.class, () -> db.execute(
                "insert into user_identities values (?, 'GOOGLE', 'unique-subject', now())", b));
    }
}
