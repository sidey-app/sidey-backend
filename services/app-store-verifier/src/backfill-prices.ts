import { createClient } from "@supabase/supabase-js";
import { setTimeout } from "node:timers/promises";
import { AppleGateway } from "./apple.js";
import { loadConfig } from "./config.js";
import { backfillPrices, parseBackfillOptions, type UnpricedTransaction } from "./price-backfill.js";

async function main() {
  const options = parseBackfillOptions(process.argv.slice(2));
  const config = loadConfig();
  const apple = new AppleGateway(config);
  const supabase = createClient(config.supabaseURL, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }) },
  });
  const summary = await backfillPrices(options, {
    async list(environment, limit, before) {
      const { data, error } = await supabase.rpc("admin_list_app_store_unpriced", {
        p_environment: environment, p_limit: limit,
        p_before_purchased_at: before?.purchasedAt ?? null, p_before_key: before?.key ?? null,
      });
      if (error || !Array.isArray(data)) throw new Error("backfill_list_failed");
      return data as UnpricedTransaction[];
    },
    verify: (id, environment) => apple.getVerifiedTransaction(id, environment),
    async record(transaction) {
      const { data, error } = await supabase.rpc("admin_record_app_store_price", {
        p_transaction_id: transaction.transactionID,
        p_environment: transaction.environment,
        p_price_milliunits: transaction.priceMilliunits,
        p_currency: transaction.currency,
        p_signed_at: new Date(transaction.signedDate).toISOString(),
      });
      if (error) throw new Error("backfill_record_failed");
      return data === true;
    },
    delay: async (milliseconds) => { await setTimeout(milliseconds); },
  });
  console.log(JSON.stringify(summary));
  if (summary.failed > 0) process.exitCode = 1;
}

void main().catch(() => {
  console.error("backfill_failed: check options, migration and verifier secret configuration");
  process.exitCode = 1;
});
