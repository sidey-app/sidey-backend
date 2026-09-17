// k6 run -e FIXTURES=/private/tokens.json -e CONNECTIONS=1200 -e MODE=mixed capacity.js
// Test credentials are generated only by lab_fixture.py against an isolated lab DB.
import { WebSocket } from 'k6/websockets';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';
import execution from 'k6/execution';
const fixtures = new SharedArray('fixtures', () => JSON.parse(open(__ENV.FIXTURES)));
const total = Number(__ENV.CONNECTIONS || 1200);
const hold = Number(__ENV.HOLD_SECONDS || 60);
const mode = __ENV.MODE || 'idle';
const workers = 10;
export const options = {
  scenarios: { capacity: { executor: 'per-vu-iterations', vus: workers, iterations: 1, maxDuration: `${hold + 90}s` } },
  thresholds: {
    sidey_accepted: [`count==${Math.min(total, 3000)}`],
    sidey_subscribed: [`count==${Math.min(total, 3000)}`],
    sidey_rejected: [`count==${Math.max(total - 3000, 0)}`],
    sidey_unexpected_close: ['count==0'],
    sidey_command_errors: ['count==0'],
  },
};
const accepted = new Counter('sidey_accepted');
const rejected = new Counter('sidey_rejected');
const subscribed = new Counter('sidey_subscribed');
const unexpected = new Counter('sidey_unexpected_close');
const errors = new Counter('sidey_command_errors');
const received = new Counter('sidey_events');
const commands = new Counter('sidey_commands');
const ack = new Trend('sidey_message_ack_ms', true);
const start = Date.now();
function uuid(index, counter) {
  return `${(start % 0xffffffff).toString(16).padStart(8, '0')}-${index.toString(16).padStart(4, '0')}-4000-8000-${counter.toString(16).padStart(12, '0')}`;
}
export default function () {
  rejected.add(0); unexpected.add(0); errors.add(0);
  for (let index = __VU - 1; index < total; index += workers) {
    setTimeout(() => {
      const f = fixtures[index];
      const urls = (__ENV.URLS || __ENV.URL || 'ws://127.0.0.1:18088/api/realtime').split(',');
      const ws = new WebSocket(urls[index % urls.length], null, { headers: { Authorization: `Bearer ${f.token}` } });
      let connected = false, stopping = false, transportError = false, counter = 0;
      const timers = [], pending = new Map();
      function send(value) { if (ws.readyState === 1) { ws.send(JSON.stringify(value)); commands.add(1); } }
      ws.addEventListener('message', event => {
        received.add(1);
        const data = JSON.parse(event.data);
        if (data.type === 'connected') {
          connected = true; accepted.add(1);
          send({ type: 'subscribe', roomId: f.room, requestId: 'subscription' });
          timers.push(setInterval(() => send({ type: 'heartbeat' }), 20000));
        } else if (data.type === 'ack' && data.command === 'subscribe') {
          subscribed.add(1);
          if (mode !== 'idle') {
            send({ type: 'presence.update', activeRoomId: f.room, activity: 'ONLINE' });
            timers.push(setInterval(() => send({ type: 'typing', roomId: f.room, active: true }), 5000));
            timers.push(setInterval(() => send({ type: 'character.pulse', roomId: f.room, eventId: uuid(index, ++counter) }), 3000));
            timers.push(setInterval(() => send({ type: 'presence.update', activeRoomId: f.room, activity: counter % 2 ? 'ONLINE' : 'AWAY' }), 17000));
            const peer = fixtures[Math.floor(index / 12) * 12 + ((index + 1) % 12)];
            timers.push(setInterval(() => send({ type: 'character.throw', roomId: f.room, targetUserId: peer.user, eventId: uuid(index, ++counter) }), 6000));
            timers.push(setInterval(() => {
              const id = uuid(index, ++counter); pending.set(id, execution.instance.currentTestRunDuration);
              send({ type: 'message.send', roomId: f.room, id, body: 'Capacity validation', requestId: id });
            }, 10000));
          }
        } else if (data.type === 'message.ack') {
          const sent = pending.get(data.requestId);
          if (sent !== undefined) { ack.add(execution.instance.currentTestRunDuration - sent); pending.delete(data.requestId); }
        } else if (data.type === 'error') { errors.add(1, { code: data.code }); }
      });
      ws.addEventListener('close', event => {
        for (const timer of timers) clearInterval(timer);
        // k6 emits error before close for the intentional 1008 capacity rejection.
        if (transportError && !(!connected && event.code === 1008 && total > 3000)) errors.add(1, { code: 'transport' });
        if (!connected) rejected.add(1, { code: String(event.code) });
        else if (!stopping) unexpected.add(1, { code: String(event.code) });
      });
      ws.addEventListener('error', () => { transportError = true; });
      setTimeout(() => { stopping = true; if (ws.readyState === 1) ws.close(); }, hold * 1000);
    }, index / total * 15000);
  }
}
