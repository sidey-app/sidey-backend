import { liveFirebaseRequest, UUID } from "./realtime-live.mjs";

// Fenced lease arming: delayed requests cannot overwrite renewal or revocation.
export async function armLiveLease(config, accessToken, userId, lease, rooms, fetcher = fetch, now = Date.now) {
  if (!UUID.test(userId) || !UUID.test(lease.sessionId)) throw new Error("invalid_lease_identity");
  if (!/^[1-9][0-9]{0,18}$/.test(lease.leaseRevision)) throw new Error("invalid_lease_revision");
  let armed = false;
  const leasePath = `v2/leases/${userId}/${lease.sessionId}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const snapshot = await liveFirebaseRequest(config, accessToken, leasePath, { headers: { "X-Firebase-ETag": "true" } }, fetcher);
    if (!snapshot.ok) throw new Error("live_lease_read_failed");
    const current = await snapshot.json();
    if (current !== null) {
      if (typeof current.revision !== "string" || !/^[1-9][0-9]{0,18}$/.test(current.revision)) throw new Error("invalid_current_lease");
      if (BigInt(current.revision) >= BigInt(lease.leaseRevision)) throw new Error("live_lease_superseded");
    }
    const etag = snapshot.headers.get("etag");
    if (!etag) throw new Error("live_lease_etag_missing");
    if (lease.leaseExpiresAt < now() + 15000) throw new Error("live_lease_expired");
    const response = await liveFirebaseRequest(config, accessToken, leasePath, {
      method: "PUT", headers: { "if-match": etag },
      body: JSON.stringify({ expiresAt: lease.leaseExpiresAt, rooms, revision: lease.leaseRevision }),
    }, fetcher);
    if (response.status === 412) continue;
    if (!response.ok) throw new Error("live_lease_not_armed");
    armed = true; break;
  }
  if (!armed || lease.leaseExpiresAt < now() + 15000) throw new Error("live_lease_not_armed");
}
