package app.sidey.server.commerce;

import app.sidey.server.auth.AuthController;
import java.util.*;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/commerce")
public class CommerceController {
    private final CommerceService commerce;
    public CommerceController(CommerceService commerce){this.commerce=commerce;}
    @ModelAttribute public void noStore(HttpServletResponse response){response.setHeader("Cache-Control","no-store");}
    public record OrderRequest(String productId) {}
    public record CheckoutRequest(String token,String action,String policyVersion) {}
    public record Completion(String token,String paymentId) {}
    @GetMapping("/catalog") public Object catalog(@AuthenticationPrincipal Jwt jwt){return commerce.catalog(AuthController.user(jwt));}
    @GetMapping("/entitlements") public Object entitlements(@AuthenticationPrincipal Jwt jwt){return commerce.entitlements(AuthController.user(jwt));}
    @PostMapping("/orders") public Object create(@AuthenticationPrincipal Jwt jwt,@RequestBody OrderRequest request){return commerce.create(AuthController.user(jwt),request.productId());}
    @GetMapping("/orders/{id}") public Object order(@AuthenticationPrincipal Jwt jwt,@PathVariable UUID id){return commerce.order(AuthController.user(jwt),id);}
    @PostMapping("/checkout") public Object checkout(@RequestBody CheckoutRequest request){return commerce.checkout(request.token(),"authorize".equals(request.action()),request.policyVersion());}
    @PostMapping("/complete") public Object complete(@RequestBody Completion request){String status=commerce.complete(request.token(),request.paymentId());return Map.of("completed",status.equals("approved"),"status",status);}
    @PostMapping("/portone/webhook") public Object webhook(@RequestBody String body,@RequestHeader(value="webhook-id",required=false)String id,@RequestHeader(value="webhook-signature",required=false)String signature,@RequestHeader(value="webhook-timestamp",required=false)String timestamp){return Map.of("accepted",true,"status",commerce.webhook(body,id,signature,timestamp));}
}
