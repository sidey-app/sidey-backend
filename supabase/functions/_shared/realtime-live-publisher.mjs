// Runtime-neutral v2 publisher shared by bounded Deno invocations and the Node CLI.
import { UUID, REVISION, DB_KINDS, EVENT_KINDS, liveFirebaseRequest,
  liveRoomPath, validateAccess, liveHint, liveEvent } from "./realtime-live.mjs";

// These SQL-authorized notifications never grant room access. Enrollment and
// membership/cohort changes enqueue priority control/structure_changed rows;
// bootstrap verifies the published access snapshot before arming a reader lease.
const notificationOnly = row => row.kind === "message_changed" || row.kind === "messages_pruned";

export class LiveWorker {
  constructor({ config, rpc, accessToken, fetcher = fetch, now = Date.now, log = () => {}, workerId = crypto.randomUUID(), combineClaims = false }) {
    if (!UUID.test(workerId)) throw new Error("invalid_worker");
    Object.assign(this, { config, rpc, accessToken, fetcher, now, log, workerId });
    this.combineClaims = combineClaims === true;
    this.activeRequests = 0; this.waiters = [];
  }
  async request(path, init = {}, notAfter) {
    init.signal?.throwIfAborted();
    if (this.activeRequests >= 8) await new Promise(resolve => this.waiters.push(resolve));
    else this.activeRequests++;
    try {
      init.signal?.throwIfAborted();
      const token = await this.accessToken();
      init.signal?.throwIfAborted();
      if (notAfter !== undefined && this.now() >= notAfter) throw new Error("live_event_expired");
      return await liveFirebaseRequest(this.config, token, path, init, this.fetcher);
    } finally {
      const next = this.waiters.shift();
      if (next) next(); else this.activeRequests--;
    }
  }
  // Return the winning snapshot, including one published concurrently by a newer worker.
  async cas(path, select, signal, committed = () => {}) {
    for (let attempt = 0; attempt < 5; attempt++) {
      signal?.throwIfAborted();
      const response = await this.request(path, { signal, headers: { "X-Firebase-ETag": "true" } });
      if (!response.ok) throw new Error("live_read_failed");
      const current = await response.json();
      const next = select(current);
      if (next === undefined) return current;
      const etag = response.headers.get("etag");
      if (!etag) throw new Error("live_etag_missing");
      const written = await this.request(path, { signal, method: "PUT", headers: { "if-match": etag }, body: JSON.stringify(next) });
      if (written.status === 412) continue;
      if (!written.ok) throw new Error("live_write_failed");
      committed();
      return next;
    }
    throw new Error("live_contention");
  }
  async syncAccess(room, proposed, signal) {
    if (!UUID.test(room)) throw new Error("invalid_live_room");
    proposed = validateAccess(proposed);
    return this.cas(`v2/access/${room}`, current => {
      if (current !== null && BigInt(validateAccess(current).revision) >= BigInt(proposed.revision)) return undefined;
      return proposed;
    }, signal);
  }
  async publish(row, signal, batchAccess, deferFinish = false) {
    if (typeof row.id !== "string" || !REVISION.test(row.id) || !UUID.test(row.room_id)) throw new Error("invalid_live_row");
    const proposed = validateAccess(row.access);
    let disposition = row.kind === "control" && EVENT_KINDS.has(row.original_kind)
      && Date.parse(row.occurred_at) + 5000 <= this.now() ? "expired" : "suppressed";
    const written = () => { disposition = "published"; this.log("publish_written"); };
    const access = batchAccess ?? (notificationOnly(row) ? proposed : await this.syncAccess(row.room_id, proposed, signal));
    // Notifications can finish in their previously approved epoch after a control
    // revokes it. They cannot restore access or enter its replacement epoch; Rules
    // still deny the revoked reader. Hint CAS independently preserves revision order.
    if (access.enabled && row.epoch === access.epoch) {
      const roomPath = liveRoomPath(row.room_id, row.epoch);
      if (DB_KINDS.has(row.kind)) {
        const next = liveHint(row);
        await this.cas(`${roomPath}/hint`, current => {
          if (current !== null) {
            if (current.protocolVersion !== 2 || current.roomId !== row.room_id || current.epoch !== row.epoch
                || typeof current.revision !== "string" || !REVISION.test(current.revision)) throw new Error("invalid_current_hint");
            if (BigInt(current.revision) >= BigInt(next.revision)) return undefined;
          }
          return next;
        }, signal, written);
      } else if (EVENT_KINDS.has(row.kind)) {
        const event = liveEvent(row);
        if (event.expiresAt <= this.now()) disposition = "expired";
        if (event.expiresAt > this.now() && event.occurredAt <= this.now() + 1000) {
          // Immutable event UUID makes retries idempotent; never extend the original TTL.
          // Immutable event UUID: create only if absent. A normal publication
          // needs one request; the 412 response contains the existing value.
          // Never replace a collision or extend a retry's original expiry.
          try {
            const response = await this.request(`${roomPath}/events/${row.event_id}`, {
              signal, method: "PUT", headers: { "if-match": "null_etag" }, body: JSON.stringify(event) }, event.expiresAt);
            if (response.status === 412) {
              const current = await response.json();
              if (current === null) throw new Error("live_contention");
              if (current.revision !== event.revision) throw new Error("live_event_collision");
            } else {
              if (!response.ok) throw new Error("live_write_failed");
              written();
            }
          } catch (error) {
            if (error?.message !== "live_event_expired") throw error;
            disposition = "expired";
          }
        }
      } else if (row.kind !== "control") throw new Error("invalid_live_kind");
    }
    if (disposition !== "published") this.log(`publish_${disposition}`);
    signal?.throwIfAborted();
    if (deferFinish) return row.id;
    const finished = await this.rpc("finish_firebase_live", { p_worker: this.workerId, p_id: row.id }, signal);
    if (finished === false) throw new Error("live_claim_lost");
  }
  async batch(parentSignal, limit = 100, initialRows, continuation) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_batch_limit");
    if (continuation && (!Number.isInteger(continuation.remainingRows) || continuation.remainingRows < 1 || continuation.remainingRows > 100
        || !Number.isInteger(continuation.nextClaimLimit) || continuation.nextClaimLimit < 0 || continuation.nextClaimLimit > 25
        || !Number.isFinite(continuation.claimBefore))) throw new Error("invalid_pipeline_options");
    const timeout = AbortSignal.timeout(20000);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
    const rows = initialRows ?? await this.rpc("claim_firebase_live", { p_worker: this.workerId, p_limit: limit }, signal);
    if (!Array.isArray(rows) || rows.length > limit) throw new Error("invalid_claim_batch");
    const result = { claimed: rows.length, completed: 0, retries: 0 };
    const completedIDs = [];
    const grouped = new Map();
    for (const row of rows) {
      if (!grouped.has(row.room_id)) grouped.set(row.room_id, []);
      grouped.get(row.room_id).push(row);
    }
    const groups = [...grouped.values()];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(8, groups.length) }, async () => {
      while (cursor < groups.length && !signal.aborted) {
        const rows = groups[cursor++];
        let access;
        try {
          // Only control/structure and the existing legacy-event path synchronize
          // access. A notification-only room batch uses the authoritative SQL
          // snapshot without reading or modifying RTDB access. Mixed batches
          // finish their access CAS before any notification, retaining a newer
          // remote revocation/epoch winner.
          const proposed = rows.map(row => validateAccess(row.access)).reduce((a, b) =>
            BigInt(a.revision) >= BigInt(b.revision) ? a : b);
          access = rows.every(notificationOnly) ? proposed : await this.syncAccess(rows[0].room_id, proposed, signal);
        } catch {
          result.retries += rows.length;
          for (const _ of rows) this.log("publish_retry");
          continue;
        }
        for (const row of rows) {
          if (signal.aborted) break;
          try { await this.publish(row, signal, access, true); completedIDs.push(row.id); }
          catch { result.retries++; this.log("publish_retry"); } // Never log IDs, payloads or upstream errors.
        }
      }
    }));
    if (completedIDs.length) {
      try {
        signal.throwIfAborted();
        // The CLI/default worker retains its original independent ACK contract.
        // Only fully settled Edge batches may preclaim within the remaining budget.
        const nextLimit = this.combineClaims && continuation && completedIDs.length === rows.length
          && this.now() < continuation.claimBefore
          ? Math.min(continuation.nextClaimLimit, Math.max(0, continuation.remainingRows - rows.length)) : 0;
        const response = nextLimit > 0
          ? await this.rpc("finish_claim_firebase_live_dispatch", { p_worker: this.workerId, p_ids: completedIDs,
            p_limit: nextLimit, p_claim_before: new Date(continuation.claimBefore).toISOString() }, signal)
          : await this.rpc("finish_firebase_live_batch", { p_worker: this.workerId, p_ids: completedIDs }, signal);
        const finished = nextLimit > 0 ? response?.completed : response;
        if (!Array.isArray(finished) || new Set(finished).size !== finished.length
            || finished.some(id => typeof id !== "string" || !completedIDs.includes(id))) throw new Error("invalid_finish_batch");
        if (nextLimit > 0) {
          const nextRows = response?.rows;
          if (!Array.isArray(nextRows) || nextRows.length > nextLimit
              || (finished.length !== completedIDs.length && nextRows.length > 0)
              || new Set(nextRows.map(row => row?.id)).size !== nextRows.length
              || nextRows.some(row => typeof row?.id !== "string" || !REVISION.test(row.id) || completedIDs.includes(row.id))) {
            throw new Error("invalid_next_claim");
          }
          result.nextRows = nextRows;
        }
        result.completed = finished.length;
        for (const _ of finished) this.log("publish_ok");
      } catch { /* An ambiguous ACK remains durable; identical hint/event retries are idempotent. */ }
    }
    for (let i = result.completed; i < completedIDs.length; i++) this.log("publish_retry");
    result.retries = result.claimed - result.completed;
    return result;
  }
  async cleanup(parentSignal, limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_cleanup_limit");
    const timeout = AbortSignal.timeout(20000);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
    const value = await this.rpc("firebase_live_maintenance", { p_limit: limit }, signal);
    const sets = [value?.leases, value?.events, value?.epochs, value?.directEvents ?? []];
    if (sets.some(set => !Array.isArray(set) || set.length > limit)) throw new Error("invalid_cleanup_batch");
    const result = { selected: sets.reduce((sum, set) => sum + set.length, 0), completed: 0, retries: 0 };
    const jobs = [];
    for (const lease of value.leases) jobs.push(async () => {
      try {
        if (!UUID.test(lease.user_id) || !UUID.test(lease.session_id) || !Number.isSafeInteger(lease.expires_at)
            || typeof lease.revision !== "string" || !REVISION.test(lease.revision)
            || !lease.rooms || typeof lease.rooms !== "object"
            || Object.keys(lease.rooms).length > 5) throw new Error("invalid_cleanup_lease");
        const cleanupStarted = this.now();
        const tombstone = { revision: lease.revision, revoked: true, expiresAt: 0 };
        const purge = lease.purge === true;
        if (purge && lease.expires_at >= this.now() - 60000) throw new Error("premature_lease_purge");
        const remaining = await this.cas(`v2/leases/${lease.user_id}/${lease.session_id}`, current => {
          if (current !== null) {
            if (typeof current.revision !== "string" || !REVISION.test(current.revision)) throw new Error("invalid_current_lease");
            const order = BigInt(current.revision) - BigInt(lease.revision);
            if (order > 0n) return undefined;
            if (order === 0n) {
              if (current.revoked === true) return purge ? null : undefined;
              if (current.expiresAt !== lease.expires_at) return undefined;
            }
            // A prepared renewal may have failed before arming RTDB. Its older
            // remote generation must still be revoked by the current SQL lease.
          } else if (purge) return null;
          return tombstone;
        }, signal);
        if (purge ? remaining !== null : remaining?.revoked !== true || remaining.revision !== lease.revision) return;
        // Keep a tombstone until the issuer expiry plus grace; final purge must
        // succeed remotely before SQL forgets the cleanup address.
        for (const [room, epoch] of Object.entries(lease.rooms)) {
          const path = `${liveRoomPath(room, epoch)}/presence/${lease.user_id}/${lease.session_id}`;
          await this.cas(path, current => current !== null && current.updatedAt >= cleanupStarted ? undefined : null, signal);
        }
        await this.rpc("finish_firebase_live_cleanup", { p_kind: "lease", p_id: lease.session_id }, signal);
        result.completed++;
        this.log("cleanup_lease_ok");
      } catch { result.retries++; this.log("cleanup_lease_retry"); }
    });
    for (const event of [...value.events, ...(value.directEvents ?? []).map(event => ({ ...event, direct: true }))]) jobs.push(async () => {
      try {
        if (!UUID.test(event.event_id) || typeof event.id !== "string" || !(event.direct ? UUID : REVISION).test(event.id)
            || !Number.isSafeInteger(event.expires_at) || event.expires_at > this.now()) throw new Error("invalid_cleanup_event");
        const remaining = await this.cas(`${liveRoomPath(event.room_id, event.epoch)}/events/${event.event_id}`, current => {
          if (current !== null && current.expiresAt !== event.expires_at) return undefined;
          return null;
        }, signal);
        if (remaining !== null) return;
        await this.rpc("finish_firebase_live_cleanup", { p_kind: event.direct ? "direct_event" : "event", p_id: event.id }, signal);
        result.completed++;
        this.log("cleanup_event_ok");
      } catch { result.retries++; this.log("cleanup_event_retry"); }
    });
    for (const epoch of value.epochs) jobs.push(async () => {
      try {
        const path = liveRoomPath(epoch.room_id, epoch.epoch);
        const accessResponse = await this.request(`v2/access/${epoch.room_id}`, { signal });
        if (!accessResponse.ok) throw new Error("live_access_read_failed");
        const access = await accessResponse.json();
        if (access !== null && validateAccess(access).enabled && access.epoch <= epoch.epoch) return;
        const removed = await this.request(path, { signal, method: "DELETE" });
        if (!removed.ok) throw new Error("live_epoch_delete_failed");
        await this.rpc("finish_firebase_live_cleanup", { p_kind: "epoch", p_id: "", p_room_id: epoch.room_id, p_epoch: epoch.epoch }, signal);
        result.completed++;
        this.log("cleanup_epoch_ok");
      } catch { result.retries++; this.log("cleanup_epoch_retry"); }
    });
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, async () => {
      while (cursor < jobs.length && !signal.aborted) await jobs[cursor++]();
    }));
    return result;
  }
}
