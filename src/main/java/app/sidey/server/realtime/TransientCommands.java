package app.sidey.server.realtime;

import app.sidey.server.common.ApiException;
import java.time.Clock;
import java.util.*;
import org.jooq.DSLContext;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

@Component
public class TransientCommands implements RealtimeCommandHandler {
    private final ConnectionRegistry connections;
    private final PresenceService presence;
    private final TransientLimiter limiter;
    private final DSLContext db;
    private final Clock clock;
    public TransientCommands(ConnectionRegistry connections,PresenceService presence,TransientLimiter limiter,DSLContext db,Clock clock){this.connections=connections;this.presence=presence;this.limiter=limiter;this.db=db;this.clock=clock;}
    @Override public boolean supports(String type){return Set.of("heartbeat","presence.update","presence.snapshot","typing","character.pulse","character.throw").contains(type);}
    @Override public void handle(String connection,UUID user,UUID sid,JsonNode command){
        if(!connections.user(connection).equals(user))throw new ApiException(401,"connection_closed");
        String type=command.path("type").asString();
        limiter.take(user,type,type.equals("character.throw")?20:30);
        if(type.equals("heartbeat")){presence.heartbeat(connection);connections.send(connection,Map.of("type","heartbeat.ack"),false);return;}
        if(type.equals("presence.update")){
            var active=command.get("activeRoomId");UUID room=active==null || active.isNull()?null:uuid(command,"activeRoomId");
            PresenceService.Activity activity;try{activity=PresenceService.Activity.valueOf(command.path("activity").asString());}catch(RuntimeException invalid){throw new ApiException(400,"invalid_activity");}
            presence.focus(connection,room,activity);presence.tick();return;
        }
        UUID room=uuid(command,"roomId");
        if(type.equals("presence.snapshot")){connections.send(connection,Map.of("type","presence","roomId",room,"members",presence.snapshot(room,user)),false);return;}
        Map<String,Object> event=new LinkedHashMap<>();event.put("type",type);event.put("roomId",room);event.put("userId",user);
        UUID target=null;
        if(type.equals("typing")){
            if(!command.path("active").isBoolean())throw new ApiException(400,"invalid_typing");
            boolean active=command.path("active").asBoolean();event.put("active",active);event.put("expiresAt",clock.instant().plusSeconds(active?4:0));
        } else {
            event.put("eventId",uuid(command,"eventId"));
            if(type.equals("character.throw")){
                target=uuid(command,"targetUserId");if(target.equals(user))throw new ApiException(400,"self_target_forbidden");
                // Only server-owned equipment and active grants choose the paid render asset.
                // No membership query or ephemeral state is persisted by this lookup.
                var profile=db.fetchOne("select f.character_id,coalesce((select p.render_asset_id from commerce_products p join commerce_entitlements e on e.entitlement_key=p.entitlement_key where p.product_kind='throwable' and p.catalog_item_id=f.equipped_throwable_id and p.active and e.user_id=f.id and e.status='active'),'patch_soft_ball') as throwable from profiles f where f.id=?",user);
                if(profile==null)throw new ApiException(404,"profile_required");
                event.put("targetUserId",target);event.put("sourceCharacterId",profile.get("character_id",String.class));event.put("throwableId",profile.get("throwable",String.class));
            }
        }
        connections.publishFrom(room,user,target,event);
    }
    private UUID uuid(JsonNode command,String field){String value=command.path(field).asString();if(value==null || !value.matches("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"))throw new ApiException(400,"invalid_"+field);return UUID.fromString(value);}
}
