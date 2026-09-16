package app.sidey.server.message;

import app.sidey.server.common.ApiException;
import app.sidey.server.realtime.*;
import java.util.*;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

@Component
public class MessageCommands implements RealtimeCommandHandler {
    private final MessageService messages;
    private final ConnectionRegistry connections;
    private final RoomEventPublisher publisher;
    public MessageCommands(MessageService messages,ConnectionRegistry connections,RoomEventPublisher publisher){this.messages=messages;this.connections=connections;this.publisher=publisher;}
    public boolean supports(String type){return "message.send".equals(type);}
    public void handle(String connection,UUID user,UUID sid,JsonNode command){
        if(!user.equals(connections.user(connection)))throw new ApiException(401,"connection_closed");
        UUID room=uuid(command,"roomId"),id=uuid(command,"id");
        JsonNode body=command.get("body");if(body==null || !body.isString())throw new ApiException(400,"invalid_message_body");
        var saved=messages.send(user,room,id,body.asString());
        var ack=new LinkedHashMap<String,Object>();ack.put("type","message.ack");ack.put("message",saved);
        if(command.hasNonNull("requestId"))ack.put("requestId",command.get("requestId").asString());
        try {connections.send(connection,ack,true);}
        finally {publisher.publish(new RoomEventPublisher.RoomEvent(room,Map.of("type","message.created","message",saved),true));}
    }
    public static UUID uuid(JsonNode node,String key){JsonNode value=node.get(key);if(value==null || !value.isString() || !value.asString().matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))throw new ApiException(400,"invalid_"+key);return UUID.fromString(value.asString());}
}
