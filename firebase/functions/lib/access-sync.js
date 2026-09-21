"use strict";

const {timingSafeEqual} = require("node:crypto");
const {accessRpc, parseAccessSnapshot} = require("./supabase");

const SYNC_LEASE_MS = 120_000;
const BATCH_SIZE = 100;
const REVISION_PATTERN = /^[0-9]{20}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function roomSet(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, allowed]) => allowed === true));
}

function cleanupSessionMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([sessionId, rooms]) => [
    sessionId, roomSet(rooms),
  ]).filter(([, rooms]) => Object.keys(rooms).length));
}

async function cleanupRevokedRooms(database, userId, access) {
  const cleanupRooms = Object.keys(roomSet(access?.cleanup_rooms));
  const cleanupSessions = cleanupSessionMap(access?.cleanup_sessions);
  const updates = {};
  if (access?.active === false) updates[`v2/a/b/${userId}`] = null;
  for (const roomId of cleanupRooms) {
    updates[`v2/l/${roomId}/t/${userId}`] = null;
    updates[`v2/l/${roomId}/c/${userId}`] = null;
    updates[`v2/l/${roomId}/x/${userId}`] = null;
    updates[`v2/n/${userId}/r/${roomId}`] = null;
    // Clear the durable retry marker in the same atomic RTDB update as the
    // transient and inbox cleanup. The transaction below remains a defensive
    // normalization step for older/malformed marker maps.
    updates[`v2/a/u/${userId}/cleanup_rooms/${roomId}`] = null;
  }
  for (const [sessionId, rooms] of Object.entries(cleanupSessions)) {
    for (const roomId of Object.keys(rooms)) {
      updates[`v2/l/${roomId}/t/${userId}/${sessionId}`] = null;
    }
    updates[`v2/a/u/${userId}/cleanup_sessions/${sessionId}`] = null;
  }
  if (Object.keys(updates).length) await database.ref().update(updates);
  if (!cleanupRooms.length && !Object.keys(cleanupSessions).length) return access;

  const result = await database.ref(`/v2/a/u/${userId}`).transaction((current) => {
    if (!current?.cleanup_rooms && !current?.cleanup_sessions) return;
    const remainingRooms = roomSet(current.cleanup_rooms);
    for (const roomId of cleanupRooms) delete remainingRooms[roomId];
    const remainingSessions = cleanupSessionMap(current.cleanup_sessions);
    for (const sessionId of Object.keys(cleanupSessions)) delete remainingSessions[sessionId];
    const next = {...current};
    if (Object.keys(remainingRooms).length) next.cleanup_rooms = remainingRooms;
    else delete next.cleanup_rooms;
    if (Object.keys(remainingSessions).length) next.cleanup_sessions = remainingSessions;
    else delete next.cleanup_sessions;
    return next;
  }, undefined, false);
  return result.snapshot.val();
}

// A user's memberships, inventory and sessions move together in one transaction.
// Retain revoked users as tombstones so a delayed grant cannot resurrect them.
async function applyAccessSnapshot(database, access) {
  if (!REVISION_PATTERN.test(access.revision)) throw new Error("invalid_access_revision");
  const nextAccess = {
    revision: access.revision,
    active: access.active,
    rooms: Object.fromEntries(access.rooms.map((id) => [id, true])),
    items: Object.fromEntries(access.items.map((id) => [id, true])),
    wire_items: Object.fromEntries(access.wireItems.map((id) => [id, true])),
    sessions: access.sessions,
  };
  const result = await database.ref(`/v2/a/u/${access.userId}`).transaction((current) => {
    if (current?.revision && current.revision > nextAccess.revision) return;
    const cleanupRooms = roomSet(current?.cleanup_rooms);
    const cleanupSessions = cleanupSessionMap(current?.cleanup_sessions);
    for (const roomId of Object.keys(roomSet(current?.rooms))) {
      if (!nextAccess.rooms[roomId]) cleanupRooms[roomId] = true;
    }
    // A rapid rejoin cancels a cleanup marker before another redelivery runs.
    for (const roomId of Object.keys(nextAccess.rooms)) delete cleanupRooms[roomId];
    // Session UUIDs are never reused. Persist every revoked slot until its
    // typing state has been deleted from all rooms that session could access.
    for (const sessionId of Object.keys(current?.sessions || {})) {
      if (!Object.hasOwn(nextAccess.sessions, sessionId)) {
        cleanupSessions[sessionId] = {
          ...cleanupSessions[sessionId], ...roomSet(current?.rooms),
        };
      }
    }
    // Defensive only: if an upstream session ever reappears, never clean an
    // active claim's slot from a newer snapshot.
    for (const sessionId of Object.keys(nextAccess.sessions)) delete cleanupSessions[sessionId];
    const next = {...nextAccess};
    if (Object.keys(cleanupRooms).length) next.cleanup_rooms = cleanupRooms;
    if (Object.keys(cleanupSessions).length) next.cleanup_sessions = cleanupSessions;
    return next;
  }, undefined, false);
  // Aborted because a newer snapshot is already present is also a successful delivery.
  const cleaned = await cleanupRevokedRooms(database, access.userId, result.snapshot.val());
  await database.ref(`/v2/n/${access.userId}/a`).transaction((current) => {
    if (current !== null && current !== undefined) {
      if (typeof current !== "string" || !REVISION_PATTERN.test(current)) {
        throw new Error("invalid_access_inbox_revision");
      }
      if (current >= access.revision) return;
    }
    return access.revision;
  }, undefined, false);
  const verified = (await database.ref(`/v2/a/u/${access.userId}`).get()).val();
  if (verified?.revision === access.revision &&
      (Object.keys(roomSet(verified.cleanup_rooms)).length ||
       Object.keys(cleanupSessionMap(verified.cleanup_sessions)).length)) {
    throw new Error("access_cleanup_not_converged");
  }
  return verified ?? cleaned;
}

