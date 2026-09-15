import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const validEnvironment: NodeJS.ProcessEnv = {
  PORT: "8080",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  APPLE_BUNDLE_ID: "app.sidey.desktop.appstore",
  APPLE_APP_ID: "1234567890",
  APPLE_ROOT_CA_BASE64: Buffer.from("certificate").toString("base64"),
  APPLE_IAP_ISSUER_ID: "issuer",
  APPLE_IAP_KEY_ID: "iap-key",
  APPLE_IAP_PRIVATE_KEY: "private-key",
  APPLE_SIGN_IN_TEAM_ID: "team",
  APPLE_SIGN_IN_KEY_ID: "sign-in-key",
  APPLE_SIGN_IN_PRIVATE_KEY: "sign-in-private-key",
  APPLE_SIGN_IN_CLIENT_ID: "app.sidey.desktop.appstore",
};

test("configuration fails closed for a wrong bundle identifier", () => {
  assert.throws(
    () => loadConfig({ ...validEnvironment, APPLE_BUNDLE_ID: "app.sidey.desktop" }),
    /invalid_environment:APPLE_BUNDLE_ID/,
  );
});

test("configuration decodes one or more pinned Apple root certificates", () => {
  const config = loadConfig(validEnvironment);
  assert.equal(config.appleBundleID, "app.sidey.desktop.appstore");
  assert.equal(config.appleRootCAs.length, 1);
  assert.equal(config.appleRootCAs[0]?.toString("utf8"), "certificate");
});
