// A bounded, scheduler-owned live v2 invocation. No persistent runtime or VM required.
import { json } from "./realtime.mjs";
import { createGoogleAccessTokenCache } from "./realtime-google-token.mjs";
import { liveFirebaseConfig, UUID } from "./realtime-live.mjs";
import { LiveWorker } from "./realtime-live-publisher.mjs";

export const STAGING_REF = "fjglrvhvdthntkvrduyi";
export const STAGING_PROJECT = "sidey-realtime-staging";
export const DISPATCH_BUDGET_MS = 20000;
export const DISPATCH_ROW_LIMIT = 100;
export const DISPATCH_BATCH_LIMIT = 25;
export const DISPATCH_BATCH_COUNT = 8;
export const DISPATCH_CLEANUP_LIMIT = 10;
const counters = ["claimed", "completed", "published", "expired", "suppressed", "retries",
  "cleanupSelected", "cleanupCompleted", "cleanupRetries", "httpRequests", "responseBodyBytes",
  "rtdbResponseBodyBytes", "supabaseResponseBodyBytes", "googleAuthResponseBodyBytes",
  ...["supabase", "rtdb", "googleAuth"].flatMap(name => [name + "Requests", name + "RequestMs", name + "RequestMaxMs"])];

// Only this allowlist reaches endpoint logs; no IDs, source rows or upstream errors.
const observationStages = new Set(["handler_entry", "handler_admission", "handler_empty_claim",
  "handler_finish", "handler_complete", "wake_authorize", "wake_registered", "wake_inner_entry", "wake_inner_failed",
  ...["duplicate", "delivered", "running", "contended", "disabled", "unavailable"].map(reason => `wake_noop_${reason}`)]);
const observationNumbers = new Set(["authorizeMs", "registrationToEntryMs", "registrationToAdmissionMs", "admissionMs",
  "initialRows", "initialSourceAgeWallClockMaxMs", "initialSourceAgeSamples", "emptyToFinishMs", "elapsedMs",
  "claimed", "completed", "published", "retries",
  ...["supabase", "rtdb", "googleAuth"].flatMap(name => [name + "Requests", name + "RequestMs", name + "RequestMaxMs"])]);
const observationBooleans = new Set(["accepted", "success", "finishAcknowledged"]);
export function emitPublisherObservation(observe, stage, values = {}) {
  if (!observationStages.has(stage)) return;
  const sample = { stage };
  for (const [key, value] of Object.entries(values)) {
    if ((observationNumbers.has(key) && typeof value === "number" && Number.isFinite(value))
        || (observationBooleans.has(key) && typeof value === "boolean")) sample[key] = value;
  }
  try { observe(sample)?.catch?.(() => {}); } catch { /* Observation never changes publication. */ }
}

export function stagingLivePublisherConfig(env) {
  const config = liveFirebaseConfig(env);
  if (!config) return null;
  if (env("SUPABASE_URL") !== `https://${STAGING_REF}.supabase.co`
      || config.account.project_id !== STAGING_PROJECT
      || config.databaseURL !== `https://${STAGING_PROJECT}-default-rtdb.asia-southeast1.firebasedatabase.app`) {
    throw new Error("staging_publisher_binding_required");
  }
  return config;
}

