// Phoenix v1 JSON protocol: https://supabase.com/docs/guides/realtime/protocol
// Import-safe; this client never sends Broadcast or postgres_changes requests.
export const STAGING_REF = 'fjglrvhvdthntkvrduyi';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JOIN_ERRORS = new Set(['InvalidJWTExpiration', 'MalformedJWT', 'JwtSignatureError', 'Unauthorized',
  'ConnectionRateLimitReached', 'ClientJoinRateLimitReached', 'ChannelRateLimitReached',
  'InitializingProjectConnection', 'IncreaseConnectionPool', 'DatabaseLackOfConnections', 'UnableToConnectToProject',
  'TopicNameRequired', 'TenantNotFound', 'RealtimeDisabledForTenant', 'RealtimeDisabledForConfiguration', 'RealtimeRestarting']);
export function replyError(event, topicKind, response) {
  const prefix = typeof response?.reason === 'string' ? response.reason.split(':', 1)[0] : '';
  const reason = JOIN_ERRORS.has(prefix) ? prefix.toLowerCase() : 'unknown';
  return `ws_${event === 'phx_join' ? 'join_' + topicKind : event === 'presence' ? 'presence' : 'request'}_rejected_${reason}`;
}

export function parseFrame(data) {
  if (typeof data !== 'string' || Buffer.byteLength(data) > 1024 * 1024) throw new Error('invalid_ws_frame');
  let frame;
  try { frame = JSON.parse(data); } catch { throw new Error('invalid_ws_json'); }
  if (!frame || typeof frame.topic !== 'string' || typeof frame.event !== 'string'
      || !frame.payload || typeof frame.payload !== 'object' || Array.isArray(frame.payload)) throw new Error('invalid_ws_frame');
  return frame;
}

export async function openSupabaseWire({ anonKey, token, userId, roomId, epoch, signal,
  onBroadcast = () => {}, onFailure = () => {}, onBytes = () => {},
  Socket = globalThis.WebSocket, timeoutMs = 10000, heartbeatMs = 20000 }) {
  if (!UUID.test(userId) || !UUID.test(roomId) || !/^\d+$/.test(String(epoch))
      || !anonKey || !token || !Socket) throw new Error('invalid_wire_config');
  signal?.throwIfAborted();
  const socket = new Socket(`wss://${STAGING_REF}.supabase.co/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`);
  const topics = ['db', 'ephemeral'].map(kind => `realtime:room:${roomId}:${epoch}:${kind}`);
  const joins = new Map(), pending = new Map(), presence = new Set(), presenceMetas = new Map();
  let reference = 0, closing = false, failed = false, heartbeat, closePromise, openResolve, openReject;
  const opened = new Promise((resolve, reject) => { openResolve = resolve; openReject = reject; });
  const openTimer = setTimeout(() => fail('ws_open_timeout'), timeoutMs);
  function fail(code) {
    if (closing || failed) return;
    failed = true; clearTimeout(openTimer); clearInterval(heartbeat);
    const error = new Error(code); openReject(error);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
    try { socket.close(); } catch { /* No socket errors escape into logs. */ }
    onFailure(code);
  }
  const abort = () => fail('ws_aborted');
  signal?.addEventListener('abort', abort, { once: true });
  socket.addEventListener('open', () => { clearTimeout(openTimer); openResolve(); });
  socket.addEventListener('error', () => fail('ws_error'));
  socket.addEventListener('close', () => fail('ws_unexpected_close'));
  socket.addEventListener('message', event => {
    if (closing || failed) return;
    try {
      onBytes(typeof event.data === 'string' ? Buffer.byteLength(event.data) : 0);
      const frame = parseFrame(event.data);
      if (frame.event === 'phx_reply') {
        const entry = pending.get(frame.ref);
        if (!entry) return;
        if (entry.topic !== frame.topic || (frame.join_ref != null && frame.join_ref !== entry.joinRef)) throw new Error('ws_reply_mismatch');
        pending.delete(frame.ref); clearTimeout(entry.timer);
        if (frame.payload.status !== 'ok') {
          const code = replyError(entry.event, entry.topic.endsWith(':db') ? 'db' : 'ephemeral', frame.payload.response);
          entry.reject(new Error(code)); fail(code);
        }
        else entry.resolve(frame.payload.response);
        return;
      }
      if (!topics.includes(frame.topic)) return;
      if (['phx_error', 'phx_close'].includes(frame.event) || (frame.event === 'system' && frame.payload.status === 'error')) throw new Error('ws_channel_failed');
      if (frame.event === 'presence_state') {
        presence.clear(); presenceMetas.clear();
        for (const [key, value] of Object.entries(frame.payload)) if (UUID.test(key)) {
          const refs = new Set((value.metas || []).map(meta => meta.phx_ref));
          presenceMetas.set(key, refs); if (refs.size) presence.add(key);
        }
      } else if (frame.event === 'presence_diff') {
        for (const [key, value] of Object.entries(frame.payload.joins || {})) if (UUID.test(key)) {
          const refs = presenceMetas.get(key) || new Set();
          for (const meta of value.metas || []) refs.add(meta.phx_ref);
          presenceMetas.set(key, refs); if (refs.size) presence.add(key);
        }
        for (const [key, value] of Object.entries(frame.payload.leaves || {})) {
          const refs = presenceMetas.get(key);
          if (refs) for (const meta of value.metas || []) refs.delete(meta.phx_ref);
          if (!refs?.size) { presence.delete(key); presenceMetas.delete(key); }
        }
      } else if (frame.event === 'broadcast') {
        if (frame.payload.type !== 'broadcast' || typeof frame.payload.event !== 'string' || !frame.payload.payload) throw new Error('invalid_ws_broadcast');
        onBroadcast(frame.payload.event, frame.payload.payload, frame.topic);
      }
    } catch { fail('ws_frame_failed'); }
  });
  function request(topic, event, payload) {
    if (failed || closing) return Promise.reject(new Error('ws_not_open'));
    const ref = String(++reference), joinRef = event === 'phx_join' ? ref : joins.get(topic) ?? null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail('ws_reply_timeout'), timeoutMs);
      pending.set(ref, { topic, event, joinRef, resolve, reject, timer });
      try { socket.send(JSON.stringify({ topic, event, payload, ref, join_ref: joinRef })); }
      catch { fail('ws_send_failed'); }
      if (event === 'phx_join') joins.set(topic, ref);
    });
  }
  async function close() {
    if (closePromise) return closePromise;
    closing = true; clearTimeout(openTimer); clearInterval(heartbeat); signal?.removeEventListener('abort', abort);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('ws_closed')); }
    pending.clear();
    closePromise = new Promise(resolve => {
      if (socket.readyState === 3) { resolve(); return; }
      const timer = setTimeout(resolve, 1000);
      socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
      try { socket.close(1000); } catch { clearTimeout(timer); resolve(); }
    });
    return closePromise;
  }
  try {
    await opened;
    for (const [index, topic] of topics.entries()) {
      await request(topic, 'phx_join', { config: { broadcast: { ack: false, self: false },
        presence: { enabled: index === 1, key: index === 1 ? userId : '' }, postgres_changes: [], private: true }, access_token: token });
    }
    await request(topics[1], 'presence', { type: 'presence', event: 'track', payload: {
      user_id: userId, state: 'online', online_at: new Date().toISOString() } });
    heartbeat = setInterval(() => {
      if (!pending.size) request('phoenix', 'heartbeat', {}).catch(() => {});
    }, heartbeatMs);
    return { close, presence, topics };
  } catch (error) { await close(); throw error; }
}
