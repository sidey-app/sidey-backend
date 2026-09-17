package app.sidey.server.user;

import app.sidey.server.auth.AuthController;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/account")
public class UserController {
    private final UserService users;
    public UserController(UserService users) { this.users=users; }
    @DeleteMapping
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@AuthenticationPrincipal Jwt jwt) {
        var user=AuthController.user(jwt);
        if(users.hasAppleIdentity(user))throw new app.sidey.server.common.ApiException(400,"apple_reauthentication_required");
        users.delete(user);
    }
}
