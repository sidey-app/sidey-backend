"use strict";

const {randomUUID} = require("node:crypto");
const {accessRpc} = require("./supabase");

const BATCH_SIZE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WIRE_CODE_PATTERN = /^[1-9][0-9]{0,5}$/;
const segmenter = new Intl.Segmenter("und", {granularity: "grapheme"});

class RealtimeChatError extends Error {
  constructor(code) {
    super(code);
    this.name = "RealtimeChatError";
    this.code = code;
  }
}

function parseRealtimeChatRequest(data, auth) {
  if (
    !auth || typeof auth.uid !== "string" || !UUID_PATTERN.test(auth.uid) ||
    typeof auth.token?.sideySessionId !== "string" ||
    !UUID_PATTERN.test(auth.token.sideySessionId)
  ) {
    throw new RealtimeChatError("authentication_required");
  }
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      Object.keys(data).sort().join(",") !== "b,i,r" ||
      typeof data.r !== "string" || !UUID_PATTERN.test(data.r) ||
      typeof data.i !== "string" || !UUID_PATTERN.test(data.i) ||
      typeof data.b !== "string") {
    throw new RealtimeChatError("invalid_argument");
  }

  const body = data.b.normalize("NFC").trim();
  if (
    body.includes("\r") ||
    body.split("\n").length > 3 ||
    Buffer.byteLength(body, "utf8") > 16_384
  ) {
    throw new RealtimeChatError("invalid_message_body");
  }
  let graphemes = 0;
  for (const _ of segmenter.segment(body)) {
    graphemes++;
    if (graphemes > 200) break;
  }
  if (graphemes < 1 || graphemes > 200) {
    throw new RealtimeChatError("invalid_message_body");
  }

  return {
    roomId: data.r.toLowerCase(),
    messageId: data.i.toLowerCase(),
    senderId: auth.uid.toLowerCase(),
    sessionId: auth.token.sideySessionId.toLowerCase(),
    body,
  };
}

function parseRecipientIds(value) {
  if (!Array.isArray(value) || value.length > 12 ||
      value.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))) {
    throw new Error("invalid_chat_recipients");
  }
  const recipients = [...new Set(value.map((id) => id.toLowerCase()))];
  if (recipients.length !== value.length) throw new Error("invalid_chat_recipients");
  return recipients;
}

function parseChatEvent(value, {requireRecipients = false} = {}) {
  const payload = value?.payload ?? value;
  if (
    !payload || typeof payload !== "object" || Array.isArray(payload) ||
    typeof payload.i !== "string" || !UUID_PATTERN.test(payload.i) ||
    typeof payload.r !== "string" || !UUID_PATTERN.test(payload.r) ||
    typeof payload.s !== "string" || !UUID_PATTERN.test(payload.s) ||
    typeof payload.b !== "string" || payload.b.length < 1 ||
    !Number.isSafeInteger(payload.t) || payload.t <= 0 ||
    !Number.isSafeInteger(payload.n) || payload.n < 1 ||
    (payload.k !== undefined &&
      (typeof payload.k !== "string" || !WIRE_CODE_PATTERN.test(payload.k)))
  ) {
    throw new Error("invalid_chat_event");
  }
  const event = {
    i: payload.i.toLowerCase(),
    r: payload.r.toLowerCase(),
    s: payload.s.toLowerCase(),
    b: payload.b,
    t: payload.t,
    n: payload.n,
  };
  if (payload.k !== undefined) event.k = payload.k;
  if (requireRecipients) event.recipients = parseRecipientIds(payload.recipients);
  return event;
}

function parseRecipientFilter(value, claimedRecipients) {
  if (!value || typeof value.valid !== "boolean") {
    throw new Error("invalid_chat_recipient_filter");
  }
  const recipients = parseRecipientIds(value.recipients);
  const claimed = new Set(claimedRecipients);
  if (recipients.some((id) => !claimed.has(id))) {
    throw new Error("invalid_chat_recipient_filter");
  }
  return {valid: value.valid, recipients};
}

async function currentRecipients(rpc, config, workerId, event) {
  return parseRecipientFilter(await rpc(config, "filter_firebase_chat_recipients", {
    p_worker: workerId,
    p_room_id: event.r,
    p_message_id: event.i,
    p_sequence: event.n,
    p_recipients: event.recipients,
  }), event.recipients);
}

function parseRemoteSequence(value, code) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
}

async function removeInboxMarkerAtMost(database, userId, roomId, sequence) {
  await database.ref(`/v2/n/${userId}/r/${roomId}/n`).transaction((current) => {
    const existing = parseRemoteSequence(current, "invalid_chat_inbox_remote");
    if (existing === null || existing > sequence) return;
    return null;
  }, undefined, false);
}

async function removeExcludedRecipients(database, event, included) {
  const current = new Set(included);
  await Promise.all(event.recipients
    .filter((userId) => !current.has(userId))
    .map((userId) => removeInboxMarkerAtMost(database, userId, event.r, event.n)));
}

