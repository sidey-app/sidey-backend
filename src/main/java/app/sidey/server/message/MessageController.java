package app.sidey.server.message;

import app.sidey.server.auth.AuthController;
import app.sidey.server.common.ApiException;
import java.time.OffsetDateTime;
import java.util.UUID;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/rooms/{room}/messages")
public class MessageController {
    private final MessageService messages;
    public MessageController(MessageService messages){this.messages=messages;}
    @GetMapping MessageService.Page history(@AuthenticationPrincipal Jwt jwt,@PathVariable UUID room,
            @RequestParam(required=false) OffsetDateTime afterCreatedAt,@RequestParam(required=false) UUID afterId,
            @RequestParam(required=false) OffsetDateTime beforeCreatedAt,@RequestParam(required=false) UUID beforeId,
            @RequestParam(required=false) OffsetDateTime throughCreatedAt,@RequestParam(required=false) UUID throughId,
            @RequestParam(defaultValue="100") int limit){
        return messages.history(AuthController.user(jwt),room,cursor(afterCreatedAt,afterId),cursor(beforeCreatedAt,beforeId),cursor(throughCreatedAt,throughId),limit);
    }
    @GetMapping("/{id}") MessageService.Message get(@AuthenticationPrincipal Jwt jwt,@PathVariable UUID room,@PathVariable UUID id){return messages.get(AuthController.user(jwt),room,id);}
    private MessageService.Cursor cursor(OffsetDateTime time,UUID id){if((time==null)!=(id==null))throw new ApiException(400,"incomplete_cursor");return time==null?null:new MessageService.Cursor(time,id);}
}
