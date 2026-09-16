package app.sidey.server.commerce;

import app.sidey.server.common.*;
import java.security.MessageDigest;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.*;

@RestController
public class CommerceOperations {
    private final CommerceService commerce;private final String opsKey;
    public CommerceOperations(CommerceService commerce,@Value("${sidey.commerce.ops-key:}")String opsKey){this.commerce=commerce;this.opsKey=opsKey;}
    public record Refund(UUID orderId,UUID requestId,String reasonCode,String reasonDetail,String requestedBy) {}
    @PostMapping("/internal/commerce/refund") public Object refund(@RequestHeader(value="X-Sidey-Commerce-Ops-Key",required=false)String supplied,@RequestBody Refund request){
        if(opsKey.isBlank() || supplied==null || !MessageDigest.isEqual(Crypto.hash(opsKey),Crypto.hash(supplied)))throw new ApiException(401,"operations_authentication_required");
        String status=commerce.refund(request.orderId(),request.requestId(),request.reasonCode(),request.reasonDetail(),request.requestedBy());return Map.of("refunded",status.equals("refunded"),"status",status);
    }
}
