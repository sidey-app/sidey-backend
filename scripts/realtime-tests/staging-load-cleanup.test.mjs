import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverOwnedLoadUsers, withVerifiedLoadCleanup } from './staging-load-cleanup.mjs';

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const user = number => ({ id: id(number), email: `load-${number}@example.invalid` });
function listing(pages, calls = []) {
  return async options => { calls.push(options); return { users: pages[options.page - 1] }; };
}

test('finds all 2400 exact journal emails across pages and returns only owned IDs', async () => {
  const rows = Array.from({ length: 2400 }, (_, index) => user(index));
  const journal = rows.map(({ email }) => Object.freeze({ email }));
  const calls = [];
  const result = await discoverOwnedLoadUsers(Object.freeze(journal), {
    listUsers: listing([rows.slice(0, 1000), rows.slice(1000, 2000),
      [...rows.slice(2000), { ...user(2400), email: 'other-provider@example.invalid' }]], calls),
  });
  assert.deepEqual([...result], rows.map(row => [row.email, row.id]));
  assert.deepEqual(calls, [{ page: 1, perPage: 1000 }, { page: 2, perPage: 1000 }, { page: 3, perPage: 1000 }]);
  assert.equal(journal.some(row => row.id), false);
});

test('preserves known IDs for already-deleted users without normalizing unrelated emails', async () => {
  const known = user(1), discovered = user(2);
  const result = await discoverOwnedLoadUsers([known, { email: discovered.email }], {
    listUsers: listing([[discovered, { ...user(3), email: known.email.toUpperCase() }, { id: id(4) }]]),
  });
  assert.deepEqual([...result], [[known.email, known.id], [discovered.email, discovered.id]]);
});

