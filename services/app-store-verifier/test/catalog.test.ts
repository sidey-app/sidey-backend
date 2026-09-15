import assert from "node:assert/strict";
import test from "node:test";
import { entitlementByProduct, isSideyProductID, transactionStatus } from "../src/catalog.js";

test("legacy and solo product IDs remain accepted while typos fail closed", () => {
  assert.equal(Object.keys(entitlementByProduct).length, 34);
  assert.equal(isSideyProductID("character_monkey_solo"), true);
  assert.equal(isSideyProductID("character_monkey"), true);
  assert.equal(isSideyProductID("throwable_clam"), true);
  for (const id of ["character_monkey_solo_4", "character_monkey_solo_3", "character_monkey_solo_2", "throwable_clam_2", "throwable_pork_2"])
    assert.equal(isSideyProductID(id), true);
  assert.equal(isSideyProductID("character_monkey_solo_5"), false);
  assert.equal(isSideyProductID("haracter_pig"), false);
});

test("a revocation date makes a non-consumable transaction refunded", () => {
  assert.equal(transactionStatus(null), "active");
  assert.equal(transactionStatus(undefined), "active");
  assert.equal(transactionStatus(Date.now()), "refunded");
});
