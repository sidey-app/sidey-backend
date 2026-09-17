package app.sidey.server.profile;

import app.sidey.server.auth.AuthController;
import java.util.UUID;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/profile")
public class ProfileController {
    private final ProfileService profiles;
    public ProfileController(ProfileService profiles){this.profiles=profiles;}
    public record Save(String nickname,String characterId) {}
    public record Equipment(String kind,String catalogItemId) {}
    public record Tree(boolean paused,long expectedRevision) {}
    @GetMapping public ProfileService.Profile get(@AuthenticationPrincipal Jwt jwt,@RequestParam(required=false) UUID userId){UUID actor=AuthController.user(jwt);return profiles.get(actor,userId==null?actor:userId);}
    @PutMapping public ProfileService.Profile save(@AuthenticationPrincipal Jwt jwt,@RequestBody Save value){return profiles.save(AuthController.user(jwt),value.nickname(),value.characterId());}
    @PutMapping("/equipment") public ProfileService.Profile equipment(@AuthenticationPrincipal Jwt jwt,@RequestBody Equipment value){return profiles.equipment(AuthController.user(jwt),value.kind(),value.catalogItemId());}
    @PutMapping("/tree") public ProfileService.Profile tree(@AuthenticationPrincipal Jwt jwt,@RequestBody Tree value){return profiles.tree(AuthController.user(jwt),value.paused(),value.expectedRevision());}
}
