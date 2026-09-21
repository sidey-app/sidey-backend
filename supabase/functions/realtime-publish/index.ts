import { serviceRPC } from "../_shared/realtime-supabase.ts";
import { firebaseConfig, firebaseRequest, googleAccessToken, json, publishHint } from "../_shared/realtime.mjs";

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  // Invocation uses a dedicated scheduler secret, never a client token or public API key.
  const expected = Deno.env.get("SIDEY_FIREBASE_PUBLISH_SECRET");
  const supplied = request.headers.get("authorization");
  if (!expected || expected.length < 32 || supplied !== `Bearer ${expected}`) {
    return json({ error: "unauthorized" }, 401);
  }
  try {
    const config = firebaseConfig((name: string) => Deno.env.get(name));
    if (!config) return json({ enabled: false, published: 0 });
    const accessToken = await googleAccessToken(config.account);
    const worker = crypto.randomUUID();
    const deadline = Date.now() + 45000;
    // Revoke deleted/disabled Supabase sessions before processing hint traffic.
    // The Rules expiry remains the upper bound if this scheduler is unavailable.
    const expired = await serviceRPC<{session_id: string; user_id: string}[]>("expired_firebase_leases", {p_limit: 10});
    let cleaned = 0;
    for (const lease of expired) {
      if (Date.now() > deadline) break;
      const removed = await firebaseRequest(config, accessToken, `v1/leases/${lease.user_id}/${lease.session_id}`, {method: "DELETE"});
      if (!removed.ok) throw new Error("firebase_lease_cleanup_failed");
      await serviceRPC("finish_firebase_lease_cleanup", {p_session_id: lease.session_id});
      cleaned++;
    }
    const rows = await serviceRPC<Record<string, unknown>[]>("claim_firebase_hints", {
      p_worker: worker, p_limit: 20,
    });
    let published = 0;
    let failed = 0;
    // Bounded batch + serial writes. Retry is DB claim expiry, no unbounded loop.
    for (const row of rows) {
      if (Date.now() > deadline) break;
      try {
        await publishHint(config, accessToken, row);
        const finished = await serviceRPC<boolean>("finish_firebase_hint", {
          p_worker: worker, p_revision: row.revision,
        });
        if (finished) published++;
      } catch { failed++; }
    }
    return json({ enabled: true, claimed: rows.length, published, failed, cleaned });
  } catch { return json({ error: "realtime_publish_unavailable" }, 503); }
});
