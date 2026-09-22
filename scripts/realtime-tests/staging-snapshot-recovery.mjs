// Receiver-only recovery state. Never publishes, extends TTL or retries a producer.
const fields = ['userId', 'sessionId', 'roomId', 'epoch', 'path'];
const effect = kind => kind === 'character_throw' || kind === 'character_pulse';
const scopeEqual = (left, right) => fields.every(key => left?.[key] === right?.[key]);

export class LoadSnapshotRecovery {
  constructor({ limit = 2048 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2048) throw new Error('invalid_snapshot_recovery_limit');
    this.limit = limit; this.generation = 0; this.suppressed = new Map(); this.initialized = false;
    this.nowHighWater = -Infinity;
  }
  begin(scope) {
    if (!scopeEqual(this.scope, scope)) {
      this.scope = Object.fromEntries(fields.map(key => [key, scope[key]]));
      this.suppressed.clear(); this.initialized = false; this.nowHighWater = -Infinity;
    }
    return { generation: ++this.generation, recovery: this.initialized };
  }
  current(ticket, scope) { return ticket.generation === this.generation && scopeEqual(this.scope, scope); }
  initializedSnapshot(ticket) {
    if (ticket.generation === this.generation) this.initialized = true;
  }
  allow(ticket, value, { initial, now }) {
    if (ticket.generation !== this.generation) return false;
    if (Number.isFinite(now)) this.nowHighWater = Math.max(this.nowHighWater, now);
    if (!effect(value.kind)) return true;
    // Expiration cannot move backwards within this authorization scope, even
    // after a cache entry has been pruned or the receiver clock is corrected.
    for (const [id, expires] of this.suppressed) if (expires <= this.nowHighWater) this.suppressed.delete(id);
    const id = value.payload?.event_id;
    if (this.suppressed.has(id)) return false;
    if (value.expiresAt <= this.nowHighWater) return false;
    if (!initial) return true;
    const validLifetime = Number.isFinite(now) && Number.isFinite(value.occurredAt) && Number.isFinite(value.expiresAt)
      && value.occurredAt <= now + 5000 && value.expiresAt > this.nowHighWater
      && value.expiresAt > value.occurredAt && value.expiresAt - value.occurredAt <= 5000;
    if (!validLifetime || typeof id !== 'string') return false;
    if (ticket.recovery) return true; // Existing expected.received remains the delivery dedup owner.
    if (this.suppressed.size >= this.limit) throw new Error('snapshot_recovery_capacity');
    this.suppressed.set(id, value.expiresAt);
    return false;
  }
}
