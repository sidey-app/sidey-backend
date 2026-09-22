// Optional local CLI adapter. Staging Edge publishing uses realtime-publish-live.
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { googleAccessToken } from "../../supabase/functions/_shared/realtime.mjs";
import { liveFirebaseConfig } from "../../supabase/functions/_shared/realtime-live.mjs";
import { LiveWorker } from "../../supabase/functions/_shared/realtime-live-publisher.mjs";
export { LiveWorker };

export async function runWorker(env = key => process.env[key], signal) {
  const config = liveFirebaseConfig(env);
  if (!config) throw new Error("live_not_approved");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("missing_service_role");
  const rpc = async (name, body, signal) => {
    if (!["claim_firebase_live", "finish_firebase_live", "finish_firebase_live_batch", "firebase_live_maintenance", "finish_firebase_live_cleanup"].includes(name)) throw new Error("invalid_rpc");
    const response = await fetch(`${env("SUPABASE_URL")}/rest/v1/rpc/${name}`, {
      method: "POST", headers: { authorization: `Bearer ${key}`, apikey: key, "content-type": "application/json" },
      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), redirect: "error" });
    if (!response.ok) throw new Error("live_rpc_failed");
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  let token, tokenExpires = 0;
  const accessToken = async () => {
    if (!token || Date.now() >= tokenExpires) {
      // Cache the promise too, so concurrent publishing needs one OAuth exchange.
      token = googleAccessToken(config.account).catch(error => { token = undefined; tokenExpires = 0; throw error; });
      tokenExpires = Date.now() + 240000;
    }
    return token;
  };
  const worker = new LiveWorker({ config, rpc, accessToken, log: stage => console.log(stage) });
  const loop = async (work, interval, failure) => {
    while (!signal?.aborted) {
      const started = Date.now();
      try { await work(); } catch { console.log(failure); }
      try { await delay(Math.max(0, interval - (Date.now() - started)), undefined, { signal }); }
      catch { if (!signal?.aborted) throw new Error("worker_wait_failed"); }
    }
  };
  // Maintenance cannot be starved by a full or slow publication batch.
  await Promise.all([
    loop(() => worker.batch(signal), 500, "batch_retry"),
    loop(() => worker.cleanup(signal), 1000, "maintenance_retry"),
  ]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  runWorker(undefined, controller.signal).catch(() => { console.error("live_worker_failed"); process.exitCode = 1; });
}
