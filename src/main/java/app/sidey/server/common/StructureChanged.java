package app.sidey.server.common;

import java.util.UUID;

/** Published inside a transaction and consumed after commit by realtime. */
public record StructureChanged(UUID roomId, UUID userId) {}
