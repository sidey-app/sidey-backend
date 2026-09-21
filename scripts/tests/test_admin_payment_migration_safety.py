import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "supabase" / "migrations"
SUMMARY_MIGRATION = MIGRATIONS / "20260920125342_admin_payments_summary.sql"
APP_STORE_INDEX_MIGRATION = MIGRATIONS / "20260921024931_admin_payment_summary_concurrent_indexes.sql"
WEB_INDEX_MIGRATION = MIGRATIONS / "20260921025140_admin_payment_summary_web_index.sql"


class AdminPaymentMigrationSafetyTests(unittest.TestCase):
    def test_hot_ledger_indexes_are_built_concurrently_outside_a_transaction(self):
        summary_sql = SUMMARY_MIGRATION.read_text(encoding="utf-8").lower()
        app_store_index_sql = APP_STORE_INDEX_MIGRATION.read_text(encoding="utf-8").lower()
        web_index_sql = WEB_INDEX_MIGRATION.read_text(encoding="utf-8").lower()

        self.assertNotIn("app_store_transactions_user_production_history_idx", summary_sql)
        self.assertNotIn("commerce_orders_admin_purchase_idx", summary_sql)
        for index_sql in (app_store_index_sql, web_index_sql):
            self.assertNotRegex(
                index_sql,
                re.compile(r"^\s*(begin|commit|start\s+transaction)\b", re.MULTILINE),
            )
            self.assertIn("drop index concurrently if exists", index_sql)
        self.assertIn(
            "drop index concurrently if exists private.app_store_transactions_user_production_history_idx",
            app_store_index_sql,
        )
        self.assertIn(
            "create index concurrently app_store_transactions_user_production_history_idx",
            app_store_index_sql,
        )
        self.assertIn(
            "drop index concurrently if exists public.commerce_orders_admin_purchase_idx",
            web_index_sql,
        )
        self.assertIn(
            "create index concurrently commerce_orders_admin_purchase_idx",
            web_index_sql,
        )


if __name__ == "__main__":
    unittest.main()
