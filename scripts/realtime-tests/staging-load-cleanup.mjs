// No import I/O or deletion operations. The caller may merge the result only after
// this complete, bounded scan succeeds; partial pages never mutate its journal.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validEmail = value => typeof value === 'string' && value.length > 0 && value.length <= 320;
const validId = value => typeof value === 'string' && UUID.test(value);

export async function discoverOwnedLoadUsers(journalUsers, {
  listUsers, perPage = 1000, maxUsers = 5000, maxPages = 6,
} = {}) {
  if (typeof listUsers !== 'function' || !Number.isInteger(perPage) || perPage < 1 || perPage > 1000
      || !Number.isInteger(maxUsers) || maxUsers < 1 || maxUsers > 5000
      || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 6
      || !Array.isArray(journalUsers) || journalUsers.length > maxUsers) {
    throw new Error('cleanup_discovery_invalid_options');
  }
  const ownedEmails = new Set(), knownIds = new Map(), result = new Map();
  for (const user of journalUsers) {
    if (!user || typeof user !== 'object' || !validEmail(user.email) || ownedEmails.has(user.email)) {
      throw new Error('cleanup_discovery_invalid_journal');
    }
    ownedEmails.add(user.email);
    if (user.id !== undefined && user.id !== null) {
      if (!validId(user.id) || knownIds.has(user.id)) throw new Error('cleanup_discovery_invalid_journal');
      knownIds.set(user.id, user.email);
      result.set(user.email, user.id);
    }
  }
  const seenIds = new Set(), seenEmails = new Set();
  let count = 0;
  for (let page = 1; page <= maxPages; page++) {
    const response = await listUsers({ page, perPage });
    if (!response || !Array.isArray(response.users) || response.users.length > perPage) {
      throw new Error('cleanup_discovery_invalid_page');
    }
    count += response.users.length;
    if (count > maxUsers) throw new Error('cleanup_discovery_user_limit');
    for (const user of response.users) {
      if (!user || typeof user !== 'object' || !validId(user.id)
          || (user.email !== undefined && user.email !== null && !validEmail(user.email))) {
        throw new Error('cleanup_discovery_invalid_user');
      }
      if (seenIds.has(user.id) || (user.email != null && seenEmails.has(user.email))) {
        throw new Error('cleanup_discovery_duplicate_user');
      }
      seenIds.add(user.id);
      if (user.email != null) seenEmails.add(user.email);
      // A journaled ID must never resolve to another account, even when its old
      // email no longer appears. Missing (already deleted) journaled IDs survive.
      if (knownIds.has(user.id) && knownIds.get(user.id) !== user.email) {
        throw new Error('cleanup_discovery_ownership_conflict');
      }
      if (!ownedEmails.has(user.email)) continue;
      if (result.has(user.email) && result.get(user.email) !== user.id) {
        throw new Error('cleanup_discovery_ownership_conflict');
      }
      result.set(user.email, user.id);
    }
    if (response.users.length < perPage) return result;
  }
  // A full final page cannot prove that every provider user was inspected.
  throw new Error('cleanup_discovery_page_limit');
}

// Verification includes discovery and durable journal persistence at the caller.
// Only verification errors choose preservation; deletion failures remain visible
// to the caller that owns per-resource cleanup and recovery reporting.
export async function withVerifiedLoadCleanup({ verify, remove, preserve }) {
  try { await verify(); }
  catch (error) { await preserve(error); return false; }
  await remove();
  return true;
}