async function applyChatEvent(database, event, recipients) {
  const tombstonePath = `/v2/a/d/${event.r}`;
  if ((await database.ref(tombstonePath).get()).val() !== null) {
    await removeExactChatSlot(database, {
      messageId: event.i, roomId: event.r, sequence: event.n, recipients,
    });
    return false;
  }
  const livePath = `/v2/l/${event.r}/e`;
  const live = (await database.ref(livePath).get()).val();
  let liveSequence = null;
  if (live !== null && live !== undefined) {
    if (typeof live !== "object" || Array.isArray(live)) {
      throw new Error("invalid_chat_event_remote");
    }
    liveSequence = parseRemoteSequence(live.n, "invalid_chat_event_remote");
    if (liveSequence === event.n && live.i !== event.i) {
      throw new Error("chat_sequence_conflict_remote");
    }
  }

  const updates = {};
  if (liveSequence === null || liveSequence < event.n) {
    const compact = {i: event.i, s: event.s, b: event.b, t: event.t, n: event.n};
    if (event.k !== undefined) compact.k = event.k;
    updates[`v2/l/${event.r}/e`] = compact;
  }
  for (const userId of recipients) {
    const path = `/v2/n/${userId}/r/${event.r}/n`;
    const current = parseRemoteSequence(
      (await database.ref(path).get()).val(),
      "invalid_chat_inbox_remote",
    );
    if (current === null || current < event.n) updates[path.slice(1)] = event.n;
  }
  if (Object.keys(updates).length) await database.ref().update(updates);

  const verifiedLive = (await database.ref(livePath).get()).val();
  if (!verifiedLive || parseRemoteSequence(
    verifiedLive.n, "invalid_chat_event_remote",
  ) < event.n) throw new Error("chat_event_not_converged");
  for (const userId of recipients) {
    const marker = parseRemoteSequence(
      (await database.ref(`/v2/n/${userId}/r/${event.r}/n`).get()).val(),
      "invalid_chat_inbox_remote",
    );
    if (marker === null || marker < event.n) throw new Error("chat_inbox_not_converged");
  }
  // A deletion can race the multi-location publish. Its tombstone is written
  // in the same atomic update as root cleanup; a final fence check removes an
  // in-flight exact slot before the durable claim is acknowledged.
  if ((await database.ref(tombstonePath).get()).val() !== null) {
    await removeExactChatSlot(database, {
      messageId: event.i, roomId: event.r, sequence: event.n, recipients,
    });
    return false;
  }
  return true;
}

async function removeExactChatSlot(database, cleanup) {
  await database.ref(`/v2/l/${cleanup.roomId}/e`).transaction((current) => {
    if (current === null || current === undefined) return;
    if (typeof current !== "object" || Array.isArray(current) ||
        parseRemoteSequence(current.n, "invalid_chat_event_remote") === null) {
      throw new Error("invalid_chat_event_remote");
    }
    if (current.i === cleanup.messageId && current.n === cleanup.sequence) return null;
  }, undefined, false);
  await Promise.all(cleanup.recipients.map(async (userId) => {
    await database.ref(`/v2/n/${userId}/r/${cleanup.roomId}/n`).transaction((current) => {
      const existing = parseRemoteSequence(current, "invalid_chat_inbox_remote");
      if (existing === cleanup.sequence) return null;
    }, undefined, false);
  }));
}

function parseCleanup(value) {
  if (!value || typeof value.message_id !== "string" || !UUID_PATTERN.test(value.message_id) ||
      typeof value.room_id !== "string" || !UUID_PATTERN.test(value.room_id) ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new Error("invalid_chat_cleanup");
  }
  return {
    messageId: value.message_id.toLowerCase(),
    roomId: value.room_id.toLowerCase(),
    sequence: value.sequence,
    recipients: parseRecipientIds(value.recipients),
  };
}

async function synchronizeRealtimeChat({
  database,
  config,
  rpc = accessRpc,
  workerId = randomUUID(),
}) {
  if (!UUID_PATTERN.test(workerId)) throw new Error("invalid_chat_worker");
  const rows = await rpc(config, "claim_firebase_chat_publications", {
    p_worker: workerId, p_limit: BATCH_SIZE,
  });
  if (!Array.isArray(rows) || rows.length > BATCH_SIZE) throw new Error("invalid_chat_batch");

  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const event = parseChatEvent(row, {requireRecipients: true});
      const before = await currentRecipients(rpc, config, workerId, event);
      await removeExcludedRecipients(database, event, before.recipients);
      if (before.valid) await applyChatEvent(database, event, before.recipients);
      else await removeExactChatSlot(database, {
        messageId: event.i, roomId: event.r, sequence: event.n,
        recipients: event.recipients,
      });
      const after = await currentRecipients(rpc, config, workerId, event);
      await removeExcludedRecipients(database, event, after.recipients);
      if (!after.valid) await removeExactChatSlot(database, {
        messageId: event.i, roomId: event.r, sequence: event.n,
        recipients: event.recipients,
      });
      const acknowledged = await rpc(config, "ack_firebase_chat_publication", {
        p_worker: workerId, p_room_id: event.r,
        p_message_id: event.i, p_sequence: event.n,
      });
      if (acknowledged !== true) throw new Error("chat_claim_lost");
      delivered++;
    } catch {
      failed++;
    }
  }

  const cleanupRows = await rpc(config, "claim_firebase_chat_cleanups", {
    p_worker: workerId, p_limit: BATCH_SIZE,
  });
  if (!Array.isArray(cleanupRows) || cleanupRows.length > BATCH_SIZE) {
    throw new Error("invalid_chat_cleanup_batch");
  }
  let cleaned = 0;
  for (const row of cleanupRows) {
    try {
      const cleanup = parseCleanup(row);
      await removeExactChatSlot(database, cleanup);
      const acknowledged = await rpc(config, "ack_firebase_chat_cleanup", {
        p_worker: workerId,
        p_message_id: cleanup.messageId,
        p_sequence: cleanup.sequence,
      });
      if (acknowledged !== true) throw new Error("chat_cleanup_claim_lost");
      cleaned++;
    } catch {
      failed++;
    }
  }
  return {claimed: rows.length, delivered, cleanupClaimed: cleanupRows.length, cleaned, failed};
}

module.exports = {
  RealtimeChatError,
  applyChatEvent,
  parseChatEvent,
  parseRealtimeChatRequest,
  removeExactChatSlot,
  synchronizeRealtimeChat,
};
