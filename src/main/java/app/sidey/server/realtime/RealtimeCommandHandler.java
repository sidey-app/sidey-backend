package app.sidey.server.realtime;

import java.util.UUID;
import tools.jackson.databind.JsonNode;

public interface RealtimeCommandHandler {
    boolean supports(String type);
    void handle(String connectionId, UUID userId, UUID sessionId, JsonNode command);
}
