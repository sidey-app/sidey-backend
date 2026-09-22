import test from 'node:test';
import assert from 'node:assert/strict';
import { StagingAuthRateOverride } from './staging-auth-rate.mjs';

const secret = 'synthetic-secret-never-returned';
function fixture({ approved2400 = true, current = 150, checkpoint, intercept } = {}) {
  const calls = [], checkpoints = [];
  const state = { current };
  let session;
  session = new StagingAuthRateOverride({ approved2400, token: async () => secret,
    timeoutSignal: ms => { assert.equal(ms, 25000); return new AbortController().signal; },
    checkpoint: async snapshot => { checkpoints.push(snapshot); await checkpoint?.(snapshot, state); },
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.supabase.com/v1/projects/fjglrvhvdthntkvrduyi/config/auth');
      assert.equal(init.headers.authorization, `Bearer ${secret}`); assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      calls.push({ method: init.method, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
      if (init.method === 'PATCH') {
        assert.equal(session.snapshot().pending, true);
        assert.deepEqual(Object.keys(JSON.parse(init.body)), ['rate_limit_token_refresh']);
        assert.ok([150, 1500].includes(JSON.parse(init.body).rate_limit_token_refresh));
      } else { assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); }
      const result = await intercept?.(init, state, calls);
      if (result) return result;
      if (init.method === 'PATCH') { state.current = JSON.parse(init.body).rate_limit_token_refresh; return new Response(secret); }
      return Response.json({ jwt_exp: 3600, rate_limit_token_refresh: state.current,
        smtp_pass: secret, secret, rate_limit_token_refresh_forwarded_for: false });
    } });
  return { session, state, calls, checkpoints };
}

test('unapproved helper permits only allowlisted reads and never attempts a mutation', async () => {
  for (const approved2400 of [false, 'true', 2400]) {
    const h = fixture({ approved2400 });
    assert.deepEqual(await h.session.read(), { jwt_exp: 3600, rate_limit_token_refresh: 150 });
    await assert.rejects(h.session.apply(), { message: 'auth_rate_approval_required' });
    assert.equal((await h.session.restore()).pending, false);
    assert.deepEqual(h.calls.map(c => c.method), ['GET']);
  }
  const session = new StagingAuthRateOverride({ token: () => assert.fail('no credential lookup'), fetch: () => assert.fail('no network') });
  await assert.rejects(session.apply(), { message: 'auth_rate_approval_required' });
});

test('approved override journals pending before PATCH and restores immediately after preparation', async () => {
  const h = fixture({ checkpoint: (snapshot, state) => {
    if (snapshot.pending && !snapshot.applied) assert.equal(state.current, 150);
  } });
  try {
    const applied = await h.session.apply();
    assert.deepEqual(applied, { project: 'fjglrvhvdthntkvrduyi', before: 150, desired: 1500,
      pending: true, applied: true, restored: false });
    assert.equal(h.state.current, 1500);
  } finally { await h.session.restore(); }
  assert.equal(h.state.current, 150);
  assert.deepEqual(h.calls.map(call => call.method), ['GET', 'PATCH', 'GET', 'GET', 'PATCH', 'GET']);
  assert.deepEqual(h.checkpoints.map(c => [c.pending, c.applied, c.restored]), [[true, false, false], [true, true, false], [false, true, true]]);
  assert.equal(JSON.stringify(h.session.snapshot()).includes(secret), false);
  await h.session.restore(); assert.equal(h.calls.length, 6);
  await assert.rejects(h.session.apply(), { message: 'auth_rate_already_started' });
});

test('baseline conflicts never acquire restoration responsibility or write any setting', async () => {
  for (const current of [0, 151, 1500]) {
    const h = fixture({ current });
    await assert.rejects(h.session.apply(), { message: 'auth_rate_baseline_conflict' });
    assert.equal(h.session.snapshot().pending, false); await h.session.restore();
    assert.deepEqual(h.calls.map(call => call.method), ['GET']); assert.equal(h.state.current, current);
  }
});

test('lost apply response remains pending and finally restores whether or not the PATCH committed', async () => {
  for (const committed of [false, true]) {
    let failed = false;
    const h = fixture({ intercept: (init, state) => {
      if (init.method === 'PATCH' && !failed) {
        failed = true; if (committed) state.current = 1500; throw new Error(secret);
      }
    } });
    try {
      await assert.rejects(h.session.apply(), { message: 'auth_rate_network_failed' });
      assert.equal(h.session.snapshot().pending, true);
    } finally { await h.session.restore(); }
    assert.equal(h.state.current, 150); assert.equal(h.session.snapshot().restored, true);
    assert.equal(h.calls.filter(call => call.method === 'PATCH').length, committed ? 2 : 1);
  }
});

test('a lost restore response is resolved by reading the baseline without repeating its PATCH', async () => {
  let failed = false;
  const h = fixture({ intercept: (init, state) => {
    if (init.method === 'PATCH' && JSON.parse(init.body).rate_limit_token_refresh === 150 && !failed) {
      failed = true; state.current = 150; throw new Error(secret);
    }
  } });
  await h.session.apply();
  await assert.rejects(h.session.restore(), { message: 'auth_rate_network_failed' });
  assert.equal(h.session.snapshot().pending, true);
  await h.session.restore(); assert.equal(h.session.snapshot().restored, true);
  assert.equal(h.calls.filter(call => call.method === 'PATCH').length, 2);
});

