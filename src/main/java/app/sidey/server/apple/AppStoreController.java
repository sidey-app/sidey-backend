package app.sidey.server.apple;

import app.sidey.server.auth.AuthController;
import jakarta.servlet.http.HttpServletResponse;
import java.util.Map;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/app-store")
public class AppStoreController {
    private final AppStoreService store;
    public AppStoreController(AppStoreService store){this.store=store;}
    public record Submission(String signedTransactionInfo) {}
    public record Notification(String signedPayload) {}
    @ModelAttribute public void noStore(HttpServletResponse response){response.setHeader("Cache-Control","no-store");}
    @PostMapping("/transactions") public Object submit(@AuthenticationPrincipal Jwt jwt,@RequestBody Submission request){return store.submit(AuthController.user(jwt),request.signedTransactionInfo());}
    @PostMapping("/notifications") public Object notification(@RequestBody Notification request){return Map.of("accepted",true,"processed",store.notification(request.signedPayload()));}
}
