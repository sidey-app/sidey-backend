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
    @Test void publicChallengeAndProtectedRequests() throws Exception {
        var client=HttpClient.newHttpClient();
        var challenge=client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/auth/challenge"))
                .POST(HttpRequest.BodyPublishers.noBody()).build(),HttpResponse.BodyHandlers.ofString());
        assertEquals(200,challenge.statusCode());assertTrue(challenge.body().contains("nonce"));
        var protectedResponse=client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/rooms"))
                .GET().build(),HttpResponse.BodyHandlers.ofString());
        assertEquals(401,protectedResponse.statusCode());
    }
}
