# SIDEY transport contract

All API paths start with `/api`. Native clients send `Authorization: Bearer`
with a SIDEY access token, including the `/api/realtime` WebSocket handshake.
Tokens never go in query strings. Established sockets survive JWT expiry;
session revocation closes them. Request bodies and WS frames are JSON.

WS commands: `subscribe`, `unsubscribe`, `ping`, `message.send`.
Commands use optional `requestId` (1–128 printable characters) for correlation.
Room commands include `roomId`; message sends additionally include `id` (UUID)
and `body`. Errors are `{type:error, requestId?, code}`. Reuse the SAME message
UUID for every retry of one logical send, including failures of uncertain outcome.

Send returns `message.ack` with `message`. Room subscribers receive
`message.created` with the same canonical message. ACK is enqueued after commit,
before publication. Duplicate deliveries are expected. Merge by message UUID.
Canonical fields: id, roomId, senderId, body, bubbleStyleId, createdAt.

## Recovery

1. Connect and subscribe to each authorized room. Buffer/merge durable events
   immediately, including events arriving before the subscription ACK.
2. Subscribe ACK includes `recoveryThrough` (createdAt,id), or null for no history.
3. GET `/api/rooms/{room}/messages` after the last **completed recovery** cursor,
   with `throughCreatedAt`/`throughId` from this ACK. On first recovery omit after.
4. Follow `nextCursor` as `afterCreatedAt`/`afterId` until null. Limit is 1–200.
5. Merge history and live events by UUID, ordered by (createdAt,id). Only now
   persist recoveryThrough as the completed recovery cursor and report READY.

Do not advance the persisted recovery cursor to the largest live-event timestamp:
concurrent transactions can commit in a different order. The checkpoint waits
for existing sends to commit; subsequent sends have timestamps above it. Sends
share the recovery gate, so different members are not serialized with each other.
The checkpoint takes a brief exclusive gate, after live registration, with no
network I/O under the gate. A failed recovery never advances its cursor.

History defaults oldest-first and retains three days. `beforeCreatedAt`/`beforeId`
requests reverse history. Cursor timestamps retain PostgreSQL microsecond precision.
`GET /api/rooms/{room}/messages/{id}` resolves ambiguous outcomes. Recovery beyond
the retention window cannot resurrect intentionally deleted messages.

`room.changed` requests a fresh REST room/profile snapshot; `messages.pruned`
invalidates expired local history. Ephemeral events are never replayed. A slow
consumer can lose ephemeral events; durable queue overflow closes the socket,
requiring reconnect and REST catch-up.
