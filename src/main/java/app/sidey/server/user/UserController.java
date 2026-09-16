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
    public void delete(@AuthenticationPrincipal Jwt jwt) { users.delete(AuthController.user(jwt)); }
}
