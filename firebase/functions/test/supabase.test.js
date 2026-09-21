"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {SupabaseBridgeError, persistRealtimeMessage} = require("../lib/supabase");

const config = {
  url: "https://example.supabase.co",
  publishableKey: "publishable-key-for-tests",
  serviceRoleKey: "service-role-key-for-tests",
  firebaseApiKey: "firebase-api-key-for-tests",
};
const command = {
  roomId: "20000000-0000-4000-8000-000000000001",
  messageId: "30000000-0000-4000-8000-000000000001",
  senderId: "10000000-0000-4000-8000-000000000001",
  body: "안녕하세요",
};
const sessionId = "40000000-0000-4000-8000-000000000001";
const fakeJwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({
  sub: command.senderId, session_id: sessionId,
})).toString("base64url")}.signature`;

test("persists callable chat with the Firebase-bound Supabase session", async () => {
  let request;
  const payload = {i: command.messageId, r: command.roomId, s: command.senderId,
    b: command.body, t: 1789859000000, n: 7};
  const result = await persistRealtimeMessage(config, {...command, sessionId}, async (url, options) => {
    request = {url, options};
    return new Response(JSON.stringify(payload), {
      status: 200, headers: {"content-type": "application/json"},
    });
  });
  assert.deepEqual(result, payload);
  assert.equal(request.url,
    "https://example.supabase.co/rest/v1/rpc/firebase_persist_realtime_message");
  assert.equal(JSON.parse(request.options.body).p_session_id, sessionId);
});

test("keeps rate limits and server failures retryable", async () => {
  for (const status of [429, 503]) {
    await assert.rejects(
      persistRealtimeMessage(config, {...command, sessionId}, async () => new Response(JSON.stringify({
        message: status === 429 ? "message_rate_limited" : "server_error",
      }), {status, headers: {"content-type": "application/json"}})),
      (error) => error instanceof SupabaseBridgeError && !error.permanent,
    );
  }
});

test("verifies the Supabase bearer token before issuing Firebase access", async () => {
  const {verifySupabaseUser} = require("../lib/supabase");
  let request;
  const user = await verifySupabaseUser(config, `Bearer ${fakeJwt}`, async (url, options) => {
    request = {url, options};
    return new Response(JSON.stringify({id: command.senderId}), {
      status: 200,
      headers: {"content-type": "application/json"},
    });
  });
  assert.equal(user.id, command.senderId);
  assert.equal(user.sessionId, sessionId);
  assert.equal(request.url, "https://example.supabase.co/auth/v1/user");
  assert.equal(request.options.headers.apikey, config.publishableKey);
});

test("rejects malformed bearer tokens without a network request", async () => {
  const {verifySupabaseUser} = require("../lib/supabase");
  let called = false;
  await assert.rejects(
    verifySupabaseUser(config, "Bearer malformed", async () => {
      called = true;
      throw new Error("unexpected");
    }),
    (error) => error instanceof SupabaseBridgeError && error.code === "authentication_required",
  );
  assert.equal(called, false);
});

test("loads and validates the service-role access snapshot", async () => {
  const {getRealtimeAccess} = require("../lib/supabase");
  const access = await getRealtimeAccess(config, command.senderId, async () => new Response(
    JSON.stringify({
      user_id: command.senderId,
      revision: "00000000000000000001",
      active: true,
      sessions: {[sessionId]: 8640000000000000},
      rooms: [command.roomId, command.roomId],
      items: ["throwable_bouncy_heart"],
      wire_items: ["7"],
    }),
    {status: 200, headers: {"content-type": "application/json"}},
  ));
  assert.deepEqual(access.rooms, [command.roomId]);
  assert.deepEqual(access.items, ["throwable_bouncy_heart"]);
  assert.deepEqual(access.wireItems, ["7"]);
});

test("a verified user response does not permit a mismatched subject or missing session", async () => {
  const {verifySupabaseUser} = require("../lib/supabase");
  for (const claims of [{sub: command.senderId}, {sub: sessionId, session_id: sessionId}]) {
    const jwt = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
    await assert.rejects(verifySupabaseUser(config, `Bearer ${jwt}`, async () =>
      new Response(JSON.stringify({id: command.senderId}), {status: 200})),
    /authentication_required/);
  }
});
