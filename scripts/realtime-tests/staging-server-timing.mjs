// No import I/O. The caller supplies a query function pinned to staging and
// awaits restore() in finally around apply() AND the diagnostic workload.
const SETTING = 'pgrst.server_timing_enabled';
const READ = `SELECT
  (SELECT substr(v, strpos(v, '=') + 1)
   FROM pg_catalog.pg_db_role_setting s, unnest(s.setconfig) v
   WHERE s.setrole = r.oid AND s.setdatabase = 0
     AND split_part(v, '=', 1) = '${SETTING}') AS value,
  EXISTS (SELECT 1
   FROM pg_catalog.pg_db_role_setting s, unnest(s.setconfig) v
   WHERE s.setrole = r.oid
     AND s.setdatabase = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
     AND split_part(v, '=', 1) = '${SETTING}') AS database_override
FROM pg_catalog.pg_roles r WHERE r.rolname = 'authenticator';`;
const fail = code => { throw new Error(code); };
const literal = value => value === null ? 'NULL' : `'${value}'`;

function mutation(expected, desired) {
  // Recheck inside the mutation transaction as well as before issuing it. Only
  // this one allowlisted GUC is inspected; raw role configuration never leaves DB.
  return `BEGIN;
DO $server_timing$
DECLARE current_value text; has_database_override boolean;
BEGIN
  SELECT observed.value, observed.database_override INTO current_value, has_database_override
  FROM (${READ.replace(/;$/, '')}) AS observed;
  IF has_database_override OR current_value IS DISTINCT FROM ${literal(expected)} THEN
    RAISE EXCEPTION 'server_timing_setting_conflict';
  END IF;
  ALTER ROLE authenticator ${desired === null ? `RESET ${SETTING}` : `SET ${SETTING} = ${literal(desired)}`};
  PERFORM pg_notify('pgrst', 'reload config');
END;
$server_timing$;
COMMIT;`;
}

export class StagingServerTiming {
  #query; #checkpoint; #before = null; #pending = false; #applied = false;
  #restored = false; #unchanged = false; #started = false; #busy = false;
  constructor({ query, checkpoint = async () => {} } = {}) {
    if (typeof query !== 'function' || typeof checkpoint !== 'function') fail('server_timing_dependencies_invalid');
    this.#query = query; this.#checkpoint = checkpoint;
  }
  snapshot() {
    return { setting: SETTING, before: this.#before, desired: 'true', pending: this.#pending,
      applied: this.#applied, restored: this.#restored, unchanged: this.#unchanged };
  }
  async #save() {
    try { await this.#checkpoint(this.snapshot()); }
    catch { fail('server_timing_checkpoint_failed'); }
  }
  async #run(sql, error) {
    try { return await this.#query(sql); }
    catch { fail(error); } // Never expose query errors containing credentials or SQL.
  }
  async read() {
    const rows = await this.#run(READ, 'server_timing_read_failed');
    if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]
        || typeof rows[0].database_override !== 'boolean') fail('server_timing_read_invalid');
    const { value, database_override: databaseOverride } = rows[0];
    // PostgREST v14.5 does not interpret the custom GUC strings "on"/"off"
    // like PostgreSQL boolean GUCs. Reject all unsupported forms before writes.
    if (value !== null && value !== 'true' && value !== 'false') fail('server_timing_value_unsupported');
    return { value, databaseOverride };
  }
  async apply() {
    if (this.#busy) fail('server_timing_operation_in_progress');
    if (this.#started) fail('server_timing_already_started');
    this.#busy = true; this.#started = true;
    try {
      const before = await this.read();
      if (before.databaseOverride) fail('server_timing_database_override');
      this.#before = before.value;
      if (before.value === 'true') {
        this.#unchanged = true; this.#applied = true;
        await this.#save();
        return this.snapshot();
      }
      this.#pending = true;
      try { await this.#save(); }
      catch (error) { this.#pending = false; throw error; } // No mutation was attempted.
      await this.#run(mutation(this.#before, 'true'), 'server_timing_apply_failed');
      const current = await this.read();
      if (current.databaseOverride || current.value !== 'true') fail('server_timing_apply_unverified');
      this.#applied = true;
      await this.#save();
      return this.snapshot();
    } finally { this.#busy = false; }
  }
  async restore() {
    if (this.#busy) fail('server_timing_operation_in_progress');
    if (!this.#pending) return this.snapshot();
    this.#busy = true;
    try {
      const current = await this.read();
      if (current.databaseOverride) fail('server_timing_restore_conflict');
      if (current.value === 'true') {
        await this.#run(mutation('true', this.#before), 'server_timing_restore_failed');
        const restored = await this.read();
        if (restored.databaseOverride || restored.value !== this.#before) fail('server_timing_restore_unverified');
      } else if (current.value !== this.#before) fail('server_timing_restore_conflict');
      this.#pending = false; this.#restored = true;
      try { await this.#save(); }
      catch (error) {
        this.#pending = true; this.#restored = false;
        throw error;
      }
      return this.snapshot();
    } finally { this.#busy = false; }
  }
}
