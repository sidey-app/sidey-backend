"use strict";

const {randomUUID} = require("node:crypto");
const {accessRpc} = require("./supabase");

const BATCH_SIZE = 100;
const REVISION_PATTERN = /^[0-9]{20}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseRoomRevisionJob(job) {
  const recipients = Array.isArray(job?.recipients) ? job.recipients : null;
  if (
    !job ||
    typeof job.room_id !== "string" ||
    !UUID_PATTERN.test(job.room_id) ||
    typeof job.revision !== "string" ||
    !REVISION_PATTERN.test(job.revision) ||
    typeof job.deleted !== "boolean" ||
    recipients === null ||
    recipients.length > 12 ||
    recipients.some((userId) => typeof userId !== "string" || !UUID_PATTERN.test(userId))
  ) {
    throw new Error("invalid_room_revision_job");
  }
  const recipientIds = [...new Set(recipients.map((userId) => userId.toLowerCase()))];
  if (recipientIds.length !== recipients.length) throw new Error("invalid_room_revision_job");
  return {
    roomId: job.room_id.toLowerCase(),
    revision: job.revision,
    deleted: job.deleted,
    recipientIds,
  };
}

function parseFilteredRecipients(value, claimedRecipientIds) {
  if (
    !Array.isArray(value) ||
    value.length > 12 ||
    value.some((userId) => typeof userId !== "string" || !UUID_PATTERN.test(userId))
  ) {
    throw new Error("invalid_room_revision_recipients");
  }
  const claimed = new Set(claimedRecipientIds);
  const recipientIds = [...new Set(value.map((userId) => userId.toLowerCase()))];
  if (
    recipientIds.length !== value.length ||
    recipientIds.some((userId) => !claimed.has(userId))
  ) {
    throw new Error("invalid_room_revision_recipients");
  }
  return recipientIds;
}

async function currentRoomRevisionRecipients(rpc, config, job) {
  return parseFilteredRecipients(await rpc(
    config,
    "filter_firebase_room_revision_recipients",
    {p_room_id: job.roomId, p_recipients: job.recipientIds},
  ), job.recipientIds);
}

async function removeRoomRevisionAtMost(database, userId, roomId, revision) {
  await database.ref(`/v2/n/${userId}/r/${roomId}/v`).transaction((current) => {
    if (current === null || current === undefined) return;
    if (typeof current !== "string" || !REVISION_PATTERN.test(current)) {
      throw new Error("invalid_room_revision_remote");
    }
    if (current > revision) return;
    return null;
  }, undefined, false);
}

async function removeExcludedRoomRevisionRecipients(database, job, currentRecipientIds) {
  const current = new Set(currentRecipientIds);
  await Promise.all(job.recipientIds
    .filter((userId) => !current.has(userId))
    .map((userId) => removeRoomRevisionAtMost(
      database, userId, job.roomId, job.revision,
    )));
}

