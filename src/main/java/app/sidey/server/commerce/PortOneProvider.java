package app.sidey.server.commerce;

import app.sidey.server.common.ApiException;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import tools.jackson.databind.*;

@Component
public class PortOneProvider implements PaymentProvider {
    private final String secret,webhookSecret,store,channel;
    private final ObjectMapper json;
    private final HttpClient http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();
    public PortOneProvider(@Value("${sidey.commerce.portone-secret:}")String secret,@Value("${sidey.commerce.portone-webhook-secret:}")String webhookSecret,@Value("${sidey.commerce.portone-store:}")String store,@Value("${sidey.commerce.portone-channel:}")String channel,ObjectMapper json){this.secret=secret;this.webhookSecret=webhookSecret;this.store=store;this.channel=channel;this.json=json;}
    public String storeId(){return store;}public String channelKey(){return channel;}
    public void requireConfigured(){if(secret.isBlank() || webhookSecret.isBlank() || store.isBlank() || channel.isBlank())throw new ApiException(503,"commerce_not_configured");}
    public Payment lookup(String id){JsonNode p=request(id,null,null);return new Payment(text(p,"id"),text(p,"status"),text(p,"storeId"),text(p.path("channel"),"key"),text(p.path("channel"),"type"),text(p,"version"),p.path("transactionId").asString(null),money(p.path("amount"),"total"),p.path("amount").has("cancelled")?money(p.path("amount"),"cancelled"):0,text(p,"currency"),text(p.path("method"),"type"));}
    public void cancel(String id,UUID requestId,String reason,long total){request(id,Map.of("storeId",store,"reason",reason,"currentCancellableAmount",total),requestId);}
    private JsonNode request(String id,Object body,UUID requestId){
        requireConfigured();if(id==null || id.length()>200)throw new ApiException(400,"invalid_payment_id");
        String escaped=URLEncoder.encode(id,StandardCharsets.UTF_8).replace("+","%20");
        var request=HttpRequest.newBuilder(URI.create("https://api.portone.io/payments/"+escaped+(body==null?"":"/cancel"))).timeout(Duration.ofSeconds(8)).header("Authorization","PortOne "+secret).header("Content-Type","application/json");
        if(body!=null)request.header("Idempotency-Key","\"refund-"+requestId+"\"").POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        try {
            var response=http.send(request.build(),HttpResponse.BodyHandlers.ofInputStream());
            try(var stream=response.body()){
                if(response.statusCode()!=200)throw new ApiException(502,"payment_provider_error");
                byte[] bytes=stream.readNBytes(262145);if(bytes.length>262144)throw new ApiException(502,"payment_provider_error");return json.readTree(bytes);
            }
        }catch(InterruptedException interrupted){Thread.currentThread().interrupt();throw new ApiException(502,"payment_provider_error");}
        catch(java.io.IOException|IllegalArgumentException failure){throw new ApiException(502,"payment_provider_error");}
    }
    public void verifyWebhook(String body,String id,String signature,String timestamp){
        requireConfigured();if(body==null || body.length()>131072 || id==null || id.isBlank() || id.length()>180)throw new ApiException(400,"invalid_webhook");
        try{new io.portone.sdk.server.webhook.WebhookVerifier(webhookSecret).verify(body,id,signature,timestamp);}
        catch(Exception invalid){throw new ApiException(400,"invalid_webhook_signature");}
    }
    private String text(JsonNode node,String key){JsonNode value=node.get(key);if(value==null || !value.isString())throw new ApiException(502,"invalid_provider_payment");return value.asString();}
    private long money(JsonNode node,String key){JsonNode value=node.get(key);if(value==null || !value.isIntegralNumber() || !value.canConvertToLong() || value.asLong()<0)throw new ApiException(502,"invalid_provider_payment");return value.asLong();}
}
