package app.sidey.server.common;

import java.util.Set;
import java.util.UUID;

/** Post-commit synchronization hint for the users whose membership was removed. */
public record RoomRevoked(UUID roomId, Set<UUID> users) {
    public RoomRevoked { users = Set.copyOf(users); }
}
