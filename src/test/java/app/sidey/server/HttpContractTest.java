package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;
import java.net.URI;
import java.net.http.*;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,properties={
        "sidey.auth.jwt-secret=dGVzdC1vbmx5LW5vdC1wcm9kdWN0aW9uLWtleS0zMmJ5dGVz",
        "sidey.room.invite-pepper=dGVzdC1vbmx5LW5vdC1wcm9kdWN0aW9uLWtleS0zMmJ5dGVz",
        "management.server.port=0"})
class HttpContractTest {
    @LocalServerPort int port;
    @Test void checkoutCorsIsRestrictedAndTokenCompletionNeedsNoServiceSession() throws Exception {
        try (var client = HttpClient.newHttpClient()) {
            URI endpoint = URI.create("http://127.0.0.1:" + port + "/api/commerce/complete");
            var preflight = client.send(HttpRequest.newBuilder(endpoint)
                    .header("Origin", "https://sidey-app.github.io")
                    .header("Access-Control-Request-Method", "POST")
                    .header("Access-Control-Request-Headers", "content-type")
                    .method("OPTIONS", HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString());
            assertEquals(200, preflight.statusCode());
            assertEquals("https://sidey-app.github.io", preflight.headers().firstValue("Access-Control-Allow-Origin").orElseThrow());
            var foreign = client.send(HttpRequest.newBuilder(endpoint)
                    .header("Origin", "https://untrusted.example")
                    .header("Access-Control-Request-Method", "POST")
                    .method("OPTIONS", HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString());
            assertEquals(403, foreign.statusCode());
            assertTrue(foreign.headers().firstValue("Access-Control-Allow-Origin").isEmpty());
            var invalid = client.send(HttpRequest.newBuilder(endpoint)
                    .header("Origin", "https://sidey-app.github.io").header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString("{\"token\":\"invalid\",\"paymentId\":\"sidey-invalid\"}"))
                    .build(), HttpResponse.BodyHandlers.ofString());
            assertEquals(400, invalid.statusCode());
            assertTrue(invalid.body().contains("invalid_checkout_token"));
            assertTrue(invalid.headers().firstValue("Cache-Control").orElse("").contains("no-store"));
        }
    }
    @Test void publicChallengeAndProtectedRequests() throws Exception {
        var client=HttpClient.newHttpClient();
        var challenge=client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/auth/challenge"))
                .POST(HttpRequest.BodyPublishers.noBody()).build(),HttpResponse.BodyHandlers.ofString());
        assertEquals(200,challenge.statusCode());assertTrue(challenge.body().contains("nonce"));
        var protectedResponse=client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/rooms"))
                .GET().build(),HttpResponse.BodyHandlers.ofString());
        assertEquals(401,protectedResponse.statusCode());
        var oversized=client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/auth/login")).header("Content-Type","application/json")
                .POST(HttpRequest.BodyPublishers.ofString("x".repeat(262145))).build(),HttpResponse.BodyHandlers.ofString());assertEquals(413,oversized.statusCode());
        var ops=client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/internal/commerce/refund")).header("Content-Type","application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{}")).build(),HttpResponse.BodyHandlers.ofString());assertEquals(401,ops.statusCode());assertTrue(ops.body().contains("operations_authentication_required"));
    }
}
