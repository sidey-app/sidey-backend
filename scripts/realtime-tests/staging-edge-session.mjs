// SQL only, through the caller's staging-bound Management API connection.
// No I/O on import; never handles or prints scheduler credentials.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JOB = 'sidey-firebase-live-staging';
const counterNames = ['claimed', 'completed', 'published', 'expired', 'suppressed', 'retries',
  'cleanupSelected', 'cleanupCompleted', 'cleanupRetries', 'httpRequests', 'responseBodyBytes',
  'rtdbResponseBodyBytes', 'supabaseResponseBodyBytes', 'googleAuthResponseBodyBytes',
  'supabaseRequests', 'rtdbRequests', 'googleAuthRequests',
  'supabaseRequestMs', 'rtdbRequestMs', 'googleAuthRequestMs'];
// RequestMaxMs values are lifetime high-water marks, not subtractable counters.

export function edgeCounters(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_edge_metrics');
  const result = {};
  for (const name of counterNames) {
    const count = value?.[name] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid_edge_metrics');
    result[name] = count;
  }
  return result;
}

export class StagingEdgeSession {
  constructor({ runId, query, sleep, now = Date.now, directEvents = false, edgeRegion = null }) {
    if (!UUID.test(runId)) throw new Error('invalid_edge_run');
    if (typeof directEvents !== 'boolean') throw new Error('invalid_direct_events');
    if (edgeRegion !== null && !['ap-northeast-2', 'ap-southeast-1'].includes(edgeRegion)) throw new Error('invalid_edge_region');
    Object.assign(this, { runId, query, sleep, now, directEvents, edgeRegion });
    this.mayBeRunning = false;
  }
  async preflight() {
    const [row] = await this.query(`select
      to_regprocedure('public.begin_claim_firebase_live_dispatch(uuid,integer)') is not null as pipeline_ready,
      not exists(select 1 from private.firebase_live_dispatch_config where edge_region is not null) as region_off,
      not exists(select 1 from private.firebase_live_config where direct_events_enabled) as direct_off,
      not exists(select 1 from private.firebase_live_cleanup_state where running or owner_run_id is not null) as cleanup_idle,
      to_regclass('private.firebase_live_access_snapshots') is not null as fast_dispatch_ready,
      exists(select 1 from private.firebase_live_dispatch_config where not enabled and owner_run_id is null) as config_off,
      not exists(select 1 from private.firebase_live_dispatch_state where phase is not null) as dispatch_idle,
      not exists(select 1 from cron.job where jobname='${JOB}') as cron_absent,
      (select count(*)=1 and bool_and(length(decrypted_secret)>=32) from vault.decrypted_secrets
        where name='sidey_firebase_live_publish_secret_staging') as secret_ready`);
    if (!row || ['pipeline_ready', 'region_off', 'direct_off', 'cleanup_idle', 'fast_dispatch_ready', 'config_off', 'dispatch_idle', 'cron_absent', 'secret_ready']
      .some(name => row[name] !== true)) throw new Error('edge_baseline_not_ready');
    return this.sample();
  }
  async start() {
    // A lost Management API response may still have committed. Stop must inspect
    // ownership even when start throws, before synthetic records can be deleted.
    this.mayBeRunning = true;
    await this.query(`begin;
      select id from private.firebase_live_dispatch_config where id=true for update;
      do $sidey_load$ begin
        if not exists(select 1 from private.firebase_live_dispatch_config where id=true and not enabled and owner_run_id is null and edge_region is null)
          or exists(select 1 from private.firebase_live_dispatch_state where phase is not null)
          or exists(select 1 from private.firebase_live_cleanup_state where running or owner_run_id is not null)
          or exists(select 1 from private.firebase_live_config where direct_events_enabled)
          or exists(select 1 from cron.job where jobname='${JOB}') then
          raise exception 'edge_start_conflict';
        end if;
      end $sidey_load$;
      update private.firebase_live_dispatch_config set owner_run_id='${this.runId}',enabled=true,
        edge_region=${this.edgeRegion === null ? 'null' : `'${this.edgeRegion}'`},
        run_deadline_at=clock_timestamp()+interval '60 minutes' where id=true;
      update private.firebase_live_config set direct_events_enabled=${this.directEvents};
      select cron.schedule('${JOB}','1 second','select private.dispatch_firebase_live();');
      commit;`);
  }
  async sample() {
    const [row] = await this.query(`select phase, clock_timestamp() as sampled_at, expires_at<=clock_timestamp() as lease_expired,
      enqueue_count::text, started_count::text, finished_count::text,
      case when last_started_at >= last_enqueued_at then
        extract(epoch from last_started_at-last_enqueued_at)*1000 end as enqueue_to_admission_ms,
      cumulative_totals,
      exists(select 1 from private.firebase_direct_events where expires_at>=clock_timestamp()-interval '30 seconds') as direct_inflight,
      (select running from private.firebase_live_cleanup_state where id=true) as cleanup_running,
      (select cumulative_totals from private.firebase_live_cleanup_state where id=true) as cleanup_totals
      from private.firebase_live_dispatch_state where id=true`);
    if (!row || ![null, 'queued', 'running'].includes(row.phase)) throw new Error('invalid_edge_state');
    if (!Number.isFinite(Date.parse(row.sampled_at))) throw new Error('invalid_edge_sample_time');
    if (typeof row.lease_expired !== 'boolean' || typeof row.cleanup_running !== 'boolean' || typeof row.direct_inflight !== 'boolean') throw new Error('invalid_edge_state');
    const publicationTotals = edgeCounters(row.cumulative_totals), cleanupTotals = edgeCounters(row.cleanup_totals);
    const totals = edgeCounters(Object.fromEntries(counterNames.map(name => [name, publicationTotals[name] + cleanupTotals[name]])));
    const enqueueToAdmissionMs = row.enqueue_to_admission_ms == null ? null : Number(row.enqueue_to_admission_ms);
    if (enqueueToAdmissionMs !== null && (!Number.isFinite(enqueueToAdmissionMs) || enqueueToAdmissionMs < 0)) throw new Error("invalid_edge_metrics");
    const result = { phase: row.phase, sampledAt: row.sampled_at, enqueueToAdmissionMs, leaseExpired: row.lease_expired,
      cleanupRunning: row.cleanup_running, directInflight: row.direct_inflight, publicationTotals, cleanupTotals, totals };
    for (const name of ['enqueue_count', 'started_count', 'finished_count']) {
      if (!/^\d+$/.test(row[name] || '') || !Number.isSafeInteger(Number(row[name]))) throw new Error('invalid_edge_metrics');
      result[name] = Number(row[name]);
    }
    return result;
  }
  async stop() {
    if (!this.mayBeRunning) return;
    await this.query(`begin;
      select id from private.firebase_live_dispatch_config where id=true for update;
      do $sidey_load$ begin
        if exists(select 1 from private.firebase_live_dispatch_config where owner_run_id='${this.runId}') then
          update private.firebase_live_dispatch_config set enabled=false where owner_run_id='${this.runId}';
          update private.firebase_live_config set direct_events_enabled=false;
          perform cron.unschedule(jobid) from cron.job where jobname='${JOB}';
        elsif exists(select 1 from private.firebase_live_dispatch_config where enabled or owner_run_id is not null) then
          raise exception 'edge_stop_owner_mismatch';
        end if;
      end $sidey_load$;
      commit;`);
    const deadline = this.now() + 60000;
    for (;;) {
      const state = await this.sample();
      // An expired running lease is NOT proof that its HTTP writes have stopped.
      // A queued request cannot acquire a disabled owner's dispatch lease.
      if (state.phase !== 'running' && !state.cleanupRunning && !state.directInflight) break;
      if (this.now() >= deadline) throw new Error('edge_stop_unconfirmed');
      await this.sleep(1000);
    }
    await this.query(`begin;
      select id from private.firebase_live_dispatch_config where id=true for update;
      do $sidey_load$ begin
        if exists(select 1 from private.firebase_live_cleanup_state where running) then raise exception 'edge_cleanup_still_running'; end if;
      end $sidey_load$;
      update private.firebase_live_cleanup_state set dispatch_id=null,owner_run_id=null
        where owner_run_id='${this.runId}' and not running;
      update private.firebase_live_dispatch_state set phase=null,dispatch_id=null,expires_at='-infinity',owner_run_id=null
        where owner_run_id='${this.runId}' and phase is distinct from 'running';
      update private.firebase_live_dispatch_config set owner_run_id=null,run_deadline_at=null,edge_region=null
        where owner_run_id='${this.runId}' and not enabled;
      commit;`);
    this.mayBeRunning = false;
  }
}
