import test from "node:test";
import assert from "node:assert/strict";
import {validateDeliveryStatus} from "./support/delivery-status.mjs";

const complete = {
  ready: true,
  expected_users: 10,
  settled_users: 10,
  access_pending: 0,
  room_pending: 0,
  chat_publish_pending: 0,
  chat_cleanup_pending: 0,
};

test("smoke requires every expected access outbox row to be settled", () => {
  assert.equal(validateDeliveryStatus(complete, 10), complete);
  assert.throws(
    () => validateDeliveryStatus({...complete, settled_users: 9}, 10),
    /invalid_delivery_status/,
  );
});

test("post-finalization read-back permits removed settled outbox rows", () => {
  const finalized = {...complete, settled_users: 0};
  assert.equal(
    validateDeliveryStatus(finalized, 10, {requireSettled: false}),
    finalized,
  );
});

test("smoke rejects malformed delivery counters and mismatched scope", () => {
  assert.throws(
    () => validateDeliveryStatus({...complete, access_pending: 0.5}, 10),
    /invalid_delivery_status/,
  );
  assert.throws(
    () => validateDeliveryStatus({...complete, expected_users: 9}, 10),
    /invalid_delivery_status/,
  );
  assert.throws(() => validateDeliveryStatus(complete, 0), /invalid_delivery_status/);
});
