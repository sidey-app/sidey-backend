import test from "node:test";
import assert from "node:assert/strict";
import {firebaseAdminCredentialFromEnvironment} from "./support/firebase-admin-credential.mjs";

test("smoke uses ADC when no explicit Firebase CLI credential is supplied", () => {
  assert.equal(firebaseAdminCredentialFromEnvironment({}, () => 1_000), undefined);
});

test("smoke rejects partial, malformed, or near-expiry credentials", () => {
  assert.throws(
    () => firebaseAdminCredentialFromEnvironment({
      SIDEY_FIREBASE_ADMIN_ACCESS_TOKEN: "x".repeat(128),
    }, () => 1_000),
    /invalid_firebase_admin_access_token/,
  );
  assert.throws(
    () => firebaseAdminCredentialFromEnvironment({
      SIDEY_FIREBASE_ADMIN_ACCESS_TOKEN: "x".repeat(128),
      SIDEY_FIREBASE_ADMIN_ACCESS_TOKEN_EXPIRES_AT: "600999",
    }, () => 1_000),
    /invalid_firebase_admin_access_token/,
  );
});

test("smoke wraps a sufficiently fresh short-lived Firebase CLI token", async () => {
  const credential = firebaseAdminCredentialFromEnvironment({
    SIDEY_FIREBASE_ADMIN_ACCESS_TOKEN: "x".repeat(128),
    SIDEY_FIREBASE_ADMIN_ACCESS_TOKEN_EXPIRES_AT: "1201000",
  }, () => 1_000);
  const value = await credential.getAccessToken();
  assert.equal(value.access_token, "x".repeat(128));
  assert.ok(Number.isSafeInteger(value.expires_in));
  assert.ok(value.expires_in > 60);
});
