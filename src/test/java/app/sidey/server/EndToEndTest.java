package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;
import app.sidey.server.auth.AccessTokens;
import app.sidey.server.auth.verifier.*;
import app.sidey.server.commerce.PaymentProvider;
import app.sidey.server.common.*;
import app.sidey.server.realtime.ConnectionRegistry;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.sql.DriverManager;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Predicate;
import org.jooq.DSLContext;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.*;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.*;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.*;
import tools.jackson.databind.*;

/** Real HTTP, JWT, WS and PostgreSQL; only external identity/payment proofs are doubles. */
@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT, properties={
    "sidey.auth.jwt-secret=dGVzdC1vbmx5LW5vdC1wcm9kdWN0aW9uLWtleS0zMmJ5dGVz",
    "sidey.room.invite-pepper=dGVzdC1vbmx5LW5vdC1wcm9kdWN0aW9uLWtleS0zMmJ5dGVz",
    "management.server.port=0"})
@Import(EndToEndTest.Providers.class)
@DirtiesContext
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class EndToEndTest {
    static final String SCHEMA="e2e_"+UUID.randomUUID().toString().replace("-","");
    static final String DB_URL=System.getenv().getOrDefault("SIDEY_TEST_DATABASE_URL","jdbc:postgresql://127.0.0.1:55432/sidey");
    static final String DB_USER=System.getenv().getOrDefault("SIDEY_TEST_DATABASE_USER","sidey");
    static final String DB_PASSWORD=System.getenv().getOrDefault("SIDEY_TEST_DATABASE_PASSWORD","");
    static final Map<String,UUID> LEGACY=new ConcurrentHashMap<>();
    @DynamicPropertySource static void database(DynamicPropertyRegistry properties) throws Exception {
        try(var connection=DriverManager.getConnection(DB_URL,DB_USER,DB_PASSWORD);var statement=connection.createStatement()) {
            statement.execute("create schema "+SCHEMA);
        }
        properties.add("spring.datasource.url",()->DB_URL+(DB_URL.contains("?")?"&":"?")+"currentSchema="+SCHEMA);
        properties.add("spring.datasource.username",()->DB_USER);
        properties.add("spring.datasource.password",()->DB_PASSWORD);
        properties.add("spring.flyway.schemas",()->SCHEMA);
        properties.add("spring.flyway.default-schema",()->SCHEMA);
    }
    @TestConfiguration(proxyBeanMethods=false)
    static class Providers {
        @Bean @Primary IdentityVerifier identity() {
            return (provider,proof,nonce)->{
                if(proof==null || !proof.startsWith("fixture-proof:"))throw new ApiException(401,"invalid_provider_proof");
                return new IdentityVerifier.VerifiedIdentity(provider,proof.substring("fixture-proof:".length()));
            };
        }
        @Bean @Primary LegacyCredentialVerifier legacy() {
            return proof->{UUID id=LEGACY.get(proof);if(id==null)throw new ApiException(401,"legacy_proof_invalid");return id;};
        }
        @Bean @Primary CommerceTest.Provider payment(){return new CommerceTest.Provider();}
    }
    @LocalServerPort int port;
    @Autowired DSLContext db;
    @Autowired Transactions tx;
    @Autowired ObjectMapper json;
    @Autowired AccessTokens tokens;
    @Autowired ServingState serving;
    @Autowired ConnectionRegistry connections;
    @Autowired CommerceTest.Provider provider;
    final HttpClient http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();

    @AfterAll void cleanup() throws Exception {
        serving.stopAccepting();connections.closeAll(1012,"test_finished");
        assertTrue(serving.awaitQuiescence(Duration.ofSeconds(5)));http.close();
        try(var connection=DriverManager.getConnection(DB_URL,DB_USER,DB_PASSWORD);var statement=connection.createStatement()) {
            statement.execute("drop schema "+SCHEMA+" cascade");
        }
        LEGACY.clear();
    }

    @Test void completeServiceJourneyPreservesIdentityMessagesPresenceOwnershipAndProviderTruth() throws Exception {
        JsonNode a=login("friend-a","MACOS"), b=login("friend-b","WINDOWS");
        String userA=a.path("userId").asString(), userB=b.path("userId").asString();
        String oldRefresh=a.path("refreshToken").asString();
        a=call("POST","/auth/refresh",null,Map.of("refreshToken",oldRefresh),200);
        assertEquals(userA,a.path("userId").asString());assertNotEquals(oldRefresh,a.path("refreshToken").asString());
        call("PUT","/profile",token(a),Map.of("nickname","친구 A","characterId","pixel_hamster"),200);
        call("PUT","/profile",token(b),Map.of("nickname","친구 B","characterId","pixel_cat"),200);

        UUID legacy=UUID.randomUUID();String legacyProof=Crypto.token();LEGACY.put(legacyProof,legacy);
        tx.run(()->{db.execute("insert into users(id,status) values (?,'LEGACY_ANONYMOUS_UNCLAIMED')",legacy);return null;});
        call("GET","/rooms",tokens.issue(legacy,UUID.randomUUID(),Instant.now()),null,401);
        String nonce=call("POST","/auth/challenge",null,null,200).path("nonce").asString();
        call("POST","/auth/legacy-claim",null,Map.of("provider","GOOGLE","credential","fixture-proof:friend-c","nonce",nonce,"platform","MACOS","legacyCredential",legacy.toString()),401);
        nonce=call("POST","/auth/challenge",null,null,200).path("nonce").asString();
        JsonNode c=call("POST","/auth/legacy-claim",null,Map.of("provider","GOOGLE","credential","fixture-proof:friend-c","nonce",nonce,"platform","MACOS","legacyCredential",legacyProof),200);
        assertEquals(legacy.toString(),c.path("userId").asString());
        call("PUT","/profile",token(c),Map.of("nickname","기존 친구","characterId","pixel_hamster"),200);

        JsonNode created=call("POST","/rooms",token(a),Map.of("name","우리 방"),200);
        String room=created.path("room").path("id").asString(), invite=created.path("inviteCode").asString();
        call("POST","/rooms/join",token(b),Map.of("inviteCode",invite),200);
        call("POST","/rooms/join",token(c),Map.of("inviteCode",invite),200);
        try(var mac=socket(a);var windows=socket(b);var secondDevice=socket(login("friend-a","WINDOWS"))) {
            mac.subscribe(room);windows.subscribe(room);secondDevice.subscribe(room);
            mac.send(Map.of("type","presence.update","activeRoomId",room,"activity","ONLINE"));
            secondDevice.send(Map.of("type","presence.update","activeRoomId",room,"activity","AWAY"));
            windows.send(Map.of("type","presence.snapshot","roomId",room));
            windows.until(event->event.path("type").asString().equals("presence") && event.path("members").path(userA).asString().equals("ONLINE"));
            windows.send(Map.of("type","typing","roomId",room,"active",true));
            JsonNode typing=mac.untilType("typing");assertEquals(userB,typing.path("userId").asString());assertTrue(typing.path("active").asBoolean());

            String id1=UUID.randomUUID().toString();JsonNode first=mac.message(room,id1,"안녕");
            windows.until(event->isMessage(event,id1));
            mac.close();awaitConnections(2);
            windows.send(Map.of("type","presence.snapshot","roomId",room));
            windows.until(event->event.path("type").asString().equals("presence") && event.path("members").path(userA).asString().equals("AWAY"));
            String id2=UUID.randomUUID().toString();windows.message(room,id2,"접속이 끊긴 동안");
            try(var reconnected=socket(a)) {
                JsonNode through=reconnected.subscribe(room).path("recoveryThrough");assertEquals(id2,through.path("id").asString());
                String id3=UUID.randomUUID().toString();windows.message(room,id3,"복구 중 실시간 메시지");
                JsonNode live=reconnected.until(event->isMessage(event,id3)).path("message");
                Map<String,JsonNode> merged=new HashMap<>();merged.put(id1,first);merged.put(id3,live);
                JsonNode cursor=first;
                do {
                    JsonNode page=call("GET","/rooms/"+room+"/messages?limit=1"+cursor("after",cursor)+cursor("through",through),token(a),null,200);
                    page.path("messages").forEach(message->merged.put(message.path("id").asString(),message));
                    cursor=page.path("nextCursor");
                } while(!cursor.isNull());
                assertEquals(Set.of(id1,id2,id3),merged.keySet());
                assertEquals(first,reconnected.message(room,id1,"안녕"));
                reconnected.send(Map.of("type","message.send","roomId",room,"id",id1,"body","변경된 본문","requestId","conflict"));
                assertEquals("message_id_conflict",reconnected.untilType("error").path("code").asString());

                // Receiver proves the commit; the sender discards its ACK and disconnects.
                String lost=UUID.randomUUID().toString();
                reconnected.send(Map.of("type","message.send","roomId",room,"id",lost,"body","응답 유실","requestId","lost"));
                JsonNode canonical=windows.until(event->isMessage(event,lost)).path("message");
                reconnected.close();
                try(var retry=socket(a)) {
                    retry.subscribe(room);assertEquals(canonical,retry.message(room,lost,"응답 유실"));
                    assertEquals(canonical,call("GET","/rooms/"+room+"/messages/"+lost,token(a),null,200));
                }
                assertEquals(4,db.fetchOne("select count(*) from messages where room_id=?",UUID.fromString(room)).get(0,Integer.class));
            }

            verifyCommerce(a);
            assertEquals(userB,call("POST","/rooms/"+room+"/leave",token(a),null,200).path("successorId").asString());
            assertEquals(userB,call("GET","/rooms/"+room,token(b),null,200).path("ownerId").asString());
            try(var removed=socket(c)) {
                removed.subscribe(room);
                call("DELETE","/rooms/"+room+"/members/"+legacy,token(b),null,200);
                removed.send(Map.of("type","typing","roomId",room,"active",true));
                assertEquals("membership_required",removed.untilType("error").path("code").asString());
                call("GET","/rooms/"+room+"/messages",token(c),null,403);
            }
            call("POST","/rooms/join",token(c),Map.of("inviteCode",invite),200);
            call("DELETE","/account",token(b),null,204);
            assertEquals(1008,windows.listener.closed.get(5,TimeUnit.SECONDS));
            assertEquals(legacy.toString(),call("GET","/rooms/"+room,token(c),null,200).path("ownerId").asString());
            call("POST","/auth/logout-all",token(a),null,200);
            assertEquals(1008,secondDevice.listener.closed.get(5,TimeUnit.SECONDS));
            call("GET","/rooms",token(a),null,401);
            call("POST","/auth/refresh",null,Map.of("refreshToken",a.path("refreshToken").asString()),401);
        }
    }

    private void verifyCommerce(JsonNode session)throws Exception {
        tx.run(()->{db.execute("insert into commerce_runtime_settings(singleton,sales_enabled,payment_environment,policy_version,policy_notice) values (true,true,'test','e2e-v1',repeat('notice ',20)) on conflict(singleton) do update set sales_enabled=true,payment_environment='test',policy_version='e2e-v1',policy_notice=repeat('notice ',20)");return null;});
        JsonNode order=call("POST","/commerce/orders",token(session),Map.of("productId","character_tree","amount",1,"success",true),200);
        String checkout=order.path("checkoutToken").asString();
        JsonNode prepared=call("POST","/commerce/checkout",null,Map.of("token",checkout,"action","prepare"),200);
        assertTrue(prepared.path("amount").asLong()>1);assertTrue(prepared.path("requiresConsent").asBoolean());
        JsonNode authorized=call("POST","/commerce/checkout",null,Map.of("token",checkout,"action","authorize","policyVersion","e2e-v1"),200);
        String paymentId=authorized.path("paymentId").asString();
        var payment=new PaymentProvider.Payment(paymentId,"PAID",provider.storeId(),provider.channelKey(),"TEST","V2","verified-e2e",prepared.path("amount").asLong(),0,"KRW","PaymentMethodEasyPay");
        provider.payments.put(paymentId,new PaymentProvider.Payment(payment.id(),"PAID",payment.storeId(),payment.channelKey(),"TEST","V2",payment.transactionId(),1,0,"KRW",payment.method()));
        call("POST","/commerce/complete",null,Map.of("token",checkout,"paymentId",paymentId),409);
        assertTrue(call("GET","/commerce/entitlements",token(session),null,200).isEmpty());
        provider.payments.put(paymentId,payment);
        assertTrue(call("POST","/commerce/complete",null,Map.of("token",checkout,"paymentId",paymentId),200).path("completed").asBoolean());
        JsonNode entitlements=call("GET","/commerce/entitlements",token(session),null,200);
        assertTrue(entitlements.toString().contains("character:pixel_tree"));assertTrue(entitlements.toString().contains("active"));
        assertTrue(provider.queries.get()>=2);
    }

    private JsonNode login(String subject,String platform)throws Exception {
        String nonce=call("POST","/auth/challenge",null,null,200).path("nonce").asString();
        return call("POST","/auth/login",null,Map.of("provider","GOOGLE","credential","fixture-proof:"+subject,"nonce",nonce,"platform",platform),200);
    }
    private String token(JsonNode session){return session.path("accessToken").asString();}
    private String cursor(String prefix,JsonNode value){return "&"+prefix+"CreatedAt="+URLEncoder.encode(value.path("createdAt").asString(),StandardCharsets.UTF_8)+"&"+prefix+"Id="+value.path("id").asString();}
    private JsonNode call(String method,String path,String token,Object body,int expected)throws Exception {
        var request=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api"+path)).timeout(Duration.ofSeconds(10)).header("Content-Type","application/json")
                .method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        if(token!=null)request.header("Authorization","Bearer "+token);
        var response=http.send(request.build(),HttpResponse.BodyHandlers.ofString());
        assertEquals(expected,response.statusCode(),method+" "+path+" "+response.body());
        return response.body().isEmpty()?json.nullNode():json.readTree(response.body());
    }
    private boolean isMessage(JsonNode event,String id){return "message.created".equals(event.path("type").asString()) && id.equals(event.path("message").path("id").asString());}
    private void awaitConnections(int count)throws Exception {
        long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
        while(connections.size()!=count && System.nanoTime()<end)Thread.sleep(10);
        assertEquals(count,connections.size());
    }
    private Socket socket(JsonNode session)throws Exception {return new Socket(token(session));}
    class Socket implements AutoCloseable {
        final WebSocketContractTest.Listener listener=new WebSocketContractTest.Listener();
        final WebSocket socket;
        Socket(String token)throws Exception {
            socket=http.newWebSocketBuilder().header("Authorization","Bearer "+token).buildAsync(URI.create("ws://127.0.0.1:"+port+"/api/realtime"),listener).join();
            untilType("connected");
        }
        void send(Object body){socket.sendText(json.writeValueAsString(body),true).join();}
        JsonNode subscribe(String room)throws Exception {send(Map.of("type","subscribe","roomId",room,"requestId","subscribe"));return untilType("ack");}
        JsonNode message(String room,String id,String body)throws Exception {send(Map.of("type","message.send","roomId",room,"id",id,"body",body,"requestId",id));return untilType("message.ack").path("message");}
        JsonNode untilType(String type)throws Exception {return until(event->type.equals(event.path("type").asString()));}
        JsonNode until(Predicate<JsonNode> predicate)throws Exception {
            long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
            while(System.nanoTime()<end){String frame=listener.frames.poll(100,TimeUnit.MILLISECONDS);if(frame!=null){JsonNode event=json.readTree(frame);if(predicate.test(event))return event;}}
            throw new AssertionError("Expected realtime event not received");
        }
        @Override public void close(){socket.abort();}
    }
}