async function applyRoomRevision(database, job) {
  const parsed = parseRoomRevisionJob(job);
  if (parsed.deleted) {
    const tombstoneRef = database.ref(`/v2/a/d/${parsed.roomId}`);
    const existingTombstone = (await tombstoneRef.get()).val();
    if (existingTombstone !== null && existingTombstone !== undefined &&
        (typeof existingTombstone !== "string" || !REVISION_PATTERN.test(existingTombstone))) {
      throw new Error("invalid_room_tombstone_remote");
    }
    // The server-only tombstone and cleanup land atomically. Rules consult the
    // tombstone, so stale membership mirrors cannot recreate client slots. A
    // deletion is deliberately ACKed only after a later claim observes the
    // tombstone and repeats this cleanup. The room claim is 90 seconds while
    // every publisher invocation is capped at 60 seconds, so the second pass
    // closes the ambiguous-ACK window of an in-flight chat publisher.
    const updates = {
      [`v2/a/d/${parsed.roomId}`]: parsed.revision,
      [`v2/l/${parsed.roomId}`]: null,
    };
    for (const userId of parsed.recipientIds) {
      updates[`v2/n/${userId}/r/${parsed.roomId}`] = null;
    }
    await database.ref().update(updates);
    return {...parsed, deletionConfirmed: existingTombstone !== null &&
      existingTombstone !== undefined};
  }

  const tombstone = (await database.ref(`/v2/a/d/${parsed.roomId}`).get()).val();
  if (tombstone !== null && tombstone !== undefined) {
    if (typeof tombstone !== "string" || !REVISION_PATTERN.test(tombstone)) {
      throw new Error("invalid_room_tombstone_remote");
    }
    // Room UUIDs are never reused. Any deletion fence permanently suppresses
    // a delayed non-delete delivery, irrespective of its apparent revision.
    return parsed;
  }

  await Promise.all(parsed.recipientIds.map(async (userId) => {
    await database.ref(`/v2/n/${userId}/r/${parsed.roomId}/v`).transaction((current) => {
      if (current !== null && current !== undefined) {
        if (typeof current !== "string" || !REVISION_PATTERN.test(current)) {
          throw new Error("invalid_room_revision_remote");
        }
        if (current >= parsed.revision) return;
      }
      return parsed.revision;
    }, undefined, false);
  }));
  return parsed;
}

async function synchronizeRoomRevisions({
  database,
  config,
  rpc = accessRpc,
  workerId = randomUUID(),
}) {
  if (!UUID_PATTERN.test(workerId)) throw new Error("invalid_room_revision_worker");
  const rows = await rpc(config, "claim_firebase_room_revisions", {
    p_worker: workerId,
    p_limit: BATCH_SIZE,
  });
  if (!Array.isArray(rows) || rows.length > BATCH_SIZE) {
    throw new Error("invalid_room_revision_batch");
  }

  let delivered = 0;
  let deleted = 0;
  let deferred = 0;
  let failed = 0;
  let cursor = 0;
  await Promise.all(Array.from({length: Math.min(10, rows.length)}, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      try {
        const claimedJob = parseRoomRevisionJob(row);
        let job;
        if (claimedJob.deleted) {
          job = await applyRoomRevision(database, row);
        } else {
          // A claim-time recipient list is only an upper bound. Clean any
          // ambiguous older delivery, intersect immediately before publish,
          // then recheck after publish. If the process dies between those
          // steps, the durable claim retry performs the same cleanup.
          const beforePublish = await currentRoomRevisionRecipients(rpc, config, claimedJob);
          await removeExcludedRoomRevisionRecipients(database, claimedJob, beforePublish);
          job = await applyRoomRevision(database, {
            room_id: claimedJob.roomId,
            revision: claimedJob.revision,
            deleted: false,
            recipients: beforePublish,
          });
          const afterPublish = await currentRoomRevisionRecipients(rpc, config, claimedJob);
          await removeExcludedRoomRevisionRecipients(database, claimedJob, afterPublish);
        }
        if (job.deleted && !job.deletionConfirmed) {
          // Keep the durable claim pending. Its lease expiry guarantees a
          // second cleanup after every at-most-60-second publisher has ended.
          deferred++;
          continue;
        }
        const acknowledged = await rpc(config, "ack_firebase_room_revision", {
          p_worker: workerId,
          p_room_id: job.roomId,
          p_revision: job.revision,
          p_deleted: job.deleted,
        });
        if (acknowledged !== true) throw new Error("room_revision_claim_lost");
        delivered++;
        if (job.deleted) deleted++;
      } catch {
        // The database claim expires after the function hard timeout. Failed or
        // ambiguous work remains durable and every remote operation is idempotent.
        failed++;
      }
    }
  }));

  return {claimed: rows.length, delivered, deleted, deferred, failed};
}

module.exports = {
  BATCH_SIZE,
  applyRoomRevision,
  currentRoomRevisionRecipients,
  parseRoomRevisionJob,
  removeRoomRevisionAtMost,
  synchronizeRoomRevisions,
};
