package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;
import app.sidey.server.auth.*;
import app.sidey.server.common.*;
import app.sidey.server.realtime.*;
import java.net.URI;
import java.net.http.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.jooq.DSLContext;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import tools.jackson.databind.*;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,properties={
    "sidey.auth.jwt-secret=dGVzdC1vbmx5LW5vdC1wcm9kdWN0aW9uLWtleS0zMmJ5dGVz",
    "sidey.room.invite-pepper=dGVzdC1vbmx5LW5vdC1wcm9kdWN0aW9uLWtleS0zMmJ5dGVz",
    "management.server.port=0"})
class WebSocketContractTest {
    @LocalServerPort int port;
    @Autowired DSLContext db;
    @Autowired Transactions tx;
    @Autowired AccessTokens tokens;
    @Autowired AuthService auth;
    @Autowired ConnectionRegistry connections;
    @Autowired ObjectMapper json;
    static class Listener implements WebSocket.Listener {
        final BlockingQueue<String> frames=new LinkedBlockingQueue<>();
        final CompletableFuture<Integer> closed=new CompletableFuture<>();
        final StringBuilder partial=new StringBuilder();
        public void onOpen(WebSocket socket){socket.request(1);}
        public CompletionStage<?> onText(WebSocket socket,CharSequence data,boolean last){
            partial.append(data);if(last){frames.add(partial.toString());partial.setLength(0);}socket.request(1);return null;
        }
        public CompletionStage<?> onClose(WebSocket socket,int code,String reason){closed.complete(code);return null;}
        JsonNode next(ObjectMapper json) throws Exception {String value=frames.poll(5,TimeUnit.SECONDS);assertNotNull(value);return json.readTree(value);}
    }
    @Test void authenticatedSubscriptionRejectsNonmemberAndLogoutClosesExistingSocket() throws Exception {
        UUID user=UUID.randomUUID(),sid=UUID.randomUUID(),room=UUID.randomUUID();
        tx.run(()->{
            db.execute("insert into users(id,status) values (?,'ACTIVE')",user);
            db.execute("insert into user_identities(user_id,provider,provider_subject) values (?,'GOOGLE',?)",user,user.toString());
            db.execute("insert into user_sessions(id,user_id,refresh_token_hash,created_at,last_refreshed_at,expires_at,absolute_expires_at,device_platform) values (?,?,?,now(),now(),now()+interval '30 days',now()+interval '180 days','OTHER')",sid,user,Crypto.hash(sid.toString()));
            db.execute("insert into rooms(id,name,owner_id) values (?,'socket',?)",room,user);
            db.execute("insert into room_members(room_id,user_id) values (?,?)",room,user);return null;
        });
        try(var http=HttpClient.newHttpClient()) {
            URI uri=URI.create("ws://127.0.0.1:"+port+"/api/realtime");
            assertThrows(CompletionException.class,()->http.newWebSocketBuilder().buildAsync(uri,new Listener()).join());
            assertThrows(CompletionException.class,()->http.newWebSocketBuilder().header("Authorization","Bearer "+tokens.issue(user,sid,Instant.now().minusSeconds(1800))).buildAsync(uri,new Listener()).join());
            var listener=new Listener();
            WebSocket socket=http.newWebSocketBuilder().header("Authorization","Bearer "+tokens.issue(user,sid,Instant.now())).buildAsync(uri,listener).join();
            String connection=listener.next(json).get("connectionId").asString();
            socket.sendText("{\"type\":\"subscribe\",\"requestId\":\"first\",\"roomId\":\""+room+"\"}",true).join();
            assertEquals("ack",listener.next(json).get("type").asString());
            assertTrue(connections.subscriptions(connection).contains(room));
            socket.sendText("{\"type\":\"subscribe\",\"roomId\":\""+UUID.randomUUID()+"\"}",true).join();
            assertEquals("membership_required",listener.next(json).get("code").asString());
            socket.sendText("{\"type\":\"ping\"}",true).join();
            assertEquals("pong",listener.next(json).get("type").asString());
            UUID messageId=UUID.randomUUID();
            String send="{\"type\":\"message.send\",\"requestId\":\"send\",\"roomId\":\""+room+"\",\"id\":\""+messageId+"\",\"body\":\"hello\"}";
            socket.sendText(send,true).join();
            JsonNode ack=listener.next(json);
            assertEquals("message.ack",ack.get("type").asString());
            assertEquals(messageId.toString(),ack.get("message").get("id").asString());
            assertEquals("message.created",listener.next(json).get("type").asString());
            socket.sendText(send,true).join();
            assertEquals(ack.get("message"),listener.next(json).get("message"));
            assertEquals("message.created",listener.next(json).get("type").asString());
            assertEquals(1,db.fetchOne("select count(*) from messages where id=?",messageId).get(0,Integer.class));
            auth.logout(sid);
            assertEquals(1008,listener.closed.get(5,TimeUnit.SECONDS));
            assertThrows(ApiException.class,()->connections.user(connection));
        } finally {
            tx.run(()->{db.execute("delete from rooms where id=?",room);db.execute("delete from users where id=?",user);return null;});
        }
    }
}
