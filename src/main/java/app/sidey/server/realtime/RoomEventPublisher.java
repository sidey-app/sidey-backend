package app.sidey.server.realtime;

import java.util.UUID;

public interface RoomEventPublisher {
    void publish(RoomEvent event);
    record RoomEvent(UUID roomId,Object payload,boolean durable) {}
}
