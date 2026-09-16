package app.sidey.server.apple;

import app.sidey.server.common.ApiException;
import com.apple.itunes.storekit.client.AppStoreServerAPIClient;
import com.apple.itunes.storekit.model.*;
import com.apple.itunes.storekit.verification.*;
import java.io.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class AppleGateway implements AppleVerification {
    private final Map<String,SignedDataVerifier> verifiers=new HashMap<>();
    private final Map<String,AppStoreServerAPIClient> clients=new HashMap<>();
    public AppleGateway(@Value("${sidey.apple.bundle-id:}")String bundle,@Value("${sidey.apple.app-id:0}")long appId,
            @Value("${sidey.apple.root-certificates:}")String roots,@Value("${sidey.apple.private-key-file:}")String keyFile,
            @Value("${sidey.apple.key-id:}")String keyId,@Value("${sidey.apple.issuer-id:}")String issuer)throws IOException{
        if(bundle.isBlank() || roots.isBlank() || appId<=0 || keyFile.isBlank() || keyId.isBlank() || issuer.isBlank())return;
        String key=Files.readString(Path.of(keyFile));
        for(Environment environment:List.of(Environment.PRODUCTION,Environment.SANDBOX)){
            Set<InputStream> certs=new HashSet<>();try{
                for(String path:roots.split(","))certs.add(new ByteArrayInputStream(Files.readAllBytes(Path.of(path.strip()))));
                String name=environment==Environment.PRODUCTION?"Production":"Sandbox";
                verifiers.put(name,new MoneyVerifier(certs,bundle,appId,environment,true));
                clients.put(name,new AppStoreServerAPIClient(key,keyId,issuer,bundle,environment));
            }finally{for(InputStream cert:certs)cert.close();}
        }
    }
    /** Decoder normalization affects optional money only; the original JWS is still verified. */
    public static class MoneyVerifier extends SignedDataVerifier {
        private final com.fasterxml.jackson.databind.ObjectMapper parser=new com.fasterxml.jackson.databind.ObjectMapper();
        public MoneyVerifier(Set<InputStream> roots,String bundle,Long appId,Environment environment,boolean online){super(roots,bundle,appId,environment,online);}
        @Override protected <T extends DecodedSignedData>T parseJWTPayload(Class<T> type,com.auth0.jwt.interfaces.DecodedJWT jwt)throws VerificationException{
            if(type!=JWSTransactionDecodedPayload.class)return super.parseJWTPayload(type,jwt);
            try{
                var payload=parser.readTree(Base64.getUrlDecoder().decode(jwt.getPayload()));var price=payload.path("price");var currency=payload.path("currency");
                if(!price.isIntegralNumber() || !price.canConvertToLong() || price.asLong()<0 || price.asLong()>9007199254740991L || !currency.isTextual() || !currency.asText().matches("[A-Z]{3}")){
                    ((com.fasterxml.jackson.databind.node.ObjectNode)payload).remove(List.of("price","currency"));
                }
                return parser.treeToValue(payload,type);
            }catch(Exception invalid){throw new VerificationException(VerificationStatus.VERIFICATION_FAILURE,invalid);}
        }
    }
    private void configured(){if(verifiers.isEmpty())throw new ApiException(503,"apple_not_configured");}
    private void bounded(String signed){if(signed==null || signed.isBlank() || signed.length()>131072)throw new ApiException(400,"invalid_apple_signed_data");}
    public Transaction device(String signed){configured();bounded(signed);Transaction first=null;
        for(String environment:List.of("Production","Sandbox")){try{first=verify(signed,environment);break;}catch(ApiException invalid){if(environment.equals("Sandbox"))throw invalid;}}
        Transaction current=lookup(first.id(),first.environment());if(!first.id().equals(current.id()) || !first.storeProductId().equals(current.storeProductId()))throw new ApiException(409,"apple_transaction_mismatch");return current;
    }
    public Transaction lookup(String id,String environment){configured();if(id==null || id.isBlank() || id.length()>128 || !clients.containsKey(environment))throw new ApiException(400,"invalid_apple_transaction");
        try{String signed=clients.get(environment).getTransactionInfo(id).getSignedTransactionInfo();Transaction result=verify(signed,environment);if(!id.equals(result.id()))throw new ApiException(409,"apple_transaction_mismatch");return result;}
        catch(com.apple.itunes.storekit.client.APIException|IOException failed){throw new ApiException(502,"apple_provider_error");}
    }
    private Transaction verify(String signed,String environment){bounded(signed);try{return map(verifiers.get(environment).verifyAndDecodeTransaction(signed),signed,environment);}catch(VerificationException|IllegalArgumentException failed){throw new ApiException(400,"invalid_apple_transaction");}}
    public Notification notification(String signed){configured();bounded(signed);
        for(String environment:List.of("Production","Sandbox"))try{
            var decoded=verifiers.get(environment).verifyAndDecodeNotification(signed);
            if(decoded.getNotificationUUID()==null || decoded.getRawNotificationType()==null || decoded.getSignedDate()==null)throw new ApiException(400,"invalid_apple_notification");
            String transaction=decoded.getData()==null?null:decoded.getData().getSignedTransactionInfo();
            return new Notification(UUID.fromString(decoded.getNotificationUUID()),decoded.getRawNotificationType(),environment,Instant.ofEpochMilli(decoded.getSignedDate()),transaction==null?null:verify(transaction,environment),signed);
        }catch(VerificationException|IllegalArgumentException invalid){if(environment.equals("Sandbox"))throw new ApiException(400,"invalid_apple_notification");}
        throw new ApiException(400,"invalid_apple_notification");
    }
    public static Transaction map(JWSTransactionDecodedPayload p,String signed,String environment){
        if(p.getTransactionId()==null || p.getOriginalTransactionId()==null || p.getProductId()==null || p.getPurchaseDate()==null || p.getSignedDate()==null)throw new ApiException(400,"invalid_apple_transaction");
        Long price=p.getPrice();String currency=p.getCurrency();if(price==null || price<0 || price>9007199254740991L || currency==null || !currency.matches("[A-Z]{3}")){price=null;currency=null;}
        return new Transaction(p.getTransactionId(),p.getOriginalTransactionId(),p.getProductId(),p.getAppAccountToken(),environment,Instant.ofEpochMilli(p.getPurchaseDate()),p.getRevocationDate()==null?null:Instant.ofEpochMilli(p.getRevocationDate()),Instant.ofEpochMilli(p.getSignedDate()),signed,price,currency);
    }
}
