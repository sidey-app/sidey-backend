// pg_net receives admission promptly; SQL dispatch/cleanup finish remains the
// completion evidence. This wrapper never claims work or retries publication.
import { json } from './realtime.mjs';
import { UUID } from './realtime-live.mjs';
import { createLivePublishHandler, stagingLivePublisherConfig } from './realtime-live-dispatch.mjs';

async function dispatchBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid_dispatch');
  const chunks = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 512) { await reader.cancel(); throw new Error('invalid_dispatch'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 1 || typeof value.dispatchId !== 'string' || !UUID.test(value.dispatchId)) {
    throw new Error('invalid_dispatch');
  }
  return { dispatchId: value.dispatchId };
}

export function createBackgroundPublishHandler({ env, defer, publish = createLivePublishHandler({ env }) }) {
  // Keep the inner handler (including its OAuth cache) for the warm isolate.
  return async request => {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const secret = env('SIDEY_FIREBASE_LIVE_PUBLISH_SECRET');
    if (!secret || secret.length < 32 || request.headers.get('authorization') !== `Bearer ${secret}`) {
      return json({ error: 'unauthorized' }, 401);
    }
    try {
      if (!stagingLivePublisherConfig(env)) return json({ enabled: false, accepted: false });
      if (typeof defer !== 'function') throw new Error('background_unavailable');
      let body;
      try { body = await dispatchBody(request); }
      catch { return json({ error: 'invalid_dispatch' }, 400); }
      // Do not clone the incoming Request: its abort signal belongs to pg_net's
      // HTTP lifecycle. The unchanged inner handler supplies its own time budget.
      const ownedRequest = new Request(`${env('SUPABASE_URL')}/functions/v1/realtime-publish-live`, {
        method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      let registered = false;
      const work = Promise.resolve().then(async () => {
        if (!registered) return;
        const response = await publish(ownedRequest);
        await response.body?.cancel();
      }).catch(() => {}); // SQL ownership/outbox and handler observations retain failure evidence.
      defer(work); registered = true;
      return json({ accepted: true }, 202);
    } catch { return json({ error: 'live_dispatch_unavailable' }, 503); }
  };
}
