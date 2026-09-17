package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;
import app.sidey.server.commerce.PortOneProvider;
import app.sidey.server.common.ApiException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class PortOneSignatureTest {
    @Test void officialVerifierRejectsTamperingAndExpiredSignatures()throws Exception{
        byte[] key=new byte[32];java.util.Arrays.fill(key,(byte)7);
        var provider=new PortOneProvider("api-secret","whsec_"+Base64.getEncoder().encodeToString(key),"store-test","channel-test",new ObjectMapper());
        String body="{\"type\":\"Transaction.Paid\",\"timestamp\":\"2026-09-17T00:00:00Z\",\"data\":{\"paymentId\":\"payment-test\",\"storeId\":\"store-test\",\"transactionId\":\"tx-test\"}}";
        String time=Long.toString(Instant.now().getEpochSecond());String signature=sign(key,"event-1",time,body);
        provider.verifyWebhook(body,"event-1",signature,time);
        assertThrows(ApiException.class,()->provider.verifyWebhook(body+" ","event-1",signature,time));
        assertThrows(ApiException.class,()->provider.verifyWebhook(body,"event-2",signature,time));
        String old=Long.toString(Instant.now().minusSeconds(601).getEpochSecond());String expired=sign(key,"event-1",old,body);
        assertThrows(ApiException.class,()->provider.verifyWebhook(body,"event-1",expired,old));
    }
    private String sign(byte[] key,String id,String time,String body)throws Exception{Mac mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(key,"HmacSHA256"));return "v1,"+Base64.getEncoder().encodeToString(mac.doFinal((id+"."+time+"."+body).getBytes(StandardCharsets.UTF_8)));}
}
