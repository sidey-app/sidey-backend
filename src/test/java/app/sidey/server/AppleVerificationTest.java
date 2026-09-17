package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;
import app.sidey.server.apple.AppleGateway;
import com.apple.itunes.storekit.model.*;
import com.apple.itunes.storekit.verification.VerificationException;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.junit.jupiter.api.Test;

class AppleVerificationTest {
    private static class DecoderProbe extends AppleGateway.MoneyVerifier {
        DecoderProbe(){super(Set.of(AppleVerificationTest.class.getResourceAsStream("/apple/AppleRootCA-G3.pem")),"app.sidey",123L,Environment.PRODUCTION,true);}
        JWSTransactionDecodedPayload parseOnly(String jwt)throws Exception{return parseJWTPayload(JWSTransactionDecodedPayload.class,com.auth0.jwt.JWT.decode(jwt));}
    }
    private String jwt(String money){String payload="{\"transactionId\":\"1\",\"originalTransactionId\":\"1\",\"productId\":\"character_pig\",\"bundleId\":\"app.sidey\",\"environment\":\"Production\",\"purchaseDate\":1700000000000,\"signedDate\":1700000000100"+money+"}";var b=Base64.getUrlEncoder().withoutPadding();return b.encodeToString("{\"alg\":\"none\"}".getBytes(StandardCharsets.UTF_8))+"."+b.encodeToString(payload.getBytes(StandardCharsets.UTF_8))+".";}
    @Test void officialVerificationNeverAcceptsUnsignedDecodedData()throws Exception{
        var verifier=new DecoderProbe();String signed=jwt(",\"price\":990000,\"currency\":\"KRW\"");
        assertThrows(VerificationException.class,()->verifier.verifyAndDecodeTransaction(signed));
        assertThrows(VerificationException.class,()->verifier.verifyAndDecodeNotification(signed));
        assertEquals(990000L,verifier.parseOnly(signed).getPrice());
    }
    @Test void optionalMalformedMoneyIsUnknownWithoutLosingPurchaseFields()throws Exception{
        var verifier=new DecoderProbe();
        for(String malformed:List.of("",",\"price\":100",",\"price\":\"1000\",\"currency\":\"KRW\"",",\"price\":1.5,\"currency\":\"KRW\"",",\"price\":-1,\"currency\":\"KRW\"",",\"price\":9007199254740992,\"currency\":\"KRW\"",",\"price\":1,\"currency\":\"krw\"")){
            var decoded=verifier.parseOnly(jwt(malformed));var mapped=AppleGateway.map(decoded,"verified-only-in-production","Production");assertEquals("1",mapped.id());assertNull(mapped.priceMilliunits());assertNull(mapped.currency());
        }
        var mapped=AppleGateway.map(verifier.parseOnly(jwt(",\"price\":0,\"currency\":\"USD\",\"quantity\":2")),"verified-only-in-production","Production");assertEquals(0L,mapped.priceMilliunits());assertEquals("USD",mapped.currency());
    }
}
