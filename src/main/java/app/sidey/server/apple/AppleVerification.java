package app.sidey.server.apple;

import java.time.Instant;
import java.util.UUID;

public interface AppleVerification {
    record Transaction(String id,String originalId,String storeProductId,UUID accountToken,String environment,Instant purchasedAt,Instant revokedAt,Instant signedAt,String signedData,Long priceMilliunits,String currency) {}
    record Notification(UUID id,String type,String environment,Instant signedAt,Transaction transaction,String signedData) {}
    Transaction device(String signedTransaction);
    Transaction lookup(String id,String environment);
    Notification notification(String signedPayload);
}
