// Bounded, work-conserving admission for already-authenticated synthetic actors.
// The runner calls tick every second; completions also admit newly due actors.
import { loadAuthorizationDeadline } from './staging-load-session.mjs';

export function createLoadRenewalScheduler({ users, renew, onFailure, concurrency,
  now = Date.now, stopping = () => false }) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64
      || typeof users !== 'function' || typeof renew !== 'function' || typeof onFailure !== 'function') {
    throw new Error('invalid_renewal_scheduler');
  }
  const active = new Map();
  let stopped = false, failed = false, stopWork;
  function tick() {
    if (stopped || failed || stopping()) return;
    while (active.size < concurrency) {
      const at = now();
      const user = users().filter(value => value.ready && !value.reconnecting && !value.renewing
        && !active.has(value) && at >= value.renewAt)
        .sort((a, b) => loadAuthorizationDeadline(a) - loadAuthorizationDeadline(b))[0];
      if (!user) return;
      const work = Promise.resolve().then(() => {
        if (!stopped && !failed && !stopping()) return renew(user);
      }).catch(error => {
        failed = true;
        // Preserve the original failure in the runner; reporting must never
        // produce an unhandled rejection or restart admission after failure.
        try { Promise.resolve(onFailure(error)).catch(() => {}); } catch { /* reporting only */ }
      }).finally(() => { active.delete(user); tick(); });
      active.set(user, work);
    }
  }
  function stop() {
    stopped = true;
    return stopWork ||= Promise.allSettled([...active.values()]);
  }
  return Object.freeze({ tick, stop, snapshot: () => ({ active: active.size, stopped, failed, concurrency }) });
}