export function measuredPublisherFetch(fetcher, stats, now = () => performance.now()) {
  return async (url, init) => {
    const host = new URL(url).hostname;
    const component = host === `${STAGING_REF}.supabase.co` ? "supabaseResponseBodyBytes"
      : host === "oauth2.googleapis.com" ? "googleAuthResponseBodyBytes"
      : host === `${STAGING_PROJECT}-default-rtdb.asia-southeast1.firebasedatabase.app` ? "rtdbResponseBodyBytes" : null;
    if (!component) throw new Error("publisher_host_not_allowed");
    stats.httpRequests++;
    const service = component.replace("ResponseBodyBytes", ""), started = now();
    stats[service + "Requests"] = (stats[service + "Requests"] ?? 0) + 1;
    try {
      const response = await fetcher(url, { ...init, redirect: "error" });
      // Consume every response, including successful PUT replies the CAS caller need not parse.
      // These decoded body bytes exclude TLS/headers, streamed client fanout, and final stats ACK.
      const reader = response.body?.getReader(); const chunks = []; let size = 0;
      if (reader) for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        stats.responseBodyBytes += value.byteLength; stats[component] += value.byteLength;
        size += value.byteLength;
        if (size > 1024 * 1024) { await reader.cancel(); throw new Error("publisher_response_limit"); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return new Response([204, 205, 304].includes(response.status) ? null : bytes,
        { status: response.status, headers: response.headers });
    } finally {
      const elapsed = Math.max(0, Math.ceil(now() - started));
      stats[service + "RequestMs"] = (stats[service + "RequestMs"] ?? 0) + elapsed;
      stats[service + "RequestMaxMs"] = Math.max(stats[service + "RequestMaxMs"] ?? 0, elapsed);
    }
  };
}

export async function drainLiveDispatch(worker, stats, signal, now, deadline, initialRows, observe = _sample => {}) {
  let nextRows = initialRows, prefetched = Array.isArray(initialRows) && initialRows.length > 0;
  try {
    for (let batch = 0; batch < DISPATCH_BATCH_COUNT && stats.claimed < DISPATCH_ROW_LIMIT; batch++) {
      if (signal.aborted || now() >= deadline - 1000) break;
      const result = await worker.batch(signal, Math.min(DISPATCH_BATCH_LIMIT, DISPATCH_ROW_LIMIT - stats.claimed),
        nextRows, { remainingRows: DISPATCH_ROW_LIMIT - stats.claimed,
          nextClaimLimit: batch + 1 < DISPATCH_BATCH_COUNT ? DISPATCH_BATCH_LIMIT : 0, claimBefore: deadline - 1000 });
      nextRows = undefined; prefetched = false;
      stats.claimed += result.claimed; stats.completed += result.completed; stats.retries += result.retries;
      if (result.claimed === 0) emitPublisherObservation(observe, "handler_empty_claim");
      if (result.claimed === 0 || result.retries > 0) break;
      if (result.nextRows !== undefined) {
        nextRows = result.nextRows; prefetched = true;
        if (nextRows.length === 0) { emitPublisherObservation(observe, "handler_empty_claim"); break; }
      }
    }
  } catch { stats.retries++; return false; }
  finally {
    // A deadline/abort may arrive after the combined transaction committed its
    // next claim. Count unprocessed work and finish unsuccessfully so it is
    // released durably; never silently report these rows as completed.
    if (prefetched && nextRows?.length) { stats.claimed += nextRows.length; stats.retries += nextRows.length; }
  }
  return !signal.aborted && stats.retries === 0 && stats.completed === stats.claimed;
}

export function createLivePublishHandler({ env, fetcher = fetch, now = Date.now,
  makeWorker = options => new LiveWorker(options), observe = _sample => {}, monotonic = () => performance.now() }) {
  // This closure lives for the warm isolate, not for one HTTP invocation.
  const accessToken = createGoogleAccessTokenCache({ now });
  return async (request, invocationObserver = observe) => {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const secret = env("SIDEY_FIREBASE_LIVE_PUBLISH_SECRET");
    if (!secret || secret.length < 32 || request.headers.get("authorization") !== `Bearer ${secret}`) {
      return json({ error: "unauthorized" }, 401);
    }
    const measuredStarted = monotonic();
    const emit = (stage, values = {}) => emitPublisherObservation(invocationObserver, stage, values);
    emit("handler_entry");
    const started = now();
    let lastEmptyAt;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(DISPATCH_BUDGET_MS)]);
    const stats = Object.fromEntries(counters.map(key => [key, 0]));
    let dispatchId, rpc, cleanupTask, accepted = false, success = false;
    try {
      const config = stagingLivePublisherConfig(env);
      if (!config) return json({ enabled: false, accepted: false });
      const key = env("SUPABASE_SERVICE_ROLE_KEY");
      if (!key) throw new Error("missing_service_role");
      const text = await request.text();
      if (text.length > 512) return json({ error: "invalid_dispatch" }, 400);
      const body = JSON.parse(text);
      if (!body || Object.keys(body).length !== 1 || typeof body.dispatchId !== "string" || !UUID.test(body.dispatchId)) {
        return json({ error: "invalid_dispatch" }, 400);
      }
      dispatchId = body.dispatchId;
      const measured = measuredPublisherFetch(fetcher, stats);
      const createRPC = transport => async (name, args, requestSignal) => {
        const response = await transport(`https://${STAGING_REF}.supabase.co/rest/v1/rpc/${name}`, {
          method: "POST", headers: { authorization: `Bearer ${key}`, apikey: key, "content-type": "application/json" },
          body: JSON.stringify(args), signal: requestSignal
            ? AbortSignal.any([requestSignal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error("live_dispatch_rpc_failed");
        // PostgREST void RPCs acknowledge success with HTTP 204 and no JSON body.
        const body = await response.text();
        return body.trim() ? JSON.parse(body) : null;
      };
      rpc = createRPC(measured);
      const admissionStarted = monotonic();
      const admission = await rpc("begin_claim_firebase_live_dispatch", { p_dispatch: dispatchId, p_limit: DISPATCH_BATCH_LIMIT }, signal);
      accepted = admission?.accepted === true;
      const sourceAges = Array.isArray(admission?.rows) ? admission.rows.map(row =>
        now() - Date.parse(row?.occurred_at)).filter(Number.isFinite) : [];
      emit("handler_admission", { admissionMs: Math.max(0, monotonic() - admissionStarted), accepted,
        initialRows: Array.isArray(admission?.rows) ? admission.rows.length : 0,
        initialSourceAgeSamples: sourceAges.length,
        ...(sourceAges.length ? { initialSourceAgeWallClockMaxMs: Math.max(...sourceAges) } : {}) });
      if (!accepted) {
        emit("handler_complete", { ...stats, accepted: false, success: false, elapsedMs: Math.max(0, monotonic() - measuredStarted) });
        return json({ enabled: true, accepted: false });
      }
      if (!Array.isArray(admission.rows) || admission.rows.length > DISPATCH_BATCH_LIMIT) throw new Error("invalid_first_claim");
      const worker = makeWorker({ config, workerId: dispatchId, now, fetcher: measured, combineClaims: true,
        rpc: (name, args, requestSignal) => {
          if (!["claim_firebase_live", "finish_firebase_live", "finish_firebase_live_batch", "finish_claim_firebase_live_dispatch", "firebase_live_maintenance", "finish_firebase_live_cleanup"].includes(name)) {
            throw new Error("invalid_publisher_rpc");
          }
          return rpc(name === "claim_firebase_live" ? "claim_firebase_live_dispatch" : name, args, requestSignal);
        },
        accessToken: () => accessToken(config.account, { fetcher: measured, signal }),
        log: stage => {
          if (stage === "publish_written") stats.published++;
          if (stage === "publish_expired") stats.expired++;
          if (stage === "publish_suppressed") stats.suppressed++;
        } });
      // Use a separate worker and ownership token: slow expiry deletion cannot occupy
      // publication's HTTP slots or retain its dispatch lease. Room access revocation
      // remains on the priority publication path.
      cleanupTask = (async () => {
        let owned = false;
        const cleanupStats = Object.fromEntries(counters.map(key => [key, 0]));
        const cleanupMeasured = measuredPublisherFetch(fetcher, cleanupStats);
        const cleanupRPC = createRPC(cleanupMeasured);
        try {
          owned = await cleanupRPC("begin_firebase_live_cleanup_dispatch", { p_dispatch: dispatchId }, signal) === true;
          if (!owned) return;
          const cleanupWorker = makeWorker({ config, workerId: dispatchId, now, fetcher: cleanupMeasured,
            accessToken: () => accessToken(config.account, { fetcher: cleanupMeasured, signal }),
            rpc: (name, args, requestSignal) => {
              if (name === "firebase_live_maintenance") return cleanupRPC("firebase_live_owned_maintenance", { ...args, p_worker: dispatchId }, requestSignal);
              if (name === "finish_firebase_live_cleanup") return cleanupRPC("finish_firebase_live_owned_cleanup", { ...args, p_worker: dispatchId }, requestSignal);
              throw new Error("invalid_cleanup_rpc");
            } });
          const result = await cleanupWorker.cleanup(signal, DISPATCH_CLEANUP_LIMIT);
          cleanupStats.cleanupSelected = result.selected; cleanupStats.cleanupCompleted = result.completed;
          cleanupStats.cleanupRetries = result.retries;
        } catch { cleanupStats.cleanupRetries++; }
        finally {
          if (owned) {
            try {
              if (await cleanupRPC("finish_firebase_live_cleanup_dispatch", { p_dispatch: dispatchId,
                p_stats: { ...cleanupStats, elapsedMs: Math.max(0, Math.floor(now() - started)) } }) !== true) {
                cleanupStats.cleanupRetries++;
              }
            } catch { cleanupStats.cleanupRetries++; }
          }
          for (const key of ["cleanupSelected", "cleanupCompleted", "cleanupRetries"]) stats[key] += cleanupStats[key];
        }
      })();
      success = await drainLiveDispatch(worker, stats, signal, now, started + DISPATCH_BUDGET_MS, admission.rows, sample => {
        if (sample.stage === "handler_empty_claim") lastEmptyAt = monotonic();
        emit(sample.stage, sample);
      });
    } catch { success = false; }
    if (!accepted) {
      emit("handler_complete", { ...stats, accepted: false, success: false, elapsedMs: Math.max(0, monotonic() - measuredStarted) });
      return json({ error: "live_dispatch_unavailable" }, 503);
    }
    // Publication ownership ends as soon as durable work settles. Cleanup has its
    // own fence and continues safely alongside the next publication invocation.
    const snapshot = { ...stats, cleanupSelected: 0, cleanupCompleted: 0, cleanupRetries: 0,
      elapsedMs: Math.max(0, Math.floor(now() - started)) };
    let finishError;
    try {
      const finished = await rpc("finish_firebase_live_dispatch", { p_dispatch: dispatchId, p_success: success, p_stats: snapshot });
      if (finished !== true) finishError = "live_dispatch_lease_lost";
    } catch { finishError = "live_dispatch_finish_failed"; }
    emit("handler_finish", { finishAcknowledged: !finishError,
      ...(lastEmptyAt === undefined ? {} : { emptyToFinishMs: Math.max(0, monotonic() - lastEmptyAt) }) });
    await cleanupTask;
    emit("handler_complete", { ...stats, accepted, success: success && !finishError && stats.cleanupRetries === 0,
      elapsedMs: Math.max(0, monotonic() - measuredStarted) });
    if (finishError) return json({ error: finishError }, 503);
    const result = { ...snapshot, cleanupSelected: stats.cleanupSelected,
      cleanupCompleted: stats.cleanupCompleted, cleanupRetries: stats.cleanupRetries };
    success = success && stats.cleanupRetries === 0;
    return json({ enabled: true, accepted: true, success, stats: result }, success ? 200 : 503);
  };
}
