package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;
import app.sidey.server.auth.*;
import app.sidey.server.common.*;
import app.sidey.server.realtime.*;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
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
import org.springframework.core.env.Environment;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT, properties={
    "sidey.auth.jwt-secret=dGVzdC1vbmx5LW5vdC1wcm9kdWN0aW9uLWtleS0zMmJ5dGVz",
    "sidey.room.invite-pepper=dGVzdC1vbmx5LW5vdC1wcm9kdWN0aW9uLWtleS0zMmJ5dGVz",
    "sidey.deployment.key=test-deployment-control-key-at-least-32-bytes", "management.server.port=0"})
class DeploymentTest {
    private static final String KEY="test-deployment-control-key-at-least-32-bytes";
    @LocalServerPort int port;
    @Autowired Environment environment;
    @Autowired ServingState state;
    @Autowired DeploymentController deployment;
    @Autowired MembershipRegistry members;
    @Autowired ConnectionRegistry connections;
    @Autowired DSLContext db;
    @Autowired Transactions tx;
    @Autowired AccessTokens tokens;
    @Autowired ObjectMapper json;

    @Test void drainWaitsForCommittedWorkClosesSocketsAndRejectsNewWorkUntilActivation() throws Exception {
        UUID user=UUID.randomUUID(), sid=UUID.randomUUID(), room=UUID.randomUUID();
        tx.run(()->{
            db.execute("insert into users(id,status) values (?,'ACTIVE')",user);
            db.execute("insert into user_identities(user_id,provider,provider_subject) values (?,'GOOGLE',?)",user,user.toString());
            db.execute("insert into user_sessions(id,user_id,refresh_token_hash,created_at,last_refreshed_at,expires_at,absolute_expires_at,device_platform) values (?,?,?,now(),now(),now()+interval '30 days',now()+interval '180 days','OTHER')",sid,user,Crypto.hash(sid.toString()));
            db.execute("insert into rooms(id,name,owner_id) values (?,'drain',?)",room,user);
            db.execute("insert into room_members(room_id,user_id) values (?,?)",room,user);return null;
        });
        try(var http=HttpClient.newHttpClient()) {
            assertEquals(401,request(http,"POST","/internal/deployment/drain",false).statusCode());
            var listener=new WebSocketContractTest.Listener();
            var socket=http.newWebSocketBuilder().header("Authorization","Bearer "+tokens.issue(user,sid,Instant.now()))
                    .buildAsync(URI.create("ws://127.0.0.1:"+port+"/api/realtime"),listener).join();
            listener.next(json);
            members.require(room,user); assertTrue(members.size()>0);
            try(var admitted=state.enter()) {
                assertNotNull(admitted);
                var draining=http.sendAsync(builder("POST","/internal/deployment/drain",true).build(),HttpResponse.BodyHandlers.ofString());
                assertEquals(1012,listener.closed.get(5,TimeUnit.SECONDS));
                assertFalse(state.accepting()); assertFalse(draining.isDone());
                assertEquals(503,request(http,"POST","/api/auth/challenge",false).statusCode());
                assertNull(state.enter());
                admitted.close();
                assertEquals(200,draining.get(5,TimeUnit.SECONDS).statusCode());
            }
            assertEquals(0,connections.size());
            assertEquals(200,http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+environment.getRequiredProperty("local.management.port")+"/actuator/health/readiness")).GET().build(),HttpResponse.BodyHandlers.ofString()).statusCode());
            assertEquals(200,request(http,"POST","/internal/deployment/activate",true).statusCode());
            assertTrue(state.accepting()); assertEquals(0,members.size());
            assertEquals(200,request(http,"POST","/api/auth/challenge",false).statusCode());
            // A new authenticated connection reconstructs state after process switch.
            var restored=new WebSocketContractTest.Listener();
            var replacement=http.newWebSocketBuilder().header("Authorization","Bearer "+tokens.issue(user,sid,Instant.now()))
                    .buildAsync(URI.create("ws://127.0.0.1:"+port+"/api/realtime"),restored).join();
            assertEquals("connected",restored.next(json).path("type").asString());
            replacement.sendClose(1000,"test_finished").join();
        } finally {
            state.stopAccepting(); connections.closeAll(1012,"test_finished");
            assertTrue(state.awaitQuiescence(Duration.ofSeconds(5))); state.activate();
            tx.run(()->{db.execute("delete from rooms where id=?",room);db.execute("delete from users where id=?",user);return null;});
        }
    }

    @Test void prometheusIsOnlyExposedOnTheLoopbackManagementListener() throws Exception {
        try(var http=HttpClient.newHttpClient()) {
            assertTrue(request(http,"GET","/actuator/prometheus",false).statusCode()>=400);
            int management=environment.getRequiredProperty("local.management.port",Integer.class);
            var metrics=http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+management+"/actuator/prometheus")).GET().build(),HttpResponse.BodyHandlers.ofString());
            assertEquals(200,metrics.statusCode());
            for(String name:List.of("sidey_ws_connections","sidey_ws_subscriptions","sidey_presence_sessions","sidey_ws_queued_bytes","sidey_serving_accepting","hikaricp_connections")) assertTrue(metrics.body().contains(name),name);
            assertFalse(metrics.body().contains(KEY));
        }
    }

    @Test void inactiveMaintenanceCannotRevokeTheActiveInstancesSessions() {
        var inactive=new ServingState(false,new SimpleMeterRegistry());
        var auth=org.mockito.Mockito.mock(AuthService.class);
        var retention=org.mockito.Mockito.mock(app.sidey.server.message.Retention.class);
        var presence=org.mockito.Mockito.mock(PresenceService.class);
        var maintenance=new Maintenance(inactive,auth,retention,presence);
        maintenance.durable(); maintenance.presence();
        org.mockito.Mockito.verifyNoInteractions(auth,retention,presence);
        inactive.activate(); maintenance.durable(); maintenance.presence();
        org.mockito.Mockito.verify(auth).expireSessions(); org.mockito.Mockito.verify(retention).prune(); org.mockito.Mockito.verify(presence).tick();
    }

    private HttpRequest.Builder builder(String method,String path,boolean key) {
        var request=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+path)).timeout(Duration.ofSeconds(40))
                .method(method,HttpRequest.BodyPublishers.noBody());
        if(key)request.header("X-Sidey-Deployment-Key",KEY);
        return request;
    }
    private HttpResponse<String> request(HttpClient http,String method,String path,boolean key)throws Exception {
        return http.send(builder(method,path,key).build(),HttpResponse.BodyHandlers.ofString());
    }
}