test('restore preserves an external conflicting value and retains pending recovery evidence', async () => {
  const h = fixture(); await h.session.apply(); h.state.current = 300;
  await assert.rejects(h.session.restore(), { message: 'auth_rate_restore_conflict' });
  assert.equal(h.state.current, 300); assert.equal(h.session.snapshot().pending, true);
  assert.equal(h.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('a successful PATCH response cannot claim apply success without reading the desired value', async () => {
  const h = fixture({ intercept: init => init.method === 'PATCH' ? new Response(secret) : undefined });
  await assert.rejects(h.session.apply(), { message: 'auth_rate_apply_unverified' });
  assert.equal(h.session.snapshot().applied, false); assert.equal(h.session.snapshot().pending, true);
  await h.session.restore(); assert.equal(h.session.snapshot().restored, true);
  assert.equal(h.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('a successful PATCH response cannot claim restoration while the desired value remains', async () => {
  const h = fixture({ intercept: init => init.method === 'PATCH' && JSON.parse(init.body).rate_limit_token_refresh === 150
    ? new Response(secret) : undefined });
  await h.session.apply();
  await assert.rejects(h.session.restore(), { message: 'auth_rate_restore_unverified' });
  assert.equal(h.state.current, 1500); assert.equal(h.session.snapshot().pending, true);
  assert.equal(h.session.snapshot().restored, false);
});

test('a journal failure before mutation never sends PATCH and still permits a checked cleanup', async () => {
  let failed = false;
  const h = fixture({ checkpoint: () => { if (!failed) { failed = true; throw new Error(secret); } } });
  await assert.rejects(h.session.apply(), { message: 'auth_rate_checkpoint_failed' });
  assert.equal(h.session.snapshot().pending, true);
  await h.session.restore(); assert.equal(h.session.snapshot().restored, true);
  assert.equal(h.calls.some(call => call.method === 'PATCH'), false);
});

test('restore runs after a preparation failure without hiding the original application error', async () => {
  const h = fixture();
  await assert.rejects((async () => {
    try { await h.session.apply(); throw new Error('preparation_failed'); }
    finally { await h.session.restore(); }
  })(), { message: 'preparation_failed' });
  assert.equal(h.state.current, 150); assert.equal(h.session.snapshot().restored, true);
});

test('parallel apply and restore cannot race the same temporary override', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { entered = resolve; });
  const h = fixture({ checkpoint: async snapshot => { if (!snapshot.applied && snapshot.pending) { entered(); await gate; } } });
  const applying = h.session.apply(); await began;
  await assert.rejects(h.session.apply(), { message: 'auth_rate_operation_in_progress' });
  await assert.rejects(h.session.restore(), { message: 'auth_rate_operation_in_progress' });
  release(); await applying; await h.session.restore();
});

test('read returns only valid numeric allowlisted fields and no provider error or secret', async () => {
  for (const response of [() => new Response(secret), () => Response.json([]),
    () => Response.json({ jwt_exp: '3600', rate_limit_token_refresh: 150 }),
    () => Response.json({ jwt_exp: 3600, rate_limit_token_refresh: -1 }),
    () => Response.json({ jwt_exp: 0, rate_limit_token_refresh: 150 })]) {
    const session = new StagingAuthRateOverride({ token: async () => secret, fetch: async () => response() });
    await assert.rejects(session.read(), { message: 'auth_rate_response_invalid' });
  }
  const denied = new StagingAuthRateOverride({ token: async () => secret,
    fetch: async () => new Response(secret, { status: 403 }) });
  await assert.rejects(denied.read(), { message: 'auth_rate_http_403' });
  const tokenFailure = new StagingAuthRateOverride({ token: async () => { throw new Error(secret); } });
  await assert.rejects(tokenFailure.read(), { message: 'auth_rate_token_unavailable' });
});

test('GET responses are bounded before parsing, including chunked data', async () => {
  for (const headers of [{ 'content-length': '262145' }, {}]) {
    let cancelled = false;
    const session = new StagingAuthRateOverride({ token: async () => secret,
      fetch: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(262145)); }, cancel() { cancelled = true; } }), { headers }) });
    await assert.rejects(session.read(), { message: 'auth_rate_response_limit' }); assert.equal(cancelled, true);
  }
});

test('network and response-read deadlines produce safe fixed codes', async () => {
  for (const body of [false, true]) {
    const controller = new AbortController();
    const session = new StagingAuthRateOverride({ token: async () => secret, timeoutSignal: () => controller.signal,
      fetch: async () => {
        if (!body) { controller.abort(); throw new Error(secret); }
        return new Response(new ReadableStream({ pull(c) { controller.abort(); c.error(new Error(secret)); } }));
      } });
    await assert.rejects(session.read(), { message: 'auth_rate_timeout' });
  }
});
