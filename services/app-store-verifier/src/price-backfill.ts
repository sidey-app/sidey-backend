import type { VerifiedTransaction } from "./apple.js";

export interface BackfillOptions {
  apply: boolean;
  environment: "Production" | "Sandbox";
  limit: number;
  before: string | null;
}

export function parseBackfillOptions(args: string[]): BackfillOptions {
  const options: BackfillOptions = { apply: false, environment: "Production", limit: 25, before: null };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (seen.has(arg)) throw new Error("duplicate_backfill_option");
    seen.add(arg);
    if (arg === "--apply") options.apply = true;
    else if (arg === "--environment") {
      const value = args[++index];
      if (value !== "Production" && value !== "Sandbox") throw new Error("invalid_backfill_environment");
      options.environment = value;
    } else if (arg === "--before") {
      options.before = args[++index] ?? "";
      decodeBackfillCursor(options.before);
    } else if (arg === "--limit") {
      const value = args[++index];
      if (!value || !/^\d+$/.test(value)) throw new Error("invalid_backfill_limit");
      options.limit = Number(value);
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
        throw new Error("invalid_backfill_limit");
      }
    } else throw new Error("unknown_backfill_option");
  }
  return options;
}

export function decodeBackfillCursor(cursor: string | null) {
  if (cursor === null) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))\|([0-9a-f]{64})$/.exec(cursor);
  if (!match || !Number.isFinite(Date.parse(match[1]!))) throw new Error("invalid_backfill_cursor");
  return { purchasedAt: match[1]!, key: match[2]! };
}

export interface UnpricedTransaction {
  transaction_id: string;
  purchased_at: string;
  cursor_key: string;
  product_id: string;
  environment: "Production" | "Sandbox";
}

export interface BackfillDependencies {
  list(environment: BackfillOptions["environment"], limit: number, before: ReturnType<typeof decodeBackfillCursor>): Promise<UnpricedTransaction[]>;
  verify(transactionID: string, environment: BackfillOptions["environment"]): Promise<VerifiedTransaction>;
  record(transaction: VerifiedTransaction): Promise<boolean>;
  delay(milliseconds: number): Promise<void>;
}

export async function backfillPrices(options: BackfillOptions, dependencies: BackfillDependencies) {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("invalid_backfill_limit");
  }
  const rows = await dependencies.list(options.environment, options.limit, decodeBackfillCursor(options.before));
  if (rows.length > options.limit) throw new Error("backfill_limit_exceeded");
  const last = rows.at(-1);
  const nextCursor = last ? `${last.purchased_at}|${last.cursor_key}` : null;
  decodeBackfillCursor(nextCursor);
  const summary = { nextCursor, mode: options.apply ? "apply" : "dry-run", environment: options.environment,
    selected: rows.length, available: 0, recorded: 0, missing: 0, failed: 0 };
  for (let index = 0; index < rows.length; index++) {
    if (index > 0) await dependencies.delay(300);
    const row = rows[index]!;
    try {
      if (row.environment !== options.environment) throw new Error("backfill_environment_mismatch");
      const transaction = await dependencies.verify(row.transaction_id, options.environment);
      if (transaction.transactionID !== row.transaction_id
          || transaction.productID !== row.product_id
          || transaction.environment !== row.environment) throw new Error("backfill_transaction_mismatch");
      if (transaction.priceMilliunits === null || transaction.currency === null) {
        summary.missing++;
        continue;
      }
      summary.available++;
      if (options.apply) {
        if (await dependencies.record(transaction)) summary.recorded++;
      }
    } catch {
      // Do not print Apple payloads, service credentials or transaction identifiers.
      summary.failed++;
    }
  }
  return summary;
}
