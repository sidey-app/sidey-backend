package app.sidey.server.auth.verifier;

import static org.junit.jupiter.api.Assertions.*;
import app.sidey.server.common.ApiException;
import org.junit.jupiter.api.Test;

class LegacyCredentialVerifierTest {
    @Test void refusesArbitraryOrigins() {
        for(String origin:new String[]{"http://project.supabase.co","https://attacker.example",
                "https://project.supabase.co.attacker.example","https://project.supabase.co/path",
                "https://user@project.supabase.co","https://project.supabase.co?secret=x"})
            assertThrows(IllegalArgumentException.class,()->SupabaseLegacyCredentialVerifier.endpoint(origin));
        assertEquals("https://project.supabase.co/auth/v1/user",
                SupabaseLegacyCredentialVerifier.endpoint("https://project.supabase.co").toString());
    }
    @Test void uuidDoesNotProveOwnershipAndEmptyConfigFailsClosed() {
        var configured=new SupabaseLegacyCredentialVerifier("https://project.supabase.co","public-key");
        assertThrows(ApiException.class,()->configured.verify("61000000-0000-0000-0000-000000000001"));
        var disabled=new SupabaseLegacyCredentialVerifier("","");
        assertThrows(ApiException.class,()->disabled.verify("arbitrary-long-token-that-does-not-prove-identity"));
    }
    @Test void trustsOnlySuccessfulProviderUserResponse() throws Exception {
        var server=com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1",0),0);
        var status=new java.util.concurrent.atomic.AtomicInteger(200);
        server.createContext("/auth/v1/user",exchange->{
            assertEquals("Bearer "+"t".repeat(50),exchange.getRequestHeaders().getFirst("Authorization"));
            assertEquals("public-key",exchange.getRequestHeaders().getFirst("apikey"));
            byte[] body="{\"id\":\"61000000-0000-0000-0000-000000000001\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type","application/json");
            exchange.sendResponseHeaders(status.get(),body.length);
            try(var output=exchange.getResponseBody()){output.write(body);}
        });
        server.start();
        try {
            var verifier=new SupabaseLegacyCredentialVerifier(java.net.URI.create("http://127.0.0.1:"+
                    server.getAddress().getPort()+"/auth/v1/user"),"public-key",org.springframework.web.client.RestClient.create());
            assertEquals(java.util.UUID.fromString("61000000-0000-0000-0000-000000000001"),verifier.verify("t".repeat(50)));
            status.set(401);
            assertThrows(ApiException.class,()->verifier.verify("t".repeat(50)));
        } finally {server.stop(0);}
    }
}
