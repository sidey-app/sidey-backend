import test from 'node:test';
import assert from 'node:assert/strict';
import { baselineOptions, checkEmpty, cleanupOwned, runSupabaseBaseline } from './staging-supabase-baseline.mjs';
import { workloadKind, typingActivityTrace, simulateTypingActivity } from './staging-load-core.mjs';

const uid = '11111111-1111-4111-8111-111111111111', room = '22222222-2222-4222-8222-222222222222';
const empty = { users_empty: true, rooms_empty: true, outbox_empty: true, snapshots_empty: true,
  enroll_users_empty: true, enroll_rooms_empty: true, shadow_disabled: true,
  leases_empty: true, config_off: true, dispatch_off: true, dispatch_idle: true, cron_absent: true };
test('bounded CLI requires explicit staging and permits only 30/120 seconds', () => {
  assert.deepEqual(baselineOptions(['--run-explicit-staging']), { holdSeconds: 120 });
  assert.deepEqual(baselineOptions(['--run-explicit-staging', '--hold-seconds', '30']), { holdSeconds: 30 });
  for (const args of [[], ['--run-explicit-staging', '--users', '10'], ['--run-explicit-staging', '--hold-seconds', '900'],
    ['--run-explicit-staging', '--hold-seconds', '120', '--other', 'x']]) assert.throws(() => baselineOptions(args));
});
test('every empty/OFF preflight condition is mandatory', () => {
  checkEmpty([empty]); assert.throws(() => checkEmpty([]));
  for (const key of Object.keys(empty)) {
    assert.throws(() => checkEmpty([{ ...empty, [key]: false }]));
    const missing = { ...empty }; delete missing[key]; assert.throws(() => checkEmpty([missing]));
  }
});
test('same 30-second activity input produces 19 original events with typing slots replaced', () => {
  const nonTyping = Array.from({ length: 15 }, (_, i) => workloadKind(i)).filter(kind => !kind.startsWith('typing_')).length;
  const typing = simulateTypingActivity(typingActivityTrace(30000), 30000);
  assert.equal(nonTyping + typing.total, 19);
});
test('cleanup recovers uncertain creation by exact email, journals, then deletes only scoped room/user', async () => {
  const users = [{ email: 'synthetic@example.invalid' }], roomIds = [], calls = [];
  await cleanupOwned({ users, roomIds,
    sb: async (path, token, init, cleanup) => { assert.equal(cleanup, true); calls.push(path);
      if (!init.method) return { users: [{ id: uid, email: users[0].email }, { id: room, email: 'unrelated@example.invalid' }] }; },
    query: async sql => { calls.push(sql); return sql.startsWith('select') ? [{ id: room }] : []; },
    journal: async () => { calls.push('journal'); assert.equal(users[0].id, uid); assert.deepEqual(roomIds, [room]); } });
  assert.equal(calls[2], 'journal');
  assert.match(calls[3], new RegExp(`delete from public.rooms where id in\\('${room}'\\) and owner_id in\\('${uid}'\\)`));
  assert.equal(calls[4], `/auth/v1/admin/users/${uid}`);
});
test('cleanup mismatched or malformed identifiers fail before any mutation', async () => {
  for (const id of ["x');delete from auth.users;--", room]) {
    let writes = 0;
    await assert.rejects(cleanupOwned({ users: [{ email: 'owned@example.invalid', id }], roomIds: [],
      sb: async () => ({ users: [{ email: 'owned@example.invalid', id: uid }] }),
      query: async () => { writes++; return []; }, journal: async () => {} }));
    assert.equal(writes, 0);
  }
});
test('cleanup attempts all owned users after one delete fails', async () => {
  let deletes = 0;
  await assert.rejects(cleanupOwned({ users: [{ email: 'a', id: uid }, { email: 'b', id: room }], roomIds: [],
    sb: async (path, token, init) => { if (!init.method) return { users: [{ email: 'a', id: uid }, { email: 'b', id: room }] };
      deletes++; if (deletes === 1) throw new Error('network'); }, query: async () => [], journal: async () => {} }), /cleanup_user_delete_failed/);
  assert.equal(deletes, 2);
});
test('missing keys fail before HTTP or mutation and scrub arbitrary CLI error text', async () => {
  const result = await runSupabaseBaseline({ holdSeconds: 30 }, { execute: async () => ({ stdout: '[]' }),
    fetcher: async () => { throw new Error('must_not_fetch'); }, query: async () => { throw new Error('must_not_query'); }, log: () => {} });
  assert.equal(result.failure, 'missing_staging_keys'); assert.equal(result.actionsAttempted, 0); assert.equal(result.verdict, 'FAIL');
});
