package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;
import app.sidey.server.common.ApiException;
import app.sidey.server.message.*;
import java.time.OffsetDateTime;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;

class MessageTest extends PostgresTest {
    @Test void concurrentSameUuidReturnsOneCanonicalSnapshotAndDifferentPayloadConflicts() throws Exception {
        var f=new CoreFixture(db,tx);UUID user=f.user(),room=f.rooms.create(user,"멱등방").room().id(),id=UUID.randomUUID();
        try(var pool=Executors.newFixedThreadPool(10)){
            var start=new CyclicBarrier(10);var results=new ArrayList<Future<MessageService.Message>>();
            for(int i=0;i<10;i++)results.add(pool.submit(()->{start.await();return f.messages.send(user,room,id," hello ");}));
            var canonical=results.getFirst().get(10,TimeUnit.SECONDS);
            for(var future:results)assertEquals(canonical,future.get(10,TimeUnit.SECONDS));
        }
        assertEquals(1,db.fetchOne("select count(*) from messages where id=?",id).get(0,Integer.class));
        assertEquals(1,db.fetchOne("select count(*) from message_attempts where user_id=?",user).get(0,Integer.class));
        assertEquals("message_id_conflict",assertThrows(ApiException.class,()->f.messages.send(user,room,id,"different")).code());
        assertEquals("hello",f.messages.get(user,room,id).body());
    }
    @Test void senderFirstBlocksKickUntilCommitButNotOtherSenders() throws Exception {
        var f=new CoreFixture(db,tx);UUID owner=f.user(),sender=f.user();var created=f.rooms.create(owner,"경쟁방");UUID room=created.room().id();f.rooms.join(sender,created.inviteCode());
        var inserted=new CountDownLatch(1);var commit=new CountDownLatch(1);var kicking=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(3)){
            var send=pool.submit(()->tx.execute(status->{
                var message=f.messages.send(sender,room,UUID.randomUUID(),"before revoke");inserted.countDown();
                try{assertTrue(commit.await(10,TimeUnit.SECONDS));}catch(InterruptedException e){throw new RuntimeException(e);}return message;
            }));
            try {
                assertTrue(inserted.await(5,TimeUnit.SECONDS));
                var kick=pool.submit(()->{kicking.countDown();f.rooms.kick(owner,room,sender);});
                assertTrue(kicking.await(5,TimeUnit.SECONDS));
                // This send must not wait for a room-wide exclusive message lock.
                var other=pool.submit(()->f.messages.send(owner,room,UUID.randomUUID(),"other member"));
                assertNotNull(other.get(3,TimeUnit.SECONDS));
                assertFalse(kick.isDone());commit.countDown();
                assertNotNull(send.get(5,TimeUnit.SECONDS));kick.get(5,TimeUnit.SECONDS);
            } finally {commit.countDown();}
        }
        assertEquals("membership_required",assertThrows(ApiException.class,()->f.messages.send(sender,room,UUID.randomUUID(),"after revoke")).code());
        assertEquals(2,db.fetchOne("select count(*) from messages where room_id=?",room).get(0,Integer.class));
    }
    @Test void failedTransactionDoesNotCommitAndRetryAfterLostResponseRecovers() {
        var f=new CoreFixture(db,tx);UUID user=f.user(),room=f.rooms.create(user,"재시도").room().id(),id=UUID.randomUUID();
        tx.executeWithoutResult(status->{f.messages.send(user,room,id,"retry");status.setRollbackOnly();});
        assertNull(db.fetchOne("select 1 from messages where id=?",id));
        var committed=f.messages.send(user,room,id,"retry");
        assertEquals(committed,f.messages.send(user,room,id,"retry"));
    }
    @Test void paginationHasStableUuidTieBreakRetentionAndMembershipBoundary() {
        var f=new CoreFixture(db,tx);UUID user=f.user(),room=f.rooms.create(user,"기록방").room().id();
        OffsetDateTime time=OffsetDateTime.now().minusHours(1);var expected=new TreeSet<String>();
        for(int i=0;i<125;i++){UUID id=UUID.randomUUID();expected.add(id.toString());db.execute("insert into messages(id,room_id,sender_id,body,created_at) values (?,?,?,'history',?)",id,room,user,java.sql.Timestamp.from(time.toInstant()));}
        db.execute("insert into messages(id,room_id,sender_id,body,created_at) values (?,?,?,'expired',now()-interval '4 days')",UUID.randomUUID(),room,user);
        var found=new ArrayList<String>();MessageService.Cursor after=null;
        do{var page=f.messages.history(user,room,after,null,17);found.addAll(page.messages().stream().map(m->m.id().toString()).toList());after=page.nextCursor();}while(after!=null);
        assertEquals(new ArrayList<>(expected),found);
        assertEquals("membership_required",assertThrows(ApiException.class,()->f.messages.history(f.user(),room,null,null,100)).code());
        new Retention(db,f.tx,event->{}).prune();
        assertEquals(125,db.fetchOne("select count(*) from messages where room_id=?",room).get(0,Integer.class));
    }
    @Test void newSendsAreLimitedButCommittedRetriesRemainFree() {
        var f=new CoreFixture(db,tx);UUID user=f.user(),room=f.rooms.create(user,"제한방").room().id();
        var first=f.messages.send(user,room,UUID.randomUUID(),"first");
        for(int i=1;i<30;i++)f.messages.send(user,room,UUID.randomUUID(),"new");
        assertEquals("message_rate_limited",assertThrows(ApiException.class,()->f.messages.send(user,room,UUID.randomUUID(),"over")).code());
        assertEquals(first,f.messages.send(user,room,first.id(),"first"));
    }
}
