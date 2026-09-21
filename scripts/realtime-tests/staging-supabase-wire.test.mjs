import test from 'node:test';
import assert from 'node:assert/strict';
import { openSupabaseWire, parseFrame, replyError, STAGING_REF } from './staging-supabase-wire.mjs';

const userId = '11111111-1111-4111-8111-111111111111', roomId = '22222222-2222-4222-8222-222222222222';
function fixture({ rejectEvent, wrongTopic, silentEvent } = {}) {
  let socket;
  class Socket extends EventTarget {
    constructor(url) { super(); socket = this; this.url = url; this.readyState = 0; this.sent = [];
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    send(text) {
      const frame = JSON.parse(text); this.sent.push(frame);
      if (frame.event === silentEvent) return;
      queueMicrotask(() => this.receive({ ...frame, topic: wrongTopic ? 'wrong' : frame.topic, event: 'phx_reply',
        payload: { status: frame.event === rejectEvent ? 'error' : 'ok', response: {} } }));
    }
    receive(frame) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })); }
    close() { this.readyState = 3; queueMicrotask(() => this.dispatchEvent(new Event('close'))); }
  }
  const failures = [], broadcasts = []; let bytes = 0;
  const options = { anonKey: 'public-key', token: 'secret-token', userId, roomId, epoch: 3, Socket,
    onFailure: code => failures.push(code), onBroadcast: (...args) => broadcasts.push(args), onBytes: n => { bytes += n; }, timeoutMs: 30, heartbeatMs: 1000 };
  return { options, failures, broadcasts, get socket() { return socket; }, get bytes() { return bytes; } };
}

test('parser accepts v1 and rejects binary, arrays, malformed and oversized frames without exposing bodies', () => {
  assert.equal(parseFrame('{"topic":"phoenix","event":"heartbeat","payload":{}}').event, 'heartbeat');
  for (const value of [new Uint8Array(1), 'secret-token', '[]', JSON.stringify({ topic: 'x', event: 'x', payload: [] }), 'a'.repeat(1024 * 1024 + 1)]) {
    assert.throws(() => parseFrame(value), /^Error: invalid_ws_(frame|json)$/);
  }
});
test('authenticates both private channels then tracks native online Presence; never broadcasts', async () => {
  const f = fixture(), wire = await openSupabaseWire(f.options);
  try {
    assert.match(f.socket.url, new RegExp(`^wss://${STAGING_REF}`));
    assert.deepEqual(f.socket.sent.map(frame => frame.event), ['phx_join', 'phx_join', 'presence']);
    assert.deepEqual(f.socket.sent.slice(0, 2).map(frame => frame.topic), wire.topics);
    for (const frame of f.socket.sent.slice(0, 2)) {
      assert.equal(frame.payload.access_token, 'secret-token'); assert.equal(frame.payload.config.private, true);
      assert.equal(frame.payload.config.broadcast.self, false); assert.equal(frame.ref, frame.join_ref);
    }
    assert.equal(f.socket.sent[1].payload.config.presence.key, userId);
    assert.equal(f.socket.sent[2].payload.payload.state, 'online');
    assert.equal(f.socket.sent[2].join_ref, f.socket.sent[1].ref);
    assert.ok(f.bytes > 0);
  } finally { await wire.close(); }
  assert.deepEqual(f.failures, []);
});
test('Presence meta replacement does not erase newly joined session and broadcasts remain scoped', async () => {
  const f = fixture(), wire = await openSupabaseWire(f.options), topic = wire.topics[1];
  f.socket.receive({ topic, event: 'presence_state', payload: { [userId]: { metas: [{ phx_ref: 'old' }] } } });
  assert.equal(wire.presence.has(userId), true);
  f.socket.receive({ topic, event: 'presence_diff', payload: {
    joins: { [userId]: { metas: [{ phx_ref: 'new' }] } }, leaves: { [userId]: { metas: [{ phx_ref: 'old' }] } } } });
  assert.equal(wire.presence.has(userId), true);
  f.socket.receive({ topic, event: 'broadcast', payload: { type: 'broadcast', event: 'typing_start', payload: { user_id: userId } } });
  f.socket.receive({ topic: 'other', event: 'broadcast', payload: { type: 'broadcast', event: 'typing_start', payload: {} } });
  assert.equal(f.broadcasts.length, 1);
  f.socket.receive({ topic, event: 'presence_diff', payload: { leaves: { [userId]: { metas: [{ phx_ref: 'new' }] } } } });
  assert.equal(wire.presence.size, 0); await wire.close();
});
for (const [name, config, code] of [
  ['join rejection', { rejectEvent: 'phx_join' }, 'ws_join_db_rejected_unknown'],
  ['Presence rejection', { rejectEvent: 'presence' }, 'ws_presence_rejected_unknown'],
  ['mismatched reply', { wrongTopic: true }, 'ws_frame_failed'],
  ['missing ACK', { silentEvent: 'phx_join' }, 'ws_reply_timeout'],
]) test(name + ' fails readiness and closes socket', async () => {
  const f = fixture(config); await assert.rejects(openSupabaseWire(f.options));
  assert.deepEqual(f.failures, [code]); assert.equal(f.socket.readyState, 3);
});
test('rejection diagnostics retain only allowlisted codes, never provider message or credentials', () => {
  assert.equal(replyError('phx_join', 'db', { reason: 'Unauthorized: secret-token' }), 'ws_join_db_rejected_unauthorized');
  assert.equal(replyError('phx_join', 'ephemeral', { reason: 'secret-token' }), 'ws_join_ephemeral_rejected_unknown');
});
test('unexpected channel failure surfaces once, while explicit close is idempotent', async () => {
  const f = fixture(), wire = await openSupabaseWire(f.options);
  f.socket.receive({ topic: wire.topics[0], event: 'phx_error', payload: {} });
  await wire.close(); await wire.close(); assert.deepEqual(f.failures, ['ws_frame_failed']);
});
test('heartbeat is acknowledged and abort tears down the connection', async () => {
  const f = fixture(), controller = new AbortController();
  const wire = await openSupabaseWire({ ...f.options, signal: controller.signal, heartbeatMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.ok(f.socket.sent.some(frame => frame.topic === 'phoenix' && frame.event === 'heartbeat'));
  controller.abort(); await wire.close(); assert.deepEqual(f.failures, ['ws_aborted']);
});
