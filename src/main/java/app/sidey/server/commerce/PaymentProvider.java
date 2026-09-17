package app.sidey.server.commerce;

import java.util.UUID;

public interface PaymentProvider {
    record Payment(String id,String status,String storeId,String channelKey,String channelType,String version,String transactionId,long total,long cancelled,String currency,String method) {}
    Payment lookup(String paymentId);
    void cancel(String paymentId,UUID requestId,String reason,long total);
    void verifyWebhook(String rawBody,String eventId,String signature,String timestamp);
    String storeId();
    String channelKey();
    void requireConfigured();
}
