"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {bootstrapRealtime, syncRealtimeAccess,
  retryRealtimeAccess, reconcileRealtimeAccess, syncRealtimeRoomRevisions,
  retryRealtimeRoomRevisions, sendRealtimeChat, syncRealtimeChat,
  retryRealtimeChat, syncRealtimeTransients, retryRealtimeTransients,
  bridgeRealtimeTyping, bridgeRealtimePulse, bridgeRealtimeThrow} = require("../index");

test("does not export the removed legacy RTDB chat trigger", () => {
  assert.equal(require("../index").persistChatCommand, undefined);
});

test("access workers are bounded and reconciliation runs daily in Korea", () => {
  assert.equal(syncRealtimeAccess.__endpoint.maxInstances, 1);
  assert.equal(syncRealtimeAccess.__endpoint.concurrency, 1);
  assert.equal(retryRealtimeAccess.__endpoint.scheduleTrigger.schedule, "every 1 minutes");
  assert.equal(reconcileRealtimeAccess.__endpoint.scheduleTrigger.schedule, "30 3 * * *");
  assert.equal(reconcileRealtimeAccess.__endpoint.scheduleTrigger.timeZone, "Asia/Seoul");
});

test("room revision workers cannot outlive their database claim safety margin", () => {
  assert.equal(syncRealtimeRoomRevisions.__endpoint.timeoutSeconds, 60);
  assert.equal(syncRealtimeRoomRevisions.__endpoint.maxInstances, 1);
  assert.equal(syncRealtimeRoomRevisions.__endpoint.concurrency, 1);
  assert.equal(retryRealtimeRoomRevisions.__endpoint.timeoutSeconds, 60);
  assert.equal(retryRealtimeRoomRevisions.__endpoint.scheduleTrigger.schedule, "every 1 minutes");
});

test("exports a bounded bootstrap endpoint in the same region", () => {
  const endpoint = bootstrapRealtime.__endpoint;
  assert.deepEqual(endpoint.region, ["asia-southeast1"]);
  assert.equal(endpoint.maxInstances, 10);
  assert.equal(endpoint.concurrency, 20);
  assert.equal(endpoint.platform, "gcfv2");
});

test("chat callable and durable publisher are bounded independently", () => {
  assert.equal(sendRealtimeChat.__endpoint.callableTrigger !== undefined, true);
  assert.equal(sendRealtimeChat.__endpoint.maxInstances, 10);
  assert.equal(sendRealtimeChat.__endpoint.concurrency, 20);
  assert.equal(syncRealtimeChat.__endpoint.maxInstances, 1);
  assert.equal(syncRealtimeChat.__endpoint.concurrency, 1);
  assert.equal(syncRealtimeChat.__endpoint.timeoutSeconds, 60);
  assert.equal(retryRealtimeChat.__endpoint.scheduleTrigger.schedule, "every 1 minutes");
});

test("transient bridge exports bounded durable workers and three RTDB triggers", () => {
  assert.equal(syncRealtimeTransients.__endpoint.maxInstances, 1);
  assert.equal(syncRealtimeTransients.__endpoint.concurrency, 1);
  assert.equal(syncRealtimeTransients.__endpoint.timeoutSeconds, 60);
  assert.deepEqual(
    syncRealtimeTransients.__endpoint.secretEnvironmentVariables.map((secret) => secret.key),
    ["SIDEY_SUPABASE_CONFIG", "SIDEY_TRANSIENT_WAKE_TOKEN"],
  );
  assert.equal(retryRealtimeTransients.__endpoint.scheduleTrigger.schedule, "every 1 minutes");
  for (const trigger of [bridgeRealtimeTyping, bridgeRealtimePulse, bridgeRealtimeThrow]) {
    assert.equal(trigger.__endpoint.platform, "gcfv2");
    assert.equal(trigger.__endpoint.maxInstances, 20);
    assert.equal(trigger.__endpoint.concurrency, 20);
    assert.equal(trigger.__endpoint.eventTrigger.retry, true);
  }
});
