package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;
import app.sidey.server.message.MessageService;
import app.sidey.server.realtime.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;

class RecoveryTest extends PostgresTest {
    @Test void subscriptionBeforeCatchupMergesAllMessagesAcrossTheBoundary() {
        var f=new CoreFixture(db,tx);UUID user=f.user(),room=f.rooms.create(user,"복구방").room().id();
        Set<UUID> expected=new HashSet<>(),merged=new HashSet<>();
        for(int i=0;i<70;i++){UUID id=UUID.randomUUID();expected.add(id);db.execute("insert into messages(id,room_id,sender_id,body) values (?,?,?,'offline')",id,room,user);}
        var registry=new MembershipRegistry(db,f.boundary);
        var live=new ArrayList<MessageService.Message>();
        // Register authorized recipient before checkpoint, exactly as WS subscribe does.
        registry.authorized(room,user,members->true);
        var through=f.messages.checkpoint(user,room);
        var during=f.messages.send(user,room,UUID.randomUUID(),"during catchup");live.add(during);expected.add(during.id());
        MessageService.Cursor cursor=null;
        do{var page=f.messages.history(user,room,cursor,null,through,13);page.messages().forEach(m->merged.add(m.id()));cursor=page.nextCursor();}while(cursor!=null);
        live.forEach(m->merged.add(m.id()));live.forEach(m->merged.add(m.id()));
        assertEquals(expected,merged);
        var next=f.messages.history(user,room,through,null,100);
        assertEquals(List.of(during),next.messages());
    }
    @Test void checkpointWaitsForOlderUncommittedSendWithoutSerializingOtherSenders() throws Exception {
        var f=new CoreFixture(db,tx);UUID first=f.user(),second=f.user();var created=f.rooms.create(first,"순서방");UUID room=created.room().id();f.rooms.join(second,created.inviteCode());
        var staged=new CountDownLatch(1);var release=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(3)){
            var older=pool.submit(()->tx.execute(status->{
                var result=f.messages.send(first,room,UUID.randomUUID(),"older timestamp later commit");staged.countDown();
                try{assertTrue(release.await(10,TimeUnit.SECONDS));}catch(InterruptedException e){throw new RuntimeException(e);}return result;
            }));
            try {
                assertTrue(staged.await(5,TimeUnit.SECONDS));
                var newer=pool.submit(()->f.messages.send(second,room,UUID.randomUUID(),"newer timestamp first commit")).get(3,TimeUnit.SECONDS);
                var checkpoint=pool.submit(()->f.messages.checkpoint(first,room));
                assertThrows(TimeoutException.class,()->checkpoint.get(100,TimeUnit.MILLISECONDS));
                release.countDown();var old=older.get(5,TimeUnit.SECONDS);var through=checkpoint.get(5,TimeUnit.SECONDS);
                var page=f.messages.history(first,room,null,null,through,100);
                assertEquals(Set.of(old.id(),newer.id()),new HashSet<>(page.messages().stream().map(MessageService.Message::id).toList()));
                var next=f.messages.send(first,room,UUID.randomUUID(),"after checkpoint");
                assertTrue(next.createdAt().isAfter(through.createdAt()));
            } finally {release.countDown();}
        }
    }
}
