import assert from "node:assert/strict";
import test from "node:test";
import type { JWSTransactionDecodedPayload } from "@apple/app-store-server-library";
import { mapVerifiedTransaction } from "../src/apple.js";
import { transactionRPCParameters } from "../src/transaction-parameters.js";

const payload = { transactionId: "test-transaction", originalTransactionId: "test-original",
  productId: "character_monkey_solo_4", purchaseDate: 1_700_000_000_000,
  signedDate: 1_700_000_000_100 };

for (const environment of ["Production", "Sandbox"] as const) {
  test(`${environment}: preserve verified Apple milliunits, currency and total without quantity multiplication`, () => {
    const verified = mapVerifiedTransaction({ ...payload, price: 1_100_000, currency: "KRW", quantity: 2 }, "verified-jws", environment);
    assert.equal(verified.priceMilliunits, 1_100_000);
    assert.equal(verified.currency, "KRW");
    const params = transactionRPCParameters(verified, null);
    assert.equal(params.p_price_milliunits, 1_100_000);
    assert.equal(params.p_currency, "KRW");
    assert.equal(params.p_environment, environment);
    assert.equal(Object.keys(params).length, 13);
    assert.equal(params.p_status, "active");
  });
}

test("zero priced verified transaction remains known zero; refunds retain original price", () => {
  const verified = mapVerifiedTransaction({ ...payload, price: 0, currency: "USD", revocationDate: payload.signedDate }, "verified-jws", "Production");
  assert.equal(verified.priceMilliunits, 0);
  const params = transactionRPCParameters(verified, "user");
  assert.equal(params.p_status, "refunded");
  assert.equal(params.p_price_milliunits, 0);
});

test("missing or malformed amounts become unknown pairs without rejecting the purchase", () => {
  const cases = [{}, { price: 1000 }, { currency: "USD" }, { price: -1, currency: "USD" },
    { price: 1.5, currency: "USD" }, { price: NaN, currency: "USD" },
    { price: Infinity, currency: "USD" }, { price: Number.MAX_SAFE_INTEGER + 1, currency: "USD" },
    { price: "1000", currency: "USD" }, { price: 1000, currency: "usd" },
    { price: 1000, currency: "US" }, { price: 1000, currency: " USD" }];
  for (const fields of cases) {
    const verified = mapVerifiedTransaction({ ...payload, ...fields } as JWSTransactionDecodedPayload, "verified-jws", "Production");
    assert.equal(verified.priceMilliunits, null);
    assert.equal(verified.currency, null);
    assert.equal(transactionRPCParameters(verified, null).p_price_milliunits, null);
  }
});
