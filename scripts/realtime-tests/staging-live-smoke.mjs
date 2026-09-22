// One explicitly authorized staging-only LIVE v2 smoke. Never run against another project.
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { googleAccessToken, customToken } from "../../supabase/functions/_shared/realtime.mjs";

import { LiveWorker } from "./live-worker.mjs";
import { liveCustomToken } from "../../supabase/functions/_shared/realtime-live.mjs";

const ref = "fjglrvhvdthntkvrduyi", project = "sidey-realtime-staging";
const base = `https://${ref}.supabase.co`;
const database = `https://${project}-default-rtdb.asia-southeast1.firebasedatabase.app`;
const root = fileURLToPath(new URL("../../", import.meta.url));
const execute = promisify(execFile);
const digest = value => createHash("sha256").update(value).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const requireValue = condition => { if (!condition) throw new Error("validation_failed"); };
let stage = "explicit_staging_guard", cleanupAllowed = false, stream;
let adminKey, anonKey, googleToken, firebaseAPIKey, account;
const users = [], rooms = new Set(), firebaseUsers = [], cleanupFailures = [];
let originalSecrets, recoveryDirectory;
const startedAt = Date.now();
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop.abort());

function mark(name) { stage = name; console.log(`STEP ${name} elapsed_ms=${Date.now() - startedAt}`); }
async function cli(args) {
  const result = await execute("supabase", args, { cwd: root, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout;
}
async function query(sql) {
  const value = JSON.parse(await cli(["db", "query", "--project-ref", ref, "--linked", sql, "--output", "json"]));
  requireValue(Array.isArray(value.rows));
  return value.rows;
}
async function secrets() {
  const rows = JSON.parse(await cli(["secrets", "list", "--project-ref", ref, "--output", "json"]));
  requireValue(Array.isArray(rows));
  return new Map(rows.map(row => [row.name, row.value]));
}
async function setSecrets(values) {
  const directory = await mkdtemp(join(tmpdir(), "sidey-staging-smoke-"));
  try {
    const file = join(directory, "secrets.env");
    await writeFile(file, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { mode: 0o600 });
    await cli(["secrets", "set", "--project-ref", ref, "--env-file", file]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function request(url, init = {}, expected = [200], cleanup = false) {
  const response = await fetch(url, { ...init, redirect: "error",
    signal: cleanup ? AbortSignal.timeout(15000) : AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]) });
  console.log(`HTTP ${stage} ${response.status}`);
  requireValue(expected.includes(response.status));
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
function sb(path, token = adminKey, options = {}) {
  return request(`${base}${path}`, { ...options, headers: { apikey: anonKey,
    authorization: `Bearer ${token}`, "content-type": "application/json", ...options.headers } }, options.expected || [200], options.cleanup);
}
const rpc = (name, token, body) => sb(`/rest/v1/rpc/${name}`, token, { method: "POST", body: JSON.stringify(body), expected: [200, 204] });
function fb(path, { token, method = "GET", body, expected = [200], cleanup = false } = {}) {
  const url = new URL(`${database}/${path}.json`);
  if (token) url.searchParams.set("auth", token);
  return request(url, { method, headers: { "content-type": "application/json", ...(token ? {} : { authorization: `Bearer ${googleToken}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, expected, cleanup);
}
async function firebaseLogin(user, token, cleanup = false) {
  user.attempted = true;
  const value = await request(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(firebaseAPIKey)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, returnSecureToken: true }) }, [200], cleanup);
  requireValue(typeof value.idToken === "string" && value.idToken.length > 0);
  const identity = await request(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseAPIKey)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: value.idToken }) }, [200], cleanup);
  requireValue(Array.isArray(identity.users) && identity.users.length === 1
    && identity.users[0].localId === user.id && identity.users[0].disabled !== true);
  user.token = value.idToken;
}
async function openStream(path, token) {
  const abort = new AbortController();
  const url = new URL(`${database}/${path}.json`); url.searchParams.set("auth", token);
  const signal = AbortSignal.any([abort.signal, stop.signal, AbortSignal.timeout(55000)]);
  // Firebase may redirect to its own regional hosts. Validate every destination before
  // resending the authenticated URL; no automatic arbitrary redirect following.
  let target = url, response;
  for (let attempt = 0; attempt < 4; attempt++) {
    response = await fetch(target, { headers: { accept: "text/event-stream" }, redirect: "manual", signal });
    console.log(`HTTP ${stage} ${response.status}`);
    if (response.status !== 307) break;
    const next = new URL(response.headers.get("location"), target);
    requireValue(next.protocol === "https:" && !next.username && !next.password && !next.port
      && (next.hostname.endsWith(".firebaseio.com") || next.hostname.endsWith(".firebasedatabase.app")));
    await response.body?.cancel(); target = next;
  }
  requireValue(response.status === 200 && response.headers.get("content-type")?.includes("text/event-stream"));
  const reader = response.body.getReader(), decoder = new TextDecoder(), events = [], waiters = [];
  let terminal = false;
  function dispatch(event) {
    if (["put", "patch", "cancel", "auth_revoked", "keep-alive"].includes(event.name)) console.log(`SSE ${event.name} elapsed_ms=${Date.now() - startedAt}`);
    events.push(event); if (events.length > 64) events.shift();
    for (const waiter of [...waiters]) if (waiter.matches(event)) waiter.finish(event);
  }
  const pump = (async () => {
    let pending = "";
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        requireValue(pending.length <= 65536);
        pending = pending.replaceAll("\r\n", "\n");
        let boundary;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          let name = "message"; const data = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) name = line.slice(6).trim();
            if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
          }
          if (data.length) {
            console.log(`SSE frame_terminal=${name === "cancel" || name === "auth_revoked"} elapsed_ms=${Date.now() - startedAt}`);
            dispatch({ name, data: name === "cancel" || name === "auth_revoked" ? null : JSON.parse(data.join("\n")) });
          }
        }
      }
    } catch { console.log(`SSE read_failed elapsed_ms=${Date.now() - startedAt} aborted=${signal.aborted}`); }
    finally { terminal = true; for (const waiter of [...waiters]) waiter.fail(); }
  })();
  return {
    wait(matches) {
      const existing = events.find(matches); if (existing) return Promise.resolve(existing);
      if (terminal) return Promise.reject(new Error("stream_closed"));
      return new Promise((resolve, reject) => {
        const remove = () => { clearTimeout(timer); const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); };
        const waiter = { matches, finish: value => { remove(); resolve(value); }, fail: () => { remove(); reject(new Error("stream_failed")); } };
        const timer = setTimeout(waiter.fail, 12000); waiters.push(waiter);
      });
    },
    async close() { abort.abort(); await reader.cancel().catch(() => {}); await pump; },
  };
}
async function clean(name, operation) {
  mark(`cleanup_${name}`);
  try { await operation(); console.log(`PASS cleanup_${name}`); }
  catch { cleanupFailures.push(name); console.log(`FAIL cleanup_${name}`); }
}

try {
  requireValue(process.argv.length === 3 && process.argv[2] === "--run-explicit-staging");
  requireValue(typeof process.env.SIDEY_STAGING_SERVICE_ACCOUNT_FILE === "string");
  account = JSON.parse(await readFile(process.env.SIDEY_STAGING_SERVICE_ACCOUNT_FILE, "utf8"));
  requireValue(account.project_id === project && typeof account.client_email === "string"
    && account.client_email.endsWith(`@${project}.iam.gserviceaccount.com`) && typeof account.private_key === "string");
  // An existing link may not silently redirect the --linked SQL boundary.
  try { requireValue((await readFile(join(root, "supabase/.temp/project-ref"), "utf8")).trim() === ref); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const keys = JSON.parse(await cli(["projects", "api-keys", "--project-ref", ref, "--output", "json"]));
  adminKey = keys.find(key => key.name === "service_role")?.api_key;
  anonKey = keys.find(key => key.name === "anon")?.api_key;
  requireValue(adminKey && anonKey);
  mark("baseline_flags"); originalSecrets = await secrets();
  requireValue(originalSecrets.get("SIDEY_FIREBASE_MODE") === digest("off")
    && originalSecrets.get("SIDEY_FIREBASE_SHADOW_APPROVED") === digest("false")
    && originalSecrets.get("SIDEY_FIREBASE_PROJECT_ID") === digest(project)
    && originalSecrets.get("SIDEY_FIREBASE_SUPABASE_PROJECT_REF") === digest(ref)
    && [digest(database), digest(database + "/")].includes(originalSecrets.get("SIDEY_FIREBASE_DATABASE_URL")));
  mark("baseline_rules"); googleToken = await googleAccessToken(account);
  const lockedRules = JSON.parse(await readFile(new URL("../../supabase/firebase/database.rules.json", import.meta.url), "utf8"));
  requireValue(JSON.stringify(await fb(".settings/rules")) === JSON.stringify(lockedRules));
  mark("baseline_empty");
  requireValue((await sb("/auth/v1/admin/users?page=1&per_page=1")).users.length === 0);
  const baseline = (await query("select (select count(*) from auth.users)=0 as users_empty, (select count(*) from public.rooms)=0 as rooms_empty, (select count(*) from private.firebase_live_outbox)=0 as outbox_empty, (select count(*) from private.firebase_live_leases)=0 as leases_empty, (select count(*) from pg_trigger where tgname in ('zz_firebase_messages_shadow','zz_firebase_rooms_shadow','zz_firebase_profiles_shadow') and tgenabled='D')=3 as triggers_disabled"))[0];
  requireValue(Object.values(baseline).every(value => value === true));
  cleanupAllowed = true;
  for (let index = 0; index < 2; index++) {
    mark("create_synthetic_user");
    const user = { email: `sidey-smoke-${randomUUID()}@example.invalid`, password: randomBytes(32).toString("base64url") };
    users.push(user); // Record the generated email before the request for uncertain-response cleanup.
    const created = await sb("/auth/v1/admin/users", adminKey, { method: "POST", body: JSON.stringify({ email: user.email, password: user.password, email_confirm: true }) });
    user.id = created.id; requireValue(uuid.test(user.id));
    mark("password_session");
    const session = await sb("/auth/v1/token?grant_type=password", anonKey,
      { method: "POST", body: JSON.stringify({ email: user.email, password: user.password }) });
    requireValue(session.user.id === user.id && session.access_token); user.token = session.access_token;
    await rpc("upsert_profile", user.token, { p_nickname: index ? "관찰밖" : "관찰안", p_character_id: "minty_pup" });
  }
  const owner = users[0], outsider = users[1];
  mark("create_synthetic_room");
  const createdRoom = (await rpc("create_room", owner.token, { p_name: "staging live smoke" }))[0];
  const room = createdRoom.room_id;
  requireValue(uuid.test(room)); rooms.add(room);
  mark("enable_live_cohort");
  await query(`begin; insert into private.firebase_live_users(user_id,enabled) values ('${owner.id}',true); insert into private.firebase_live_rooms(room_id,enabled) values('${room}',true);update private.firebase_live_config set enabled=true; commit;`);
  mark("enable_live_rules");
  await fb(".settings/rules", { method:"PUT",body:JSON.parse(await readFile(new URL("../../supabase/firebase/database.live.rules.json",import.meta.url),"utf8")) });
  mark("enable_live_flags");
  await setSecrets({ SIDEY_FIREBASE_MODE:"live",SIDEY_FIREBASE_LIVE_APPROVED:"true" });
  const worker=new LiveWorker({config:{databaseURL:database,account},rpc:(name,body)=>rpc(name,adminKey,body),accessToken:async()=>googleToken});
  mark("publish_control");await worker.batch();
  mark("bootstrap");
  const bootstrap=await sb("/functions/v1/realtime-bootstrap",owner.token,{method:"POST",body:'{"protocolVersion":2}'});
  requireValue(bootstrap.enabled===true&&bootstrap.protocolVersion===2&&bootstrap.mode==="live"&&bootstrap.databaseURL===database);
  firebaseAPIKey=bootstrap.firebaseApiKey;
  const descriptor=bootstrap.streams.find(item=>item.roomId===room);
  requireValue(descriptor&&descriptor.path===`v2/rooms/${room}/epochs/${descriptor.epoch}`);
  const memberFirebase = { id: owner.id }, outsiderFirebase = { id: outsider.id };
  firebaseUsers.push(memberFirebase, outsiderFirebase);
  // Preserve only this run's synthetic identifiers for recovery if cleanup cannot finish.
  // Never persist credentials, tokens, passwords, or real customer records.
  recoveryDirectory = await mkdtemp(join(tmpdir(), "sidey-staging-recovery-"));
  await writeFile(join(recoveryDirectory, "synthetic-identifiers.json"), JSON.stringify({
    project, supabaseRef: ref, createdAt: new Date().toISOString(),
    userIds: firebaseUsers.map(user => user.id), roomIds: [...rooms],
  }), { mode: 0o600 });
  mark("firebase_member_identity"); await firebaseLogin(memberFirebase, bootstrap.customToken);
  mark("sse_open"); stream = await openStream(descriptor.path, memberFirebase.token);
  await stream.wait(event => event.name === "put");
  mark("baseline_cursor");const baselineCursor=await rpc("firebase_realtime_changes",owner.token,{p_room_id:room});
  mark("send_message");const message=randomUUID(),body="synthetic staging live smoke";
  await rpc("send_message",owner.token,{p_id:message,p_room_id:room,p_body:body});
  mark("publish_message");await worker.batch();
  mark("sse_message");
  await stream.wait(event=>["put","patch"].includes(event.name)&&JSON.stringify(event.data).includes('"message_changed"'));
  mark("durable_source");
  const delta=await rpc("firebase_realtime_changes",owner.token,{p_room_id:room,p_after_revision:baselineCursor.cursor});
  requireValue(delta.resetRequired===false&&delta.changes.some(change=>change.messageId===message&&change.operation==="INSERT"&&change.message?.body===body));
  const snapshot=await fb(descriptor.path,{token:memberFirebase.token});
  requireValue(!JSON.stringify(snapshot).includes(body));
  mark("presence_owner_write");
  const presencePath=`${descriptor.path}/presence/${owner.id}/${bootstrap.sessionId}`;
  await fb(presencePath,{token:memberFirebase.token,method:"PUT",body:{state:"online",active:true,updatedAt:{".sv":"timestamp"}}});
  requireValue((await fb(presencePath,{token:memberFirebase.token})).state==="online");
  mark("typing_rpc");
  await rpc("broadcast_room_event",owner.token,{p_room_id:room,p_realtime_epoch:descriptor.epoch,p_event:"typing_start",p_event_id:randomUUID()});
  await worker.batch();
  requireValue(Object.values((await fb(`${descriptor.path}/events`,{token:memberFirebase.token}))||{}).some(event=>event.kind==="typing_start"));
  mark("pulse_rpc");
  await rpc("broadcast_room_event",owner.token,{p_room_id:room,p_realtime_epoch:descriptor.epoch,p_event:"character_pulse",p_event_id:randomUUID()});await worker.batch();
  requireValue(Object.values((await fb(`${descriptor.path}/events`,{token:memberFirebase.token}))||{}).some(event=>event.kind==="character_pulse"));
  mark("firebase_outsider_identity");await firebaseLogin(outsiderFirebase,await liveCustomToken(account,outsider.id,randomUUID()));
  mark("outsider_denied");await fb(descriptor.path,{token:outsiderFirebase.token,expected:[401,403]});
  mark("client_hint_write_denied");await fb(`${descriptor.path}/hint`,{token:memberFirebase.token,method:"PUT",body:{revision:"999"},expected:[401,403]});
  mark("client_other_presence_denied");await fb(`${descriptor.path}/presence/${outsider.id}/${bootstrap.sessionId}`,{token:memberFirebase.token,method:"PUT",body:{state:"online",active:true,updatedAt:{".sv":"timestamp"}},expected:[401,403]});
  mark("cohort_rollback");await query(`update private.firebase_live_rooms set enabled=false where room_id='${room}'`);await worker.batch();
  mark("revoked_epoch_denied");await fb(descriptor.path,{token:memberFirebase.token,expected:[401,403]});
  mark("sse_revoked");await stream.wait(event=>event.name==="cancel");
  mark("rollback_bootstrap");const rolled=await sb("/functions/v1/realtime-bootstrap",owner.token,{method:"POST",body:'{"protocolVersion":2}'});requireValue(rolled.enabled===false&&rolled.transport==="supabase");
  mark("source_preserved");const saved=await sb(`/rest/v1/messages?id=eq.${message}&select=id,body`,owner.token);requireValue(saved.length===1&&saved[0].body===body);
  console.log("PASS staging_live_smoke");

} catch {
  console.log(`FAIL ${stage}`); process.exitCode = 1;
} finally {
  if (stream) await clean("stream", () => stream.close());
  if (cleanupAllowed) {
    await clean("locked_rules", async () => {
      const rules = JSON.parse(await readFile(new URL("../../supabase/firebase/database.rules.json", import.meta.url), "utf8"));
      await fb(".settings/rules", { method: "PUT", body: rules, cleanup: true });
      requireValue(JSON.stringify(await fb(".settings/rules", { cleanup: true })) === JSON.stringify(rules));
    });
    await clean("flags_off", () => setSecrets({ SIDEY_FIREBASE_MODE: "off", SIDEY_FIREBASE_SHADOW_APPROVED: "false", SIDEY_FIREBASE_LIVE_APPROVED: "false",
      SIDEY_FIREBASE_PUBLISH_SECRET: randomBytes(48).toString("hex") }));
    await clean("rollout_disabled",()=>query("update private.firebase_live_config set enabled=false"));
    await clean("recover_owned_ids", async () => {
      const registered = (await sb("/auth/v1/admin/users?page=1&per_page=1000", adminKey, { cleanup: true })).users;
      for (const user of users) {
        if (!user.id) user.id = registered.find(row => row.email === user.email)?.id;
        if (!user.id) continue; requireValue(uuid.test(user.id));
        for (const room of await query(`select id from public.rooms where owner_id='${user.id}'::uuid`)) {
          requireValue(uuid.test(room.id)); rooms.add(room.id);
        }
      }
    });
    for (const user of firebaseUsers.filter(user => user.attempted)) {
      await clean("firebase_auth_user", async () => {
        if (!user.token) await firebaseLogin(user, await customToken(account, user.id, randomUUID()), true);
        await request(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${encodeURIComponent(firebaseAPIKey)}`,
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: user.token }) }, [200], true);
      });
    }
    for (const room of rooms) await clean("firebase_room", () => fb(`v2/rooms/${room}`, { method: "DELETE", cleanup: true }));
    for (const room of rooms) await clean("firebase_access",()=>fb(`v2/access/${room}`,{method:"DELETE",cleanup:true}));
    for (const user of users.filter(user => uuid.test(user.id || ""))) {
      await clean("firebase_lease", () => fb(`v2/leases/${user.id}`, { method: "DELETE", cleanup: true }));
      await clean("private_rows", async () => {
        const ownedRooms = [...rooms].map(room => `'${room}'`).join(",");
        await query(`begin;delete from private.firebase_live_users where user_id='${user.id}';delete from private.firebase_live_leases where user_id='${user.id}';${ownedRooms?`delete from public.rooms where id in(${ownedRooms}) and owner_id='${user.id}'; delete from private.firebase_live_rooms where room_id in(${ownedRooms});delete from private.firebase_live_outbox where room_id in(${ownedRooms});delete from private.firebase_live_cursors where room_id in(${ownedRooms});delete from private.firebase_live_epochs where room_id in(${ownedRooms});delete from private.firebase_live_access_snapshots where room_id in(${ownedRooms});`:""}commit;`);

      });
      await clean("supabase_user", () => sb(`/auth/v1/admin/users/${user.id}`, adminKey, { method: "DELETE", cleanup: true }));
    }
    await clean("verify_off_and_empty", async () => {
      const values = await secrets();
      requireValue(values.get("SIDEY_FIREBASE_MODE") === digest("off") && values.get("SIDEY_FIREBASE_SHADOW_APPROVED") === digest("false"));
      for (const [name, value] of originalSecrets) {
        if (name.startsWith("SIDEY_FIREBASE_") && name !== "SIDEY_FIREBASE_PUBLISH_SECRET" && name !== "SIDEY_FIREBASE_LIVE_APPROVED") requireValue(values.get(name) === value);
      }
      const rows = await query("select (select count(*) from auth.users)=0 as users_empty, (select count(*) from public.rooms)=0 as rooms_empty, (select count(*) from private.firebase_live_outbox)=0 as outbox_empty, (select count(*) from private.firebase_live_leases)=0 as leases_empty, (select count(*) from pg_trigger where tgname in ('zz_firebase_messages_shadow','zz_firebase_rooms_shadow','zz_firebase_profiles_shadow') and tgenabled='D')=3 as triggers_disabled");
      requireValue(Object.values(rows[0]).every(value => value === true));
    });
  }
  if (cleanupFailures.length) {
    console.log("FAIL cleanup_incomplete"); process.exitCode = 2;
    if (recoveryDirectory) console.log(`RECOVERY ${recoveryDirectory}`);
  } else {
    if (recoveryDirectory) await rm(recoveryDirectory, { recursive: true, force: true });
    if (cleanupAllowed) console.log("PASS cleanup_complete");
  }
}