test('does not return or mutate partial discoveries before every page succeeds', async () => {
  const journal = [{ email: user(1).email }]; let rejectPage;
  const pending = new Promise((_, reject) => { rejectPage = reject; });
  let calls = 0, returned = false;
  const scan = discoverOwnedLoadUsers(journal, { perPage: 1,
    listUsers: async () => ++calls === 1 ? { users: [user(1)] } : pending,
  });
  const checked = scan.then(() => { returned = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2); assert.equal(returned, false); assert.equal(journal[0].id, undefined);
  rejectPage(new Error('page_failed'));
  await assert.rejects(checked, /page_failed/);
  assert.equal(returned, false); assert.equal(journal[0].id, undefined);
});

test('scans past all matches and rejects a duplicate on a later page', async () => {
  await assert.rejects(discoverOwnedLoadUsers([{ email: user(1).email }], {
    perPage: 1, listUsers: listing([[user(1)], [user(1)], []]),
  }), /duplicate_user/);
});

test('duplicate provider emails and UIDs fail closed, including unrelated accounts', async () => {
  for (const rows of [[user(1), { ...user(2), email: user(1).email }],
    [user(1), { ...user(2), id: user(1).id }]]) {
    await assert.rejects(discoverOwnedLoadUsers([{ email: user(3).email }], {
      listUsers: listing([rows]),
    }), /duplicate_user/);
  }
});

test('known journal IDs cannot move to another provider account or change by email', async () => {
  for (const rows of [[{ ...user(1), email: user(2).email }], [{ ...user(2), email: user(1).email }], [{ id: id(1) }]]) {
    await assert.rejects(discoverOwnedLoadUsers([user(1)], { listUsers: listing([rows]) }), /ownership_conflict/);
  }
});

test('invalid or ambiguous journals are rejected before making requests', async () => {
  for (const journal of [null, [{ email: '' }], [{ email: user(1).email, id: 'invalid' }],
    [user(1), user(1)], [user(1), { ...user(2), id: id(1) }]]) {
    let calls = 0;
    await assert.rejects(discoverOwnedLoadUsers(journal, { listUsers: async () => { calls++; } }));
    assert.equal(calls, 0);
  }
});

test('rejects malformed server pages and invalid user rows', async () => {
  for (const response of [null, {}, { users: {} }, { users: [null] }, { users: [{ id: 'invalid', email: user(1).email }] },
    { users: [{ ...user(1), email: 3 }] }, { users: [user(1), user(2)] }]) {
    await assert.rejects(discoverOwnedLoadUsers([{ email: user(1).email }], {
      perPage: 1, listUsers: async () => response,
    }), /cleanup_discovery_invalid/);
  }
});

test('5000 users require a sixth empty page and any additional user fails closed', async () => {
  const rows = Array.from({ length: 5000 }, (_, index) => user(index));
  const pages = Array.from({ length: 5 }, (_, index) => rows.slice(index * 1000, (index + 1) * 1000));
  const calls = [];
  const result = await discoverOwnedLoadUsers([{ email: user(4999).email }], { listUsers: listing([...pages, []], calls) });
  assert.deepEqual([...result], [[user(4999).email, id(4999)]]); assert.equal(calls.length, 6);
  await assert.rejects(discoverOwnedLoadUsers([], { listUsers: listing([...pages, [user(5000)]]) }), /user_limit/);
});

test('full final pages and invalid limits cannot silently truncate discovery', async () => {
  const calls = [];
  await assert.rejects(discoverOwnedLoadUsers([], { perPage: 1, maxPages: 2,
    listUsers: listing([[user(1)], [user(2)], []], calls),
  }), /page_limit/);
  assert.equal(calls.length, 2);
  for (const options of [{ perPage: 1001 }, { perPage: 0 }, { perPage: 1.5 }, { maxUsers: 5001 }, { maxPages: 7 }]) {
    await assert.rejects(discoverOwnedLoadUsers([], { listUsers: async () => { throw new Error('must_not_call'); }, ...options }), /invalid_options/);
  }
});

for (const failure of ['later_page_failed', 'ownership_conflict', 'room_lookup_failed', 'journal_write_failed', 'invalid_user_list']) {
  test(`verification ${failure} preserves recovery data without invoking deletion`, async () => {
    const calls = [], journal = [user(1)]; let preservedError;
    assert.equal(await withVerifiedLoadCleanup({
      verify: async () => {
        calls.push('verify');
        await discoverOwnedLoadUsers(journal, { perPage: 1, listUsers: async ({ page }) => {
          if (failure === 'ownership_conflict') return { users: [{ ...user(1), email: user(2).email }] };
          if (page === 1) return { users: [user(1)] };
          if (failure === 'later_page_failed') throw new Error(failure);
          if (failure === 'invalid_user_list') return { users: null };
          return { users: [] };
        } });
        calls.push('rooms');
        if (failure === 'room_lookup_failed') throw new Error(failure);
        calls.push('persist');
        if (failure === 'journal_write_failed') throw new Error(failure);
      },
      remove: async () => { calls.push('remove'); },
      preserve: async error => { preservedError = error; calls.push('preserve'); },
    }), false);
    const expectedError = failure === 'ownership_conflict' ? 'cleanup_discovery_ownership_conflict'
      : failure === 'invalid_user_list' ? 'cleanup_discovery_invalid_page' : failure;
    assert.equal(preservedError.message, expectedError);
    assert.equal(calls.includes('remove'), false);
    assert.equal(calls.at(-1), 'preserve');
    assert.equal(calls.includes('rooms'), ['room_lookup_failed', 'journal_write_failed'].includes(failure));
    assert.equal(calls.includes('persist'), failure === 'journal_write_failed');
  });
}

test('pending verification cannot invoke deletion and success preserves verify/persist/delete order', async () => {
  const calls = []; let completeVerification;
  const pending = new Promise(resolve => { completeVerification = resolve; });
  const work = withVerifiedLoadCleanup({
    verify: async () => { calls.push('verify'); await pending; calls.push('persist'); },
    remove: async () => { calls.push('remove'); },
    preserve: async () => { calls.push('preserve'); },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['verify']);
  completeVerification();
  assert.equal(await work, true);
  assert.deepEqual(calls, ['verify', 'persist', 'remove']);
});

test('verification failure waits for recovery preservation before returning false', async () => {
  let completePreservation, returned = false;
  const pending = new Promise(resolve => { completePreservation = resolve; });
  const work = withVerifiedLoadCleanup({
    verify: async () => { throw new Error('verification_failed'); },
    remove: async () => assert.fail('must not delete'),
    preserve: async () => pending,
  }).then(value => { returned = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(returned, false);
  completePreservation();
  assert.equal(await work, false);
});

test('deletion failures propagate without being mislabeled as verification failures', async () => {
  const error = new Error('deletion_failed'), calls = [];
  await assert.rejects(withVerifiedLoadCleanup({
    verify: async () => { calls.push('verify'); },
    remove: async () => { calls.push('remove'); throw error; },
    preserve: async () => { calls.push('preserve'); },
  }), value => value === error);
  assert.deepEqual(calls, ['verify', 'remove']);
});
