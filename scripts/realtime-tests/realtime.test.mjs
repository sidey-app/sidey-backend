import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { disabledBootstrap, firebaseConfig, hintPayload, streamPath, shouldReplaceHint,
  publishHint, customToken } from "../../supabase/functions/_shared/realtime.mjs";

const room = "11111111-1111-4111-8111-111111111111";
const event = "22222222-2222-4222-8222-222222222222";
const row = { revision: "4", publication_revision: "9007199254740993", event_id: event, room_id: room, epoch: 2,
  kind: "message_changed", occurred_at: "2026-09-18T00:00:00.000Z" };
const config = { databaseURL: "https://example.asia-southeast1.firebasedatabase.app" };

test("default, unknown, and unapproved modes never activate Firebase", () => {
  assert.equal(firebaseConfig(() => undefined), null);
  assert.equal(firebaseConfig((key) => key === "SIDEY_FIREBASE_MODE" ? "live" : undefined), null);
  assert.equal(firebaseConfig((key) => key === "SIDEY_FIREBASE_MODE" ? "shadow" : undefined), null);
  assert.deepEqual(disabledBootstrap, { protocolVersion: 1, enabled: false, transport: "supabase" });
});

test("environment binding rejects wrong-project credentials and wrong Supabase staging", () => {
  const vars = {
    SIDEY_FIREBASE_MODE: "shadow", SIDEY_FIREBASE_SHADOW_APPROVED: "true",
    SIDEY_FIREBASE_PROJECT_ID: "example", SIDEY_FIREBASE_SUPABASE_PROJECT_REF: "stagingref",
    SUPABASE_URL: "https://stagingref.supabase.co",
    SIDEY_FIREBASE_DATABASE_URL: "https://example-default-rtdb.asia-southeast1.firebasedatabase.app",
    SIDEY_FIREBASE_API_KEY: "public-key",
    SIDEY_FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: "example", client_email: "bridge@example.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----placeholder" }),
  };
  assert.equal(firebaseConfig((key) => vars[key]).account.project_id, "example");
  assert.throws(() => firebaseConfig((key) => key === "SUPABASE_URL" ? "https://production.supabase.co" : vars[key]), /binding_mismatch/);
  assert.throws(() => firebaseConfig((key) => key === "SIDEY_FIREBASE_PROJECT_ID" ? "other-project" : vars[key]), /binding_mismatch/);
  assert.throws(() => firebaseConfig((key) => key === "SIDEY_FIREBASE_DATABASE_URL" ? "https://evil.example/" : vars[key]), /database_url/);
});

test("path and hint validation reject cross-room paths, unsafe epochs and payload leakage", () => {
  assert.equal(streamPath(room, 2), `v1/rooms/${room}/epochs/2/hint`);
  assert.throws(() => streamPath("../other", 1));
  assert.throws(() => streamPath(room, Number.MAX_SAFE_INTEGER + 1));
  assert.throws(() => hintPayload({ ...row, publication_revision: 4 }));
  assert.throws(() => hintPayload({ ...row, kind: "entitlement_granted" }));
  const hint = hintPayload({ ...row, body: "must not leak", owner_id: event, price: 1000 });
  assert.deepEqual(Object.keys(hint).sort(), ["protocolVersion", "eventId", "kind", "roomId", "epoch", "revision", "occurredAt"].sort());
});

test("revision ordering uses decimal integers beyond JS safe number range", () => {
  const next = hintPayload(row);
  assert.equal(shouldReplaceHint(null, next), true);
  assert.equal(shouldReplaceHint(next, next), false);
  assert.equal(shouldReplaceHint({ ...next, revision: "9007199254740992" }, next), true);
  assert.equal(shouldReplaceHint({ ...next, revision: "9007199254740994" }, next), false);
  assert.throws(() => shouldReplaceHint({ ...next, roomId: event }, next));
});

test("publisher retries ETag races and never overwrites a newer hint", async () => {
  const calls = [];
  const responses = [new Response("null", { headers: { etag: '"first"' } }),
    new Response("", { status: 412 }),
    new Response(JSON.stringify({ ...hintPayload(row), revision: "9007199254740994" }), { headers: { etag: '"newer"' } })];
  await publishHint(config, "server-only", row, async (url, options) => {
    calls.push({ url, options }); return responses.shift();
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[1].options.headers["if-match"], '"first"');
  assert.ok(calls.every((c) => !c.url.includes("server-only")), "credentials never appear in URLs");
});

test("publisher rejects failed writes and missing ETags instead of acknowledging", async () => {
  await assert.rejects(publishHint(config, "token", row, async () => new Response("null")), /etag_missing/);
  let call = 0;
  await assert.rejects(publishHint(config, "token", row, async () => ++call === 1
    ? new Response("null", { headers: { etag: '"x"' } }) : new Response("private error", { status: 500 })), /write_failed/);
});

test("Firebase custom token binds unchanged user identity and independent short lease", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account = { client_email: "bridge@example.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }) };
  const token = await customToken(account, room, event, 1800000000000);
  const [header, body, signature] = token.split(".");
  assert.ok(verify("RSA-SHA256", Buffer.from(`${header}.${body}`), createPublicKey(privateKey), Buffer.from(signature, "base64url")));
  const claims = JSON.parse(Buffer.from(body, "base64url"));
  assert.equal(claims.uid, room);
  assert.deepEqual(claims.claims, { sideySessionId: event, sideyProtocol: 1 });
  assert.equal(claims.exp - claims.iat, 300);
  assert.equal(claims.aud, "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit");
});
