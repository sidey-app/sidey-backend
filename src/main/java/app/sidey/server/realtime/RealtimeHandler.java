package app.sidey.server.realtime;

import app.sidey.server.auth.AuthService;
import app.sidey.server.common.ApiException;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.*;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Component
public class RealtimeHandler extends TextWebSocketHandler {
    private static final int MAX_FRAME=16384;
    private final ConnectionRegistry registry;
    private final app.sidey.server.common.ServingState serving;
    private final AuthService auth;
    private final ObjectMapper json;
    private final List<RealtimeCommandHandler> commands;
    private final app.sidey.server.message.MessageService messages;
    public RealtimeHandler(ConnectionRegistry registry,AuthService auth,ObjectMapper json,List<RealtimeCommandHandler> commands,app.sidey.server.message.MessageService messages,app.sidey.server.common.ServingState serving){this.serving=serving;this.registry=registry;this.auth=auth;this.json=json;this.commands=List.copyOf(commands);this.messages=messages;}
    @Override public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        session.setTextMessageSizeLimit(MAX_FRAME);session.setBinaryMessageSizeLimit(MAX_FRAME);
        try (var lease=serving.enter()) {
            if(lease==null){session.close(new CloseStatus(1012,"server_restarting"));return;}
            UUID user=user(session),sid=sid(session);
            auth.authorize(user,sid);
            registry.open(session,user,sid);
            registry.send(session.getId(),Map.of("type","connected","connectionId",session.getId()),true);
        } catch(ApiException|IllegalArgumentException rejected){session.close(new CloseStatus(1008,"session_rejected"));}
    }
    @Override protected void handleTextMessage(WebSocketSession session,TextMessage frame) throws Exception {
        try(var lease=serving.enter()){
            if(lease==null){session.close(new CloseStatus(1012,"server_restarting"));return;}
            dispatch(session,frame);
        }
    }
    private void dispatch(WebSocketSession session,TextMessage frame) throws Exception {
        String requestId=null;
        if(frame.getPayloadLength()>MAX_FRAME || frame.getPayload().getBytes(StandardCharsets.UTF_8).length>MAX_FRAME){session.close(new CloseStatus(1009,"frame_too_large"));return;}
        JsonNode command;
        try {command=json.readTree(frame.getPayload());}
        catch(RuntimeException malformed){error(session.getId(),null,"invalid_json");return;}
        try {
            if(command==null || !command.isObject())throw new ApiException(400,"invalid_command");
            JsonNode correlation=command.get("requestId");
            if(correlation!=null && !correlation.isNull()){
                if(!correlation.isString() || correlation.asString().isEmpty() || correlation.asString().length()>128 || correlation.asString().chars().anyMatch(c->c<32 || c==127))throw new ApiException(400,"invalid_request_id");
                requestId=correlation.asString();
            }
            JsonNode typeNode=command.get("type");
            if(typeNode==null || !typeNode.isString() || typeNode.asString().isEmpty() || typeNode.asString().length()>64)throw new ApiException(400,"invalid_command_type");
            String type=typeNode.asString();
            switch(type){
                case "ping" -> registry.send(session.getId(),reply("pong",requestId),false);
                case "subscribe" -> {UUID room=room(command);registry.subscribe(session.getId(),room);var ack=reply("ack",requestId);ack.put("command",type);ack.put("roomId",room);ack.put("recoveryThrough",messages.checkpoint(user(session),room));registry.send(session.getId(),ack,true);}
                case "unsubscribe" -> {UUID room=room(command);registry.unsubscribe(session.getId(),room);var ack=reply("ack",requestId);ack.put("command",type);ack.put("roomId",room);registry.send(session.getId(),ack,true);}
                default -> {
                    RealtimeCommandHandler dispatcher=commands.stream().filter(c->c.supports(type)).findFirst().orElseThrow(()->new ApiException(400,"unknown_command"));
                    dispatcher.handle(session.getId(),user(session),sid(session),command);
                }
            }
        } catch(ApiException rejected){error(session.getId(),requestId,rejected.code());}
        catch(IllegalArgumentException rejected){error(session.getId(),requestId,"invalid_command");}
        catch(RuntimeException failed){error(session.getId(),requestId,"internal_error");}
    }
    private UUID room(JsonNode command){JsonNode room=command.get("roomId");if(room==null || !room.isString() || !room.asString().matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))throw new ApiException(400,"invalid_room_id");return UUID.fromString(room.asString());}
    private UUID user(WebSocketSession session){Object user=session.getAttributes().get(WsHandshake.USER_ID);if(!(user instanceof UUID id))throw new ApiException(401,"session_rejected");return id;}
    private UUID sid(WebSocketSession session){Object sid=session.getAttributes().get(WsHandshake.SESSION_ID);if(!(sid instanceof UUID id))throw new ApiException(401,"session_rejected");return id;}
    private Map<String,Object> reply(String type,String requestId){var payload=new LinkedHashMap<String,Object>();payload.put("type",type);if(requestId!=null)payload.put("requestId",requestId);return payload;}
    private void error(String connection,String requestId,String code){var payload=reply("error",requestId);payload.put("code",code);registry.send(connection,payload,true);}
    @Override public void afterConnectionClosed(WebSocketSession session,CloseStatus status){registry.close(session.getId());}
    @Override public void handleTransportError(WebSocketSession session,Throwable exception) throws Exception {registry.close(session.getId());if(session.isOpen())session.close(new CloseStatus(1011,"transport_error"));}
}
