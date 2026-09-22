export const MIN_LIVE_LEASE_AHEAD_MS = 15_000;
export const MAX_LIVE_LEASE_AHEAD_MS = 60 * 60 * 1_000;
export const MAX_LIVE_LEASE_CLOCK_SKEW_MS = 30_000;

export function validLiveLeaseWindow(leaseExpiresAt, serverTime, edgeTime) {
  if (!Number.isSafeInteger(leaseExpiresAt) || !Number.isSafeInteger(serverTime)
      || !Number.isSafeInteger(edgeTime)) return false;
  if (Math.abs(serverTime - edgeTime) > MAX_LIVE_LEASE_CLOCK_SKEW_MS) return false;
  const ahead = leaseExpiresAt - serverTime;
  return ahead >= MIN_LIVE_LEASE_AHEAD_MS && ahead <= MAX_LIVE_LEASE_AHEAD_MS;
}
