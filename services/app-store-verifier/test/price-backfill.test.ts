import assert from "node:assert/strict";
import test from "node:test";
import { mapVerifiedTransaction } from "../src/apple.js";
import { backfillPrices, parseBackfillOptions, decodeBackfillCursor, type BackfillDependencies } from "../src/price-backfill.js";

const cursorFields = { purchased_at: "2026-09-15T00:00:00.123456+00:00", cursor_key: "a".repeat(64) };
const transaction = mapVerifiedTransaction({ transactionId: "test-id", originalTransactionId: "test-original",
  productId: "character_monkey_solo_4", purchaseDate: 1_700_000_000_000,
  signedDate: 1_700_000_000_100, price: 1100000, currency: "KRW" }, "jws", "Production");

function fixture() {
  const calls: string[] = [];
  const dependencies: BackfillDependencies = {
    list: async () => [{ ...cursorFields, transaction_id: transaction.transactionID, product_id: transaction.productID, environment: "Production" }],
    verify: async () => { calls.push("verify"); return transaction; },
    record: async () => { calls.push("record"); return true; },
    delay: async (milliseconds) => { assert.ok(milliseconds >= 250); calls.push("delay"); },
  };
  return { calls, dependencies };
}

test("CLI defaults to bounded production dry run and rejects unsafe options", () => {
  assert.deepEqual(parseBackfillOptions([]), { apply: false, environment: "Production", limit: 25, before: null });
  assert.deepEqual(parseBackfillOptions(["--apply", "--environment", "Sandbox", "--limit", "100"]),
    { apply: true, environment: "Sandbox", limit: 100, before: null });
  for (const args of [["--limit", "0"], ["--limit", "101"], ["--limit", "1.5"], ["--limit"], ["--environment", "prod"], ["--foo"], ["--apply", "--apply"]]) {
    assert.throws(() => parseBackfillOptions(args));
  }
});

test("dry run verifies prices without writing or printing transaction identity", async () => {
  const { dependencies, calls } = fixture();
  const result = await backfillPrices(parseBackfillOptions([]), dependencies);
  assert.equal(result.available, 1);
  assert.equal(result.recorded, 0);
  assert.deepEqual(calls, ["verify"]);
  assert.ok(!JSON.stringify(result).includes(transaction.transactionID));
});

test("apply is sequential with delay and writes only available verified amounts", async () => {
  const { dependencies, calls } = fixture();
  const row = { ...cursorFields, transaction_id: transaction.transactionID, product_id: transaction.productID, environment: "Production" as const };
  dependencies.list = async () => [row, row, row];
  let index = 0;
  dependencies.verify = async () => {
    calls.push("verify");
    index++;
    if (index === 2) return { ...transaction, priceMilliunits: null, currency: null };
    if (index === 3) throw new Error("do-not-log-secret");
    return transaction;
  };
  const result = await backfillPrices(parseBackfillOptions(["--apply"]), dependencies);
  assert.equal(result.recorded, 1);
  assert.equal(result.missing, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(calls, ["verify", "record", "delay", "verify", "delay", "verify"]);
});

test("verified identity mismatch never writes and list exceeding bound never verifies", async () => {
  const { dependencies, calls } = fixture();
  dependencies.verify = async () => ({ ...transaction, environment: "Sandbox" });
  assert.equal((await backfillPrices(parseBackfillOptions(["--apply"]), dependencies)).failed, 1);
  assert.deepEqual(calls, []);
  dependencies.list = async () => Array.from({ length: 101 }, () => ({ ...cursorFields, transaction_id: "id", product_id: "p", environment: "Production" }));
  await assert.rejects(backfillPrices(parseBackfillOptions([]), dependencies), /backfill_limit_exceeded/);
});


test("a concurrent price fill is not reported as a new write", async () => {
  const { dependencies } = fixture();
  dependencies.record = async () => false;
  const result = await backfillPrices(parseBackfillOptions(["--apply"]), dependencies);
  assert.equal(result.available, 1);
  assert.equal(result.recorded, 0);
});


test("cursor progresses past a full batch whose Apple prices remain unavailable", async () => {
  const { dependencies } = fixture();
  dependencies.verify = async () => ({ ...transaction, priceMilliunits: null, currency: null });
  const first = await backfillPrices(parseBackfillOptions(["--limit", "1"]), dependencies);
  assert.equal(first.missing, 1);
  assert.equal(first.nextCursor, `${cursorFields.purchased_at}|${cursorFields.cursor_key}`);
  const options = parseBackfillOptions(["--limit", "1", "--before", first.nextCursor!]);
  dependencies.list = async (_environment, _limit, before) => {
    assert.deepEqual(before, { purchasedAt: cursorFields.purchased_at, key: cursorFields.cursor_key });
    return [];
  };
  assert.equal((await backfillPrices(options, dependencies)).nextCursor, null);
  for (const bad of ["", "id", "2026-09-15|" + "a".repeat(64),
    "2026-09-15T00:00:00Z|raw-transaction-id", "2026-99-15T00:00:00Z|" + "a".repeat(64)]) {
    assert.throws(() => decodeBackfillCursor(bad));
  }
});
