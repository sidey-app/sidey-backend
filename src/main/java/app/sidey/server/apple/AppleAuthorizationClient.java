package app.sidey.server.apple;

import com.auth0.jwt.JWT;
import com.auth0.jwt.algorithms.Algorithm;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.security.interfaces.ECPrivateKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.time.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.oauth2.jwt.*;
import org.springframework.stereotype.Component;
import tools.jackson.databind.*;

/** Sign-In authorization revocation is separate from App Store ownership. */
@Component
public class AppleAuthorizationClient implements AppleAuthorization {
    private final String clientId,keyId,teamId,keyFile;private final ObjectMapper json;
    private final HttpClient http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();
    private final NimbusJwtDecoder identity= NimbusJwtDecoder.withJwkSetUri("https://appleid.apple.com/auth/keys").build();
    public AppleAuthorizationClient(@Value("${sidey.apple.sign-in-client-id:}")String clientId,@Value("${sidey.apple.sign-in-key-id:}")String keyId,@Value("${sidey.apple.sign-in-team-id:}")String teamId,@Value("${sidey.apple.sign-in-private-key-file:}")String keyFile,ObjectMapper json){this.clientId=clientId;this.keyId=keyId;this.teamId=teamId;this.keyFile=keyFile;this.json=json;identity.setJwtValidator(JwtValidators.createDefaultWithIssuer("https://appleid.apple.com"));}
    public boolean revoke(String code,String expectedSubject){
        if(clientId.isBlank() || keyId.isBlank() || teamId.isBlank() || keyFile.isBlank() || code==null || code.isBlank() || code.length()>16384)return false;
        try {
            String pem=Files.readString(Path.of(keyFile)).replace("-----BEGIN PRIVATE KEY-----","").replace("-----END PRIVATE KEY-----","").replaceAll("\\s","");
            ECPrivateKey key=(ECPrivateKey)KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(pem)));
            Instant now=Instant.now();String secret=JWT.create().withKeyId(keyId).withIssuer(teamId).withSubject(clientId).withAudience("https://appleid.apple.com").withIssuedAt(now).withExpiresAt(now.plusSeconds(300)).sign(Algorithm.ECDSA256(null,key));
            JsonNode response=post("token",Map.of("client_id",clientId,"client_secret",secret,"code",code,"grant_type","authorization_code"));
            if(response==null || !response.path("refresh_token").isString() || !response.path("id_token").isString())return false;
            Jwt verified=identity.decode(response.get("id_token").asString());
            if(!expectedSubject.equals(verified.getSubject()) || !verified.getAudience().contains(clientId))return false;
            return post("revoke",Map.of("client_id",clientId,"client_secret",secret,"token",response.get("refresh_token").asString(),"token_type_hint","refresh_token"))!=null;
        }catch(InterruptedException interrupted){Thread.currentThread().interrupt();return false;}
        catch(Exception failure){return false;}
    }
    private JsonNode post(String path,Map<String,String> fields)throws Exception{
        String body=fields.entrySet().stream().map(e->URLEncoder.encode(e.getKey(),StandardCharsets.UTF_8)+"="+URLEncoder.encode(e.getValue(),StandardCharsets.UTF_8)).collect(java.util.stream.Collectors.joining("&"));
        var request=HttpRequest.newBuilder(URI.create("https://appleid.apple.com/auth/"+path)).timeout(Duration.ofSeconds(8)).header("Content-Type","application/x-www-form-urlencoded").POST(HttpRequest.BodyPublishers.ofString(body)).build();
        var response=app.sidey.server.common.ProviderHttp.send(http,request,65536,Duration.ofSeconds(8));
        if(response.statusCode()!=200)return null;byte[] bytes=response.body();return bytes.length==0?json.createObjectNode():json.readTree(bytes);
    }
}
