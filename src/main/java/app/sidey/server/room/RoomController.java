package app.sidey.server.room;

import app.sidey.server.auth.AuthController;
import java.util.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/rooms")
public class RoomController {
    private final RoomService rooms;
    public RoomController(RoomService rooms){this.rooms=rooms;}
    public record Name(String name) {}
    public record Invite(String inviteCode) {}
    @GetMapping public List<RoomService.Room> list(@AuthenticationPrincipal Jwt jwt){return rooms.list(AuthController.user(jwt));}
    @GetMapping("/{roomId}") public RoomService.Room get(@AuthenticationPrincipal Jwt jwt,@PathVariable UUID roomId){return rooms.get(AuthController.user(jwt),roomId);}
    @PostMapping public RoomService.Created create(@AuthenticationPrincipal Jwt jwt,@RequestBody Name value){return rooms.create(AuthController.user(jwt),value.name());}
    @PostMapping("/join") public RoomService.Room join(@AuthenticationPrincipal Jwt jwt,@RequestBody Invite value){return rooms.join(AuthController.user(jwt),value.inviteCode());}
    @PutMapping("/{roomId}") public RoomService.Room rename(@AuthenticationPrincipal Jwt jwt,@PathVariable UUID roomId,@RequestBody Name value){return rooms.rename(AuthController.user(jwt),roomId,value.name());}
    @PostMapping("/{roomId}/invite/rotate") public RoomService.Created rotate(@AuthenticationPrincipal Jwt jwt,@PathVariable UUID roomId){return rooms.rotate(AuthController.user(jwt),roomId);}
    @PostMapping("/{roomId}/leave") public Map<String,Object> leave(@AuthenticationPrincipal Jwt jwt,@PathVariable UUID roomId){UUID next=rooms.leave(AuthController.user(jwt),roomId);var result=new HashMap<String,Object>();result.put("successorId",next);return result;}
    @DeleteMapping("/{roomId}/members/{userId}") public void kick(@AuthenticationPrincipal Jwt jwt,@PathVariable UUID roomId,@PathVariable UUID userId){rooms.kick(AuthController.user(jwt),roomId,userId);}
    @DeleteMapping("/{roomId}") public void delete(@AuthenticationPrincipal Jwt jwt,@PathVariable UUID roomId){rooms.delete(AuthController.user(jwt),roomId);}
}
