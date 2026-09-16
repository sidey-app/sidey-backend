package app.sidey.server.auth;

import java.util.UUID;

public record SessionEvents(UUID sessionId, UUID userId) {}
