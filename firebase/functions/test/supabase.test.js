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

test("uses opaque secret keys only as apikey and preserves legacy JWT headers", () => {
  const {serviceHeaders} = require("../lib/supabase");
  assert.deepEqual(serviceHeaders("sb_secret_test_only_not_a_real_key"), {
    apikey: "sb_secret_test_only_not_a_real_key",
  });
  assert.deepEqual(serviceHeaders("legacy-service-role-jwt"), {
    apikey: "legacy-service-role-jwt",
    authorization: "Bearer legacy-service-role-jwt",
  });
});

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
  assert.equal(request.options.headers.authorization, `Bearer ${config.serviceRoleKey}`);
});

test("does not send an opaque secret key as a bearer token", async () => {
  let request;
  await persistRealtimeMessage(
    {...config, serviceRoleKey: "sb_secret_test_only_not_a_real_key"},
    {...command, sessionId},
    async (url, options) => {
      request = {url, options};
      return new Response(JSON.stringify({
        i: command.messageId, r: command.roomId, s: command.senderId,
        b: command.body, t: 1789859000000, n: 7,
      }), {status: 200, headers: {"content-type": "application/json"}});
    },
  );
  assert.equal(request.options.headers.apikey, "sb_secret_test_only_not_a_real_key");
  assert.equal("authorization" in request.options.headers, false);
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
  let request;
  const access = await getRealtimeAccess(
    {...config, serviceRoleKey: "sb_secret_test_only_not_a_real_key"},
    command.senderId,
    async (url, options) => {
      request = {url, options};
      return new Response(JSON.stringify({
        user_id: command.senderId,
        revision: "00000000000000000001",
        active: true,
        sessions: {[sessionId]: 8640000000000000},
        rooms: [command.roomId, command.roomId],
        items: ["throwable_bouncy_heart"],
        wire_items: ["7"],
      }), {status: 200, headers: {"content-type": "application/json"}});
    },
  );
  assert.deepEqual(access.rooms, [command.roomId]);
  assert.deepEqual(access.items, ["throwable_bouncy_heart"]);
  assert.deepEqual(access.wireItems, ["7"]);
  assert.equal(request.options.headers.apikey, "sb_secret_test_only_not_a_real_key");
  assert.equal("authorization" in request.options.headers, false);
});

test("requires a current server-selected rollout lease before bootstrap", async () => {
  const {getRealtimeBootstrapAuthorization} = require("../lib/supabase");
  const now = 1789859000000;
  let request;
  const authorization = await getRealtimeBootstrapAuthorization(
    config, command.senderId, sessionId, async (url, options) => {
      request = {url, options};
      return new Response(JSON.stringify({
        allowed: true,
        leaseExpiresAt: now + 300_000,
        protocolVersion: 2,
        contractHash: "0f2845d033df248b1745c6526c8c7100b8d8fa6839b45f28c73b1023053fce2e",
      }), {status: 200, headers: {"content-type": "application/json"}});
    }, now,
  );
  assert.equal(authorization.leaseExpiresAt, now + 300_000);
  assert.equal(request.url,
    "https://example.supabase.co/rest/v1/rpc/firebase_realtime_bootstrap_authorization");
  assert.deepEqual(JSON.parse(request.options.body), {
    p_user_id: command.senderId,
    p_session_id: sessionId,
  });

  for (const payload of [
    {allowed: false},
    {allowed: true, leaseExpiresAt: now + 300_001, protocolVersion: 2,
      contractHash: "bad"},
    {allowed: true, leaseExpiresAt: now - 1, protocolVersion: 2,
      contractHash: "0f2845d033df248b1745c6526c8c7100b8d8fa6839b45f28c73b1023053fce2e"},
  ]) {
    await assert.rejects(getRealtimeBootstrapAuthorization(
      config, command.senderId, sessionId,
      async () => new Response(JSON.stringify(payload), {status: 200}), now,
    ), (error) => error instanceof SupabaseBridgeError &&
      ["realtime_rollout_disabled", "realtime_rollout_invalid"].includes(error.code));
  }
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
