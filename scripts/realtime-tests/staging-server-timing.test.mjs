import assert from 'node:assert/strict';
import test from 'node:test';
import { StagingServerTiming } from './staging-server-timing.mjs';

function fixture(value = null, options = {}) {
  const db = { value, databaseOverride: false, mutations: [], checkpoints: [], queries: [], notifications: 0 };
  const query = async sql => {
    db.queries.push(sql);
    if (!sql.startsWith('BEGIN;')) {
      if (db.readError) throw new Error('secret-read-error');
      return [{ value: db.value, database_override: db.databaseOverride, ignored: 'secret' }];
    }
    await db.beforeMutation?.();
    if (db.failBefore) { db.failBefore = false; throw new Error('secret-before-commit'); }
    const expected = sql.match(/current_value IS DISTINCT FROM (NULL|'true'|'false')/)[1];
    if (db.databaseOverride || db.value !== (expected === 'NULL' ? null : expected.slice(1, -1))) {
      throw new Error('server_timing_setting_conflict');
    }
    assert.match(sql, /PERFORM pg_notify\('pgrst', 'reload config'\)/);
    assert.match(sql, /END;\n\$server_timing\$;/);
    assert.match(sql, /COMMIT;$/);
    const setting = sql.match(/ALTER ROLE authenticator (RESET|SET) pgrst\.server_timing_enabled(?: = '(true|false)')?;/);
    assert.ok(setting);
    db.mutations.push(setting[1]);
    db.value = setting[1] === 'RESET' ? null : setting[2]; db.notifications++;
    if (db.loseResponse) { db.loseResponse = false; throw new Error('secret-after-commit'); }
  };
  const helper = new StagingServerTiming({ query, checkpoint: async snapshot => {
    db.checkpoints.push({ ...snapshot, actual: db.value });
    if (options.checkpointFailAt === db.checkpoints.length) throw new Error('secret-checkpoint');
  } });
  return { db, helper };
}

test('absent setting checkpoints before apply and resets with notify on restore', async () => {
  const { db, helper } = fixture();
  assert.deepEqual(await helper.read(), { value: null, databaseOverride: false });
  await helper.apply();
  assert.equal(db.checkpoints[0].pending, true);
  assert.equal(db.checkpoints[0].actual, null);
  assert.equal(db.value, 'true');
  assert.equal(helper.snapshot().applied, true);
  await helper.restore();
  assert.equal(db.value, null);
  assert.deepEqual(db.mutations, ['SET', 'RESET']);
  assert.equal(db.notifications, 2);
  assert.equal(helper.snapshot().restored, true);
  await helper.restore();
  assert.equal(db.mutations.length, 2);
  assert.ok(!JSON.stringify(helper.snapshot()).includes('secret'));
});

test('explicit false is restored exactly rather than resetting', async () => {
  const { db, helper } = fixture('false');
  await helper.apply(); await helper.restore();
  assert.equal(db.value, 'false');
  assert.deepEqual(db.mutations, ['SET', 'SET']);
});

test('preexisting true is recorded without changing or restoring it', async () => {
  const { db, helper } = fixture('true');
  const snapshot = await helper.apply();
  assert.equal(snapshot.unchanged, true);
  assert.equal(snapshot.pending, false);
  db.value = 'false';
  await helper.restore();
  assert.equal(db.value, 'false');
  assert.equal(db.mutations.length, 0);
});

test('checkpoint failure before apply makes zero mutations including finally restore', async () => {
  const { db, helper } = fixture(null, { checkpointFailAt: 1 });
  await assert.rejects(helper.apply(), /^Error: server_timing_checkpoint_failed$/);
  await helper.restore();
  assert.equal(db.mutations.length, 0);
  assert.equal(helper.snapshot().pending, false);
});

test('failed apply before commit leaves recovery safe and does not retry writes', async () => {
  const { db, helper } = fixture('false'); db.failBefore = true;
  await assert.rejects(helper.apply(), /^Error: server_timing_apply_failed$/);
  assert.equal(helper.snapshot().pending, true);
  await helper.restore();
  assert.equal(db.mutations.length, 0);
  assert.equal(helper.snapshot().restored, true);
  await assert.rejects(helper.apply(), /already_started/);
});

test('lost apply response retains recovery state and finally restores committed change', async () => {
  const { db, helper } = fixture(); db.loseResponse = true;
  await assert.rejects(helper.apply(), /^Error: server_timing_apply_failed$/);
  assert.equal(db.value, 'true');
  assert.equal(helper.snapshot().pending, true);
  await helper.restore();
  assert.equal(db.value, null);
  assert.equal(db.mutations.length, 2);
});

