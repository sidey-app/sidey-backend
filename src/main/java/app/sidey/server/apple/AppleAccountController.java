package app.sidey.server.apple;

import app.sidey.server.auth.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.*;

@RestController
public class AppleAccountController {
    private final AppleAccountService accounts;private final AuthChallenges challenges;
    public AppleAccountController(AppleAccountService accounts,AuthChallenges challenges){this.accounts=accounts;this.challenges=challenges;}
    public record Deletion(String identityToken,String nonce,String authorizationCode) {}
    @DeleteMapping("/api/account/apple") public Object delete(@AuthenticationPrincipal Jwt jwt,@RequestBody Deletion request){challenges.consume(request.nonce());return accounts.delete(AuthController.user(jwt),request.identityToken(),request.nonce(),request.authorizationCode());}
}