function parsePendingJob(job) {
  if (!job || typeof job.user_id !== "string" || !UUID_PATTERN.test(job.user_id) ||
      typeof job.revision !== "string" || !REVISION_PATTERN.test(job.revision)) {
    throw new Error("invalid_access_job");
  }
  return {userId: job.user_id.toLowerCase(), revision: job.revision};
}

function authorizedWake(authorization, secret) {
  if (typeof secret !== "string" || secret.length < 32 || typeof authorization !== "string") {
    return false;
  }
  // Secret Manager values are frequently provisioned with `echo`, which can
  // retain one trailing newline. HTTP header values cannot carry that newline,
  // so normalize only surrounding ASCII/Unicode whitespace before the
  // timing-safe comparison; never log either value.
  const normalizedSecret = secret.trim();
  if (normalizedSecret.length < 32) return false;
  const expected = Buffer.from(`Bearer ${normalizedSecret}`);
  const actual = Buffer.from(authorization);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function synchronizeAccess({database, config, rpc = accessRpc, onFailure = () => {}}) {
  const pending = await rpc(config, "firebase_access_pending", {p_limit: BATCH_SIZE});
  if (!Array.isArray(pending) || pending.length > BATCH_SIZE) throw new Error("invalid_access_batch");
  let delivered = 0;
  let failed = 0;
  let quarantined = 0;
  let cursor = 0;
  await Promise.all(Array.from({length: Math.min(10, pending.length)}, async () => {
    while (cursor < pending.length) {
      const job = pending[cursor++];
      try {
        const queued = parsePendingJob(job);
        const payload = await rpc(config, "firebase_access_snapshot", {p_user_id: queued.userId});
        let access;
        try {
          access = parseAccessSnapshot(payload, queued.userId);
        } catch (error) {
          if (error?.code !== "supabase_access_mismatch") throw error;
          // The source answered successfully but returned an unsafe shape. Deny
          // only this user at the exact queued revision so one poison record
          // cannot take every room offline. A newer revision remains pending.
          access = {
            userId: queued.userId,
            revision: queued.revision,
            active: false,
            rooms: [],
            items: [],
            wireItems: [],
            sessions: {},
          };
          quarantined++;
        }
        await applyAccessSnapshot(database, access);
        await rpc(config, "firebase_access_ack", {
          p_user_id: access.userId, p_revision: access.revision,
        });
        delivered++;
      } catch (error) {
        // No destructive dequeue or retry limit: the DB entry remains pending.
        onFailure(error);
        failed++;
      }
    }
  }));

  const status = await rpc(config, "firebase_access_status", {});
  if (!Number.isSafeInteger(status?.checked_at) ||
      (status.oldest_pending_at !== null && !Number.isSafeInteger(status.oldest_pending_at))) {
    throw new Error("invalid_access_status");
  }
  // Anchor the deadline to DB observation time, NOT the time this HTTP call completes.
  // A stuck oldest job cannot be hidden by successful delivery of newer jobs.
  const validUntil = Math.min(status.checked_at, status.oldest_pending_at ?? Infinity) + SYNC_LEASE_MS;
  await database.ref("/v2/a/s/v").transaction((current) =>
    Math.max(Number.isSafeInteger(current) ? current : 0, validUntil), undefined, false);
  return {delivered, failed, quarantined, validUntil};
}

module.exports = {applyAccessSnapshot, authorizedWake, synchronizeAccess, SYNC_LEASE_MS};