test('checkpoint failure after apply retains recovery state', async () => {
  const { db, helper } = fixture('false', { checkpointFailAt: 2 });
  await assert.rejects(helper.apply(), /checkpoint_failed/);
  assert.equal(db.value, 'true');
  await helper.restore();
  assert.equal(db.value, 'false');
});

test('restore failure retains pending state for explicit recovery', async () => {
  const { db, helper } = fixture(); await helper.apply(); db.failBefore = true;
  await assert.rejects(helper.restore(), /^Error: server_timing_restore_failed$/);
  assert.equal(helper.snapshot().pending, true);
  assert.equal(db.value, 'true');
  await helper.restore();
  assert.equal(db.value, null);
});

test('lost restore response is verified on explicit recovery without repeating mutation', async () => {
  const { db, helper } = fixture(); await helper.apply(); db.loseResponse = true;
  await assert.rejects(helper.restore(), /restore_failed/);
  assert.equal(helper.snapshot().pending, true);
  assert.equal(db.value, null);
  await helper.restore();
  assert.equal(db.mutations.length, 2);
  assert.equal(helper.snapshot().restored, true);
});

test('failed restore checkpoint keeps recovery pending until the confirmed state is saved', async () => {
  const { db, helper } = fixture(null, { checkpointFailAt: 3 });
  await helper.apply();
  await assert.rejects(helper.restore(), /checkpoint_failed/);
  assert.equal(db.value, null);
  assert.equal(helper.snapshot().pending, true);
  await helper.restore();
  assert.equal(helper.snapshot().pending, false);
  assert.equal(db.mutations.length, 2);
});

test('external different setting conflicts without overwrite', async () => {
  const { db, helper } = fixture(); await helper.apply(); db.value = 'false';
  await assert.rejects(helper.restore(), /restore_conflict/);
  assert.equal(db.value, 'false');
  assert.equal(db.mutations.length, 1);
  assert.equal(helper.snapshot().pending, true);
});

test('mutation transaction rechecks external changes after the initial read', async () => {
  const { db, helper } = fixture();
  db.beforeMutation = async () => { db.value = 'false'; };
  await assert.rejects(helper.apply(), /apply_failed/);
  assert.equal(db.value, 'false');
  assert.equal(db.mutations.length, 0);
});

test('restore transaction also rechecks an external change after its read', async () => {
  const { db, helper } = fixture(); await helper.apply();
  db.beforeMutation = async () => { db.value = 'false'; };
  await assert.rejects(helper.restore(), /restore_failed/);
  assert.equal(db.value, 'false');
  assert.equal(db.mutations.length, 1);
});

test('database-specific override is refused before apply and during restore', async () => {
  const first = fixture(); first.db.databaseOverride = true;
  await assert.rejects(first.helper.apply(), /database_override/);
  assert.equal(first.db.mutations.length, 0);
  const second = fixture(); await second.helper.apply(); second.db.databaseOverride = true;
  await assert.rejects(second.helper.restore(), /restore_conflict/);
  assert.equal(second.db.mutations.length, 1);
});

test('unsupported boolean representations fail closed without leaking values', async () => {
  for (const value of ['on', 'off', 'TRUE', '1', 'false=secret', 'secret']) {
    const { db, helper } = fixture(value);
    await assert.rejects(helper.apply(), /^Error: server_timing_value_unsupported$/);
    assert.equal(db.mutations.length, 0);
  }
});

test('invalid or failing query results are sanitized and never mutate', async () => {
  for (const result of [[], {}, [{ value: null }], [{ value: null, database_override: 'false' }]]) {
    const helper = new StagingServerTiming({ query: async () => result });
    await assert.rejects(helper.apply(), /^Error: server_timing_read_invalid$/);
  }
  const { db, helper } = fixture(); db.readError = true;
  await assert.rejects(helper.apply(), /^Error: server_timing_read_failed$/);
  assert.equal(db.mutations.length, 0);
});

test('parallel apply/restore operations are refused', async () => {
  const { db, helper } = fixture();
  let release;
  db.beforeMutation = () => new Promise(resolve => { release = resolve; });
  const pending = helper.apply();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(helper.restore(), /operation_in_progress/);
  await assert.rejects(helper.apply(), /operation_in_progress/);
  release(); await pending;
  db.beforeMutation = null; await helper.restore();
});
