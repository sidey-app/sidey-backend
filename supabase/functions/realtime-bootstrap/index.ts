import { bootstrapLive } from "./live.ts";
import { authenticatedUser, userRPC } from "../_shared/realtime-supabase.ts";
import { customToken, disabledBootstrap, firebaseConfig, firebaseRequest, googleAccessToken,
  json, streamPath } from "../_shared/realtime.mjs";

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const authorization = request.headers.get("authorization");
    const user = await authenticatedUser(authorization);
    const body = await request.json().catch(() => ({}));
    if (body?.protocolVersion === 2) return await bootstrapLive(authorization!, user.id);
    const config = firebaseConfig((name: string) => Deno.env.get(name));
    if (!config) return json(disabledBootstrap);
    const lease = await userRPC<{
      enabled: boolean; userId: string; sessionId: string; leaseExpiresAt: number;
      streams: { roomId: string; epoch: number; path: string }[];
    }>("prepare_firebase_shadow_lease", {}, authorization!);
    if (!lease.enabled) return json(disabledBootstrap);
    if (lease.userId !== user.id || !Number.isSafeInteger(lease.leaseExpiresAt)
        || lease.leaseExpiresAt < Date.now() + 15000 || lease.leaseExpiresAt > Date.now() + 61000
        || lease.streams.length > 5) throw new Error("invalid_firebase_lease");
    const rooms: Record<string, number> = {};
    for (const stream of lease.streams) {
      if (stream.path !== streamPath(stream.roomId, stream.epoch)) throw new Error("invalid_firebase_stream");
      rooms[stream.roomId] = stream.epoch;
    }
    const token = await customToken(config.account, user.id, lease.sessionId);
    const accessToken = await googleAccessToken(config.account);
    // No token is returned before its immutable, short-lived server lease exists.
    const armed = await firebaseRequest(config, accessToken, `v1/leases/${user.id}/${lease.sessionId}`, {
      method: "PUT", body: JSON.stringify({ expiresAt: lease.leaseExpiresAt, rooms }),
    });
    if (!armed.ok || lease.leaseExpiresAt < Date.now() + 15000) throw new Error("firebase_lease_not_armed");
    return json({ protocolVersion: 1, enabled: true, mode: "shadow", transport: "firebase-hints",
      databaseURL: config.databaseURL, firebaseApiKey: config.apiKey, customToken: token,
      sessionId: lease.sessionId, leaseExpiresAt: lease.leaseExpiresAt, streams: lease.streams });
  } catch {
    // Never expose tokens, SQL internals, credentials or provider response bodies.
    // A live caller reconnects the server-selected transport; failure is NOT permission to downgrade.
    return json({ error: "realtime_bootstrap_unavailable" }, 503);
  }
});
