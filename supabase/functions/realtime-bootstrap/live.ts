import { regionalLiveCapability } from "../_shared/realtime-region.mjs";
import { sharedPublisherWakeCapability } from "../_shared/realtime-publish-wake.mjs";
import { directEventConfig, DIRECT_EVENTS } from "../_shared/realtime-direct-event.mjs";
import { armLiveLease } from "../_shared/realtime-lease.mjs";
import { validLiveLeaseWindow } from "../_shared/realtime-lease-window.mjs";
import { userRPC } from "../_shared/realtime-supabase.ts";
import { googleAccessToken, json } from "../_shared/realtime.mjs";
import { liveFirebaseConfig, liveCustomToken, liveFirebaseRequest, liveRoomPath, validateAccess } from "../_shared/realtime-live.mjs";

type Stream = { roomId: string; epoch: number; path: string; members: Record<string, boolean> };
type Lease = { enabled: boolean; userId: string; sessionId: string; leaseExpiresAt: number; serverTime: number; leaseRevision: string; streams: Stream[]; directEvents?: { endpoint: string; protocolVersion: number; region?: string }; publisherWake?: { endpoint: string; protocolVersion: number; region?: string } };
const disabled = { protocolVersion: 2, enabled: false, transport: "supabase" };
export async function bootstrapLive(authorization: string, userId: string) {
  const config = liveFirebaseConfig((name: string) => Deno.env.get(name));
  if (!config) return json(disabled);
  const lease = await userRPC<Lease>("prepare_firebase_live_lease", {}, authorization);
  if (!lease.enabled) return json(disabled);
  if (lease.userId !== userId
      || !validLiveLeaseWindow(lease.leaseExpiresAt, lease.serverTime, Date.now())
      || !Array.isArray(lease.streams)
      || lease.streams.length < 1 || lease.streams.length > 5) throw new Error("invalid_live_lease");
  const accessToken = await googleAccessToken(config.account);
  const rooms: Record<string, number> = {};
  // Only the publisher owns room access. A slow bootstrap must never restore an
  // obsolete member set; wait for authoritative control publication instead.
  await Promise.all(lease.streams.map(async stream => {
    if (stream.path !== liveRoomPath(stream.roomId, stream.epoch)) throw new Error("invalid_live_stream");
    const response = await liveFirebaseRequest(config, accessToken, `v2/access/${stream.roomId}`);
    if (!response.ok) throw new Error("live_access_unavailable");
    const access = validateAccess(await response.json());
    if (!access.enabled || access.epoch !== stream.epoch || access.members[userId] !== true
        || Object.keys(access.members).sort().join() !== Object.keys(stream.members).sort().join()) {
      throw new Error("live_access_pending");
    }
    rooms[stream.roomId] = stream.epoch;
  }));
  const customToken = await liveCustomToken(config.account, userId, lease.sessionId);
  await armLiveLease(config, accessToken, userId, lease, rooms);
  const directApproved = directEventConfig((name: string) => Deno.env.get(name));
  const directEvents = directApproved ? regionalLiveCapability(lease.directEvents, DIRECT_EVENTS) : undefined;
  const publisherWake = directApproved ? sharedPublisherWakeCapability(lease.publisherWake) : undefined;
  return json({ protocolVersion: 2, enabled: true, mode: "live", transport: "firebase-rtdb",
    databaseURL: config.databaseURL, firebaseApiKey: config.apiKey, customToken,
    sessionId: lease.sessionId, leaseExpiresAt: lease.leaseExpiresAt, serverTime: Date.now(),
    presenceTTL: 90000, presenceHeartbeat: 45000,
    ...(directEvents ? { directEvents } : {}),
    ...(publisherWake ? { publisherWake } : {}),
    streams: lease.streams.map(({roomId, epoch, path}) => ({roomId, epoch, path})) });
}
