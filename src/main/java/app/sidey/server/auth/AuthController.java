package app.sidey.server.auth;

import app.sidey.server.common.ApiException;
import java.util.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
    private final AuthService auth;
    private final AuthChallenges challenges;
    public record Proof(String provider,String credential,String nonce,String platform,String deviceName,String legacyCredential) {}
    public record Refresh(String refreshToken) {}
    public AuthController(AuthService auth,AuthChallenges challenges){this.auth=auth;this.challenges=challenges;}
    @PostMapping("/challenge") Map<String,String> challenge(){return Map.of("nonce",challenges.create());}
    @PostMapping("/login") AuthService.Session login(@RequestBody Proof proof){validate(proof);challenges.consume(proof.nonce());return auth.login(proof.provider(),proof.credential(),proof.nonce(),proof.platform(),proof.deviceName());}
    @PostMapping("/legacy-claim") AuthService.Session claim(@RequestBody Proof proof){validate(proof);challenges.consume(proof.nonce());return auth.claim(proof.legacyCredential(),proof.provider(),proof.credential(),proof.nonce(),proof.platform(),proof.deviceName());}
    @PostMapping("/refresh") AuthService.Session refresh(@RequestBody Refresh value){return auth.refresh(value.refreshToken());}
    @PostMapping("/link") void link(@AuthenticationPrincipal Jwt jwt,@RequestBody Proof proof){validate(proof);challenges.consume(proof.nonce());auth.link(user(jwt),proof.provider(),proof.credential(),proof.nonce());}
    @PostMapping("/unlink") void unlink(@AuthenticationPrincipal Jwt jwt,@RequestBody Proof proof){validate(proof);challenges.consume(proof.nonce());auth.unlink(user(jwt),proof.provider(),proof.credential(),proof.nonce());}
    @PostMapping("/logout") void logout(@AuthenticationPrincipal Jwt jwt){auth.logout(UUID.fromString(jwt.getClaimAsString("sid")));}
    @PostMapping("/logout-all") void logoutAll(@AuthenticationPrincipal Jwt jwt){auth.logoutAll(user(jwt));}
    public static UUID user(Jwt jwt){return UUID.fromString(jwt.getSubject());}
    private static void validate(Proof p){if(p.credential()==null || p.credential().length()>16384 || p.nonce()==null) throw new ApiException(400,"invalid_provider_proof");}
}
