import hashlib
import json
import copy
import datetime
import pathlib
import sys
import unittest
from argparse import Namespace
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "supabase"))

import firebase_m0_apply as apply  # noqa: E402


PLAN = json.loads(apply.PLAN_PATH.read_text(encoding="utf-8"))
MANIFEST = json.loads(apply.MANIFEST_PATH.read_text(encoding="utf-8"))


def synthetic_schema(*, variant_index=0, top_blank_count=3):
    catalog = PLAN["baseSchema"]["constraintCatalog"]
    blank = "\n" * top_blank_count
    return (
        "-- schema\n"
        + blank
        + catalog[0]["dumpVariants"][variant_index]
        + "\n"
        + catalog[1]["dumpVariants"][variant_index]
        + "\n"
        + blank
        + "CREATE FUNCTION public.keep_bytes() RETURNS text AS $fn$\r\n"
        + "BEGIN\r\n\r\n  RETURN 'body';\r\nEND;\r\n"
        + "$fn$ LANGUAGE plpgsql;\n"
        + "SELECT 'single\n\nquoted';\n"
        + "/* block\n\ncomment */\n"
        + "GRANT SELECT ON public.example TO authenticated;\n"
        + "CREATE POLICY example_read ON public.example FOR SELECT USING (true);\n"
        + blank
    ).encode("utf-8")


def acl_rows(grantee, privileges, *, grantable=()):
    return [
        {"grantee": grantee, "privilege": privilege,
         "grantable": privilege in set(grantable)}
        for privilege in sorted(privileges)
    ]


def realtime_snapshot(start=datetime.date(2026, 9, 19), postgres_mode="mixed"):
    all_privileges = apply.TABLE_PRIVILEGES
    columns = [
        {"name": "topic", "type": "text", "notNull": True, "default": None},
        {"name": "extension", "type": "text", "notNull": True, "default": None},
        {"name": "payload", "type": "jsonb", "notNull": False, "default": None},
        {"name": "event", "type": "text", "notNull": False, "default": None},
        {"name": "private", "type": "boolean", "notNull": False, "default": "false"},
        {"name": "updated_at", "type": "timestamp without time zone", "notNull": True, "default": "now()"},
        {"name": "inserted_at", "type": "timestamp without time zone", "notNull": True, "default": "now()"},
        {"name": "id", "type": "uuid", "notNull": True, "default": "gen_random_uuid()"},
        {"name": "binary_payload", "type": "bytea", "notNull": False, "default": None},
        {"name": "skip_broadcast", "type": "boolean", "notNull": True, "default": "false"},
    ]
    parent_acl = (
        acl_rows("supabase_realtime_admin", all_privileges)
        + acl_rows("dashboard_user", all_privileges)
        + acl_rows("anon", {"INSERT", "SELECT", "UPDATE"})
        + acl_rows("authenticated", {"INSERT", "SELECT", "UPDATE"})
        + acl_rows("service_role", {"INSERT", "SELECT", "UPDATE"})
        + acl_rows("postgres", all_privileges, grantable={"INSERT", "SELECT"})
    )
    parent = {
        "relkind": "p", "isPartition": False,
        "owner": "supabase_realtime_admin", "rls": True, "forceRls": False,
        "partitionKey": "RANGE (inserted_at)", "columns": columns,
        "constraints": [
            {"name": "messages_payload_exclusive", "type": "c", "validated": False,
             "definition": "CHECK (payload IS NULL OR binary_payload IS NULL) NOT VALID"},
            {"name": "messages_pkey", "type": "p", "validated": True,
             "definition": "PRIMARY KEY (id, inserted_at)"},
        ],
        "indexes": [
            {"name": "messages_inserted_at_topic_index", "valid": True,
             "ready": True, "unique": False, "primary": False,
             "definition": "CREATE INDEX messages_inserted_at_topic_index ON ONLY realtime.messages USING btree (inserted_at DESC, topic) WHERE ((extension = 'broadcast'::text) AND (private IS TRUE))"},
            {"name": "messages_pkey", "valid": True, "ready": True,
             "unique": True, "primary": True,
             "definition": "CREATE UNIQUE INDEX messages_pkey ON ONLY realtime.messages USING btree (id, inserted_at)"},
        ],
        "acl": parent_acl,
    }
    policies = [
        {"name": "sidey_room_channels_insert", "permissive": "PERMISSIVE",
         "cmd": "INSERT", "roles": ["authenticated"], "qual": None,
         "withCheck": "insert-check"},
        {"name": "sidey_room_channels_select", "permissive": "PERMISSIVE",
         "cmd": "SELECT", "roles": ["authenticated"], "qual": "select-qual",
         "withCheck": None},
    ]
    execute = [
        {"grantee": grantee, "grantable": False}
        for grantee in ("PUBLIC", "dashboard_user", "postgres", "supabase_realtime_admin")
    ]
    routines = [
        {"signature": "realtime.send(payload jsonb, event text, topic text, private boolean)",
         "return": "void", "owner": "supabase_realtime_admin",
         "securityDefiner": False, "volatility": "v", "config": None,
         "execute": execute},
        {"signature": "realtime.topic()", "return": "text",
         "owner": "supabase_realtime_admin", "securityDefiner": False,
         "volatility": "s", "config": None, "execute": execute},
    ]
    children = []
    for offset in range(7):
        date = start + datetime.timedelta(days=offset)
        upper = date + datetime.timedelta(days=1)
        name = f"messages_{date.strftime('%Y_%m_%d')}"
        modern = postgres_mode == "modern" or (
            postgres_mode == "mixed" and offset == 6
        )
        child_acl = (
            acl_rows("supabase_realtime_admin", all_privileges)
            + acl_rows("dashboard_user", all_privileges)
            + acl_rows("postgres", all_privileges,
                       grantable={"INSERT", "SELECT"} if modern else set())
        )
        children.append({
            "name": name,
            "bound": f"FOR VALUES FROM ('{date.isoformat()} 00:00:00') TO ('{upper.isoformat()} 00:00:00')",
            "owner": "supabase_realtime_admin", "relkind": "r",
            "isPartition": True, "columns": copy.deepcopy(columns),
            "constraints": [
                {"name": f"{name}_pkey", "type": "p", "validated": True,
                 "definition": "PRIMARY KEY (id, inserted_at)"},
                {"name": "messages_payload_exclusive", "type": "c",
                 "validated": True,
                 "definition": "CHECK (payload IS NULL OR binary_payload IS NULL)"},
            ],
            "indexes": [
                {"name": f"{name}_inserted_at_topic_idx", "valid": True,
                 "ready": True, "unique": False, "primary": False,
                 "definition": f"CREATE INDEX {name}_inserted_at_topic_idx ON realtime.{name} USING btree (inserted_at DESC, topic) WHERE ((extension = 'broadcast'::text) AND (private IS TRUE))",
                 "parentIndex": "messages_inserted_at_topic_index"},
                {"name": f"{name}_pkey", "valid": True, "ready": True,
                 "unique": True, "primary": True,
                 "definition": f"CREATE UNIQUE INDEX {name}_pkey ON realtime.{name} USING btree (id, inserted_at)",
                 "parentIndex": "messages_pkey"},
            ],
            "acl": child_acl,
        })
    return {"utcToday": "2026-09-22", "parent": parent,
            "policies": policies, "routines": routines, "children": children}


def stable_contract_and_hash(snapshot):
    stable = apply.validate_realtime_contract_snapshot(snapshot, None)
    payload = json.dumps(stable, ensure_ascii=True, sort_keys=True,
                         separators=(",", ":")).encode() + b"\n"
    return stable, hashlib.sha256(payload).hexdigest()


def migration(version: str) -> dict[str, str]:
    return {"version": version, "name": f"migration_{version}"}


def commerce_snapshot(seed: int = 1) -> dict:
    names = (
        apply.COMMERCE_EXACT_SETS
        + apply.COMMERCE_PRESERVED_SETS
        + apply.COMMERCE_OBSERVED_SETS
    )
    return {
        "sets": {
            name: [hashlib.sha256(f"{name}:{seed}".encode()).hexdigest()]
            for name in names
        },
        "invalidEquipped": {"bubble": 0, "throwable": 0},
    }


class FirebaseM0ApplyTests(unittest.TestCase):
    def setUp(self):
        self.fixed = [migration("20260101000000"), migration("20260301000000")]
        self.additions = [
            migration("20260201000000"),
            migration("20260401000000"),
            migration("20260501000000"),
        ]

    def state(self, count: int) -> list[dict[str, str]]:
        return sorted(
            self.fixed + self.additions[:count], key=lambda item: item["version"]
        )

    def test_accepts_every_exact_sorted_prefix(self):
        for count in range(len(self.additions) + 1):
            with self.subTest(count=count):
                self.assertEqual(
                    apply.exact_prefix_count(
                        self.state(count), self.fixed, self.additions
                    ),
                    count,
                )

    def test_rejects_non_prefix_subset(self):
        current = sorted(
            self.fixed + [self.additions[1]], key=lambda item: item["version"]
        )
        self.assertIsNone(
            apply.exact_prefix_count(current, self.fixed, self.additions)
        )

    def test_rejects_extra_or_renamed_history(self):
        extra = self.state(2) + [migration("20990101000000")]
        self.assertIsNone(apply.exact_prefix_count(extra, self.fixed, self.additions))

        renamed = self.state(2)
        renamed[1] = {**renamed[1], "name": "unexpected"}
        self.assertIsNone(apply.exact_prefix_count(renamed, self.fixed, self.additions))

    def test_safe_rollout_state_requires_exact_empty_singletons_and_cohorts(self):
        safe = [
            [{"enabled": False, "direct_events_enabled": False}],
            [{"disabled": True, "owner_clear": True, "deadline_clear": True,
              "edge_clear": True, "publisher_clear": True}],
            [{"wake_clear": True}],
            [{"shadow_users": 0, "live_users": 0, "live_rooms": 0}],
        ]
        with mock.patch.object(apply, "query", side_effect=safe):
            apply.verify_safe_rollout_state()

    def test_safe_rollout_state_rejects_singleton_or_cohort_drift(self):
        unsafe_states = [
            [
                [{"enabled": True, "direct_events_enabled": False}],
            ],
            [
                [{"enabled": False, "direct_events_enabled": True}],
            ],
            [
                [{"enabled": False, "direct_events_enabled": False}],
                [{"disabled": True, "owner_clear": False, "deadline_clear": True,
                  "edge_clear": True, "publisher_clear": True}],
            ],
            [
                [{"enabled": False, "direct_events_enabled": False}],
                [{"disabled": True, "owner_clear": True, "deadline_clear": True,
                  "edge_clear": True, "publisher_clear": True}],
                [{"wake_clear": False}],
            ],
            [
                [{"enabled": False, "direct_events_enabled": False}],
                [{"disabled": True, "owner_clear": True, "deadline_clear": True,
                  "edge_clear": True, "publisher_clear": True}],
                [{"wake_clear": True}],
                [{"shadow_users": 1, "live_users": 0, "live_rooms": 0}],
            ],
        ]
        for state in unsafe_states:
            with self.subTest(state=state):
                with mock.patch.object(apply, "query", side_effect=state):
                    with self.assertRaises(apply.ApplyError):
                        apply.verify_safe_rollout_state()

    def test_commerce_snapshot_sql_hashes_only_expected_recovery_tables(self):
        statement = apply.commerce_critical_snapshot_sql()
        self.assertIn("extensions.digest", statement)
        for table in (
            "auth.users", "public.profiles", "public.commerce_products",
            "public.commerce_prices", "public.commerce_orders",
            "public.commerce_entitlements", "private.commerce_payments",
            "private.commerce_webhook_events", "private.commerce_refund_operations",
            "private.commerce_grants", "private.app_store_transactions",
            "private.app_store_product_offers", "private.app_store_notification_events",
            "private.admin_payment_catalog_snapshot", "private.character_item_transition",
        ):
            self.assertIn(table, statement)
        self.assertIn("entitlement.status='active'", statement)
        self.assertIn("payment_key,portone_payment_id", statement)
        self.assertIn("portone_store_id,portone_channel_key", statement)
        self.assertNotIn("signed_data_sha256", statement)

    def test_wire_code_contract_requires_exact_pinned_mapping(self):
        rows = [
            {
                "product_kind": kind,
                "product_id": product_id,
                "catalog_item_id": catalog_item_id,
                "wire_code": wire_code,
            }
            for kind, product_id, catalog_item_id, wire_code in sorted(
                apply.WIRE_CODE_CONTRACT,
                key=lambda item: (item[0], item[3], item[1]),
            )
        ]
        with mock.patch.object(apply, "query", return_value=rows):
            apply.verify_wire_code_contract()
        rows[0] = {**rows[0], "wire_code": 999}
        with mock.patch.object(apply, "query", return_value=rows):
            with self.assertRaisesRegex(apply.ApplyError, "wire-code"):
                apply.verify_wire_code_contract()

    def test_commerce_snapshot_shape_and_equipped_ownership_are_fail_closed(self):
        snapshot = commerce_snapshot()
        with mock.patch.object(apply, "query", return_value=[{"snapshot": snapshot}]):
            self.assertEqual(apply.commerce_critical_snapshot(), snapshot)

        bad = copy.deepcopy(snapshot)
        bad["invalidEquipped"]["bubble"] = 1
        with mock.patch.object(apply, "query", return_value=[{"snapshot": bad}]):
            with self.assertRaisesRegex(apply.ApplyError, "equipped ownership"):
                apply.commerce_critical_snapshot()

    def test_commerce_preservation_allows_append_and_live_equipment_change(self):
        before = commerce_snapshot()
        after = copy.deepcopy(before)
        for index, name in enumerate(apply.COMMERCE_PRESERVED_SETS):
            after["sets"][name].append(
                hashlib.sha256(f"{name}:new:{index}".encode()).hexdigest()
            )
            after["sets"][name].sort()
        after["sets"]["equippedState"] = ["f" * 64]
        evidence = apply.verify_commerce_critical_preserved(before, after)
        self.assertTrue(evidence["equippedStateChanged"])
        self.assertTrue(all(delta == 1 for delta in evidence["deltas"].values()
                            if delta != 0))

    def test_commerce_preservation_rejects_catalog_or_existing_row_drift(self):
        before = commerce_snapshot()
        catalog_drift = copy.deepcopy(before)
        catalog_drift["sets"][apply.COMMERCE_EXACT_SETS[0]] = ["f" * 64]
        with self.assertRaisesRegex(apply.ApplyError, "exact set changed"):
            apply.verify_commerce_critical_preserved(before, catalog_drift)

        missing = copy.deepcopy(before)
        missing["sets"][apply.COMMERCE_PRESERVED_SETS[0]] = []
        with self.assertRaisesRegex(apply.ApplyError, "changed or disappeared"):
            apply.verify_commerce_critical_preserved(before, missing)

    def test_atomic_runner_commits_schema_and_history_together(self):
        source = """-- phase\nbegin;\nset local lock_timeout='5s';\ncreate table private.example(id int);\ncommit;\n"""
        rendered = apply.atomic_migration_call_sql(
            source, "20260921140000", "firebase_example"
        )
        self.assertTrue(rendered.startswith("select private.sidey_apply_atomic_migration("))
        self.assertIn("create table private.example", rendered)
        self.assertIn("supabase_migrations.schema_migrations", apply.ATOMIC_RUNNER_SQL)
        self.assertIn("foreach statement", apply.ATOMIC_RUNNER_SQL)
        install = apply.atomic_runner_install_sql()
        self.assertTrue(install.startswith("do $sidey_install$"))
        self.assertIn("create or replace function", install)
        self.assertIn("revoke all on function", install)

    def test_atomic_runner_rejects_concurrent_or_multi_transaction_files(self):
        with self.assertRaises(apply.ApplyError):
            apply.atomic_migration_call_sql(
                "begin;\ncreate index concurrently example on t(id);\ncommit;\n",
                "20260921141600", "firebase_index",
            )
        with self.assertRaises(apply.ApplyError):
            apply.atomic_migration_call_sql(
                "begin;\ncommit;\nbegin;\ncommit;\n",
                "20260921141640", "firebase_bad",
            )

    def test_safe_rollout_query_treats_missing_and_json_null_publisher_as_clear(self):
        queries = []
        safe = [
            [{"enabled": False, "direct_events_enabled": False}],
            [{"disabled": True, "owner_clear": True, "deadline_clear": True,
              "edge_clear": True, "publisher_clear": True}],
            [{"wake_clear": True}],
            [{"shadow_users": 0, "live_users": 0, "live_rooms": 0}],
        ]

        def capture(sql):
            queries.append(sql)
            return safe[len(queries) - 1]

        with mock.patch.object(apply, "query", side_effect=capture):
            apply.verify_safe_rollout_state()
        self.assertIn("to_jsonb(config)->>'publisher_url'", queries[1])
        self.assertNotIn("to_jsonb(config)->'publisher_url'", queries[1])

    def test_concurrent_index_history_insert_is_idempotent_and_exact(self):
        version = "20260921141600"
        name = "firebase_production_sequence_index"
        calls = []

        def query(sql):
            calls.append(sql)
            return [{"version": version, "name": name}]

        with mock.patch.object(apply, "execute_statement") as execute, \
                mock.patch.object(apply, "query", side_effect=query):
            apply.record_concurrent_index_history(version, name)
        insert_sql = execute.call_args.args[0]
        self.assertIn("on conflict (version) do nothing", insert_sql)
        self.assertIn(version, insert_sql)
        self.assertEqual(len(calls), 1)

        with mock.patch.object(apply, "execute_statement") as execute, \
                mock.patch.object(apply, "query", return_value=[
                    {"version": version, "name": "wrong"}
                ]):
            with self.assertRaises(apply.ApplyError):
                apply.record_concurrent_index_history(version, name)
        execute.assert_called_once()

    def test_concurrent_index_runner_has_server_and_process_bounds(self):
        sql = apply.validate_concurrent_statement(
            apply.CONCURRENT_CREATE_SQL
        )
        self.assertIn("create unique index concurrently", sql)
        with self.assertRaises(apply.ApplyError):
            apply.validate_concurrent_statement("drop table public.messages")

        queries = []
        schedule_count = 0

        def query(statement):
            nonlocal schedule_count
            queries.append(statement)
            if "cron.schedule(" in statement:
                schedule_count += 1
                return [{"jobid": 10 + schedule_count}]
            if "cron.job_run_details" in statement:
                return [{"status": "succeeded", "return_message": "CREATE INDEX"}]
            return []

        with mock.patch.object(apply, "query", side_effect=query), \
                mock.patch.object(apply, "execute_statement") as execute:
            apply.execute_concurrent_statement(sql)
        rendered = "\n".join(queries)
        self.assertIn("pg_cancel_backend", rendered)
        watchdog = apply.concurrent_watchdog_sql(sql)
        self.assertIn("interval '5 seconds'", watchdog)
        self.assertIn("interval '600 seconds'", watchdog)
        self.assertNotIn("PGOPTIONS", rendered)
        self.assertEqual(execute.call_count, 2)

    def test_concurrent_resume_cleans_stale_jobs_before_valid_early_return(self):
        valid = [{
            "indisvalid": True,
            "indisready": True,
            "definition": (
                "CREATE UNIQUE INDEX messages_room_sequence_unique ON public.messages "
                "USING btree (room_id, sequence)"
            ),
        }]
        with mock.patch.object(apply, "cleanup_concurrent_jobs") as cleanup, \
                mock.patch.object(apply, "query", return_value=valid), \
                mock.patch.object(apply, "execute_concurrent_statement") as execute:
            apply.ensure_concurrent_message_index()
        self.assertEqual(
            cleanup.call_args_list,
            [mock.call(apply.CONCURRENT_CREATE_SQL), mock.call(apply.CONCURRENT_DROP_SQL)],
        )
        execute.assert_not_called()

    def test_concurrent_second_schedule_error_still_cleans_watchdog(self):
        calls = 0

        def query(statement):
            nonlocal calls
            calls += 1
            if calls == 1:
                return [{"jobid": 10}]
            raise apply.ApplyError("schedule unavailable")

        with mock.patch.object(apply, "cleanup_concurrent_jobs") as cleanup, \
                mock.patch.object(apply, "query", side_effect=query):
            with self.assertRaises(apply.ApplyError):
                apply.execute_concurrent_statement(apply.CONCURRENT_CREATE_SQL)
        self.assertEqual(
            cleanup.call_args_list,
            [
                mock.call(apply.CONCURRENT_CREATE_SQL),
                mock.call(apply.CONCURRENT_CREATE_SQL),
            ],
        )

    def test_unknown_history_refuses_before_atomic_runner_cleanup(self):
        manifest = {
            "productionCurrent": [migration("20260101000000")],
            "firebaseHistoricalRepairAllowlist": [],
            "firebaseCompatibilityCandidates": [],
        }
        plan = {"phaseMigrations": [
            {**migration(apply.PREPARE_VERSION), "filename": "prepare.sql"},
            {**migration(apply.CONCURRENT_INDEX_VERSION), "filename": "index.sql"},
        ]}
        args = Namespace(
            execute_production=True,
            project_ref=apply.PROJECT_REF,
            batch_rooms=25,
        )
        with mock.patch.object(apply, "require_pinned_cli"), \
                mock.patch.object(apply, "load_contract", return_value=(manifest, plan)), \
                mock.patch.object(apply, "remote_history", return_value=[
                    migration("20990101000000")
                ]), \
                mock.patch.object(apply, "cleanup_atomic_runner") as cleanup:
            with self.assertRaises(apply.ApplyError):
                apply.apply(args)
        cleanup.assert_not_called()

    def test_prefix13_schema_drift_refuses_before_every_remote_mutation(self):
        base = [migration("20260101000000")]
        phases = [
            {
                **migration(str(20260921140000 + index * 100)),
                "filename": f"phase_{index}.sql",
            }
            for index in range(14)
        ]
        manifest = {
            "productionCurrent": base,
            "firebaseHistoricalRepairAllowlist": [],
            "firebaseCompatibilityCandidates": [],
        }
        plan = {
            "phaseMigrations": phases,
            "prefix13Schema": {"phaseCount": 13},
            "prefix16Schema": {"phaseCount": 16},
            "prefix16IndexSchema": {"phaseCount": 16},
        }
        current = sorted(
            base + apply.entries(phases[:13]), key=lambda item: item["version"]
        )
        args = Namespace(
            execute_production=True,
            project_ref=apply.PROJECT_REF,
            batch_rooms=25,
        )
        with (
            mock.patch.object(apply, "require_pinned_cli"),
            mock.patch.object(apply, "load_contract", return_value=(manifest, plan)),
            mock.patch.object(apply, "remote_history", return_value=current),
            mock.patch.object(
                apply, "verify_schema", side_effect=apply.ApplyError("prefix13 drift")
            ) as verify,
            mock.patch.object(apply, "verify_safe_rollout_state") as rollout,
            mock.patch.object(apply, "commerce_critical_snapshot") as commerce,
            mock.patch.object(apply, "cleanup_atomic_runner") as cleanup,
            mock.patch.object(apply, "ensure_atomic_runner") as ensure,
            mock.patch.object(apply, "apply_atomic_migration") as migrate,
            mock.patch.object(apply, "execute_statement") as execute,
            mock.patch.object(apply, "run") as run,
        ):
            with self.assertRaisesRegex(apply.ApplyError, "prefix13 drift"):
                apply.apply(args)
        verify.assert_called_once_with(plan, "prefix13Schema")
        rollout.assert_not_called()
        commerce.assert_not_called()
        cleanup.assert_not_called()
        ensure.assert_not_called()
        migrate.assert_not_called()
        execute.assert_not_called()
        run.assert_not_called()

    def test_resume_checkpoints_accept_only_clean_or_exact_helper_hash(self):
        with (
            mock.patch.object(apply, "require_private_table_count") as count,
            mock.patch.object(apply, "verify_schema_catalog") as catalog,
        ):
            for schema_key in (
                "prefix13Schema", "prefix16Schema", "prefix16IndexSchema"
            ):
                schema = PLAN[schema_key]
                for expected in (schema["sha256"], schema["atomicRunnerSha256"]):
                    with self.subTest(schema=schema_key, expected=expected), \
                            mock.patch.object(
                                apply, "remote_schema_sha256", return_value=expected
                            ):
                        apply.verify_schema(PLAN, schema_key)
                with mock.patch.object(
                    apply, "remote_schema_sha256", return_value="0" * 64
                ):
                    with self.assertRaisesRegex(
                        apply.ApplyError, "fingerprint mismatch"
                    ):
                        apply.verify_schema(PLAN, schema_key)
            schema = PLAN["prefix17Schema"]
            with mock.patch.object(
                apply, "remote_schema_sha256", return_value=schema["sha256"]
            ):
                apply.verify_schema(PLAN, "prefix17Schema")
            with mock.patch.object(
                apply, "remote_schema_sha256", return_value="0" * 64
            ):
                with self.assertRaisesRegex(apply.ApplyError, "fingerprint mismatch"):
                    apply.verify_schema(PLAN, "prefix17Schema")
        self.assertEqual(count.call_count, 11)
        self.assertEqual(catalog.call_count, 11)

    def test_prefix16_resume_accepts_only_absent_or_exact_index_variants(self):
        expected = (
            PLAN["prefix16Schema"]["sha256"],
            PLAN["prefix16Schema"]["atomicRunnerSha256"],
            PLAN["prefix16IndexSchema"]["sha256"],
            PLAN["prefix16IndexSchema"]["atomicRunnerSha256"],
        )
        with (
            mock.patch.object(apply, "require_private_table_count"),
            mock.patch.object(apply, "verify_schema_catalog"),
        ):
            for fingerprint in expected:
                with self.subTest(fingerprint=fingerprint), mock.patch.object(
                    apply, "remote_schema_sha256", return_value=fingerprint
                ):
                    matched = apply.verify_schema_variants(
                        PLAN, ("prefix16Schema", "prefix16IndexSchema")
                    )
                    self.assertIn(matched, {"prefix16Schema", "prefix16IndexSchema"})
            with mock.patch.object(
                apply, "remote_schema_sha256", return_value="0" * 64
            ):
                with self.assertRaisesRegex(
                    apply.ApplyError, "resume schema fingerprint mismatch"
                ):
                    apply.verify_schema_variants(
                        PLAN, ("prefix16Schema", "prefix16IndexSchema")
                    )

    def test_prefix16_schema_drift_refuses_before_every_remote_mutation(self):
        base = [migration("20260101000000")]
        phases = [
            {
                **migration(str(20260921140000 + index * 100)),
                "filename": f"phase_{index}.sql",
            }
            for index in range(17)
        ]
        manifest = {
            "productionCurrent": base,
            "firebaseHistoricalRepairAllowlist": [],
            "firebaseCompatibilityCandidates": [],
        }
        plan = {
            "phaseMigrations": phases,
            "prefix13Schema": {"phaseCount": 13},
            "prefix16Schema": {"phaseCount": 16},
            "prefix16IndexSchema": {"phaseCount": 16},
        }
        current = sorted(
            base + apply.entries(phases[:16]), key=lambda item: item["version"]
        )
        args = Namespace(
            execute_production=True,
            project_ref=apply.PROJECT_REF,
            batch_rooms=25,
        )
        with (
            mock.patch.object(apply, "require_pinned_cli"),
            mock.patch.object(apply, "load_contract", return_value=(manifest, plan)),
            mock.patch.object(apply, "remote_history", return_value=current),
            mock.patch.object(
                apply,
                "verify_schema_variants",
                side_effect=apply.ApplyError("prefix16 drift"),
            ) as verify,
            mock.patch.object(apply, "verify_safe_rollout_state") as rollout,
            mock.patch.object(apply, "commerce_critical_snapshot") as commerce,
            mock.patch.object(apply, "cleanup_atomic_runner") as cleanup,
            mock.patch.object(apply, "ensure_atomic_runner") as ensure,
            mock.patch.object(apply, "apply_atomic_migration") as migrate,
            mock.patch.object(apply, "execute_statement") as execute,
            mock.patch.object(apply, "run") as run,
        ):
            with self.assertRaisesRegex(apply.ApplyError, "prefix16 drift"):
                apply.apply(args)
        verify.assert_called_once_with(
            plan, ("prefix16Schema", "prefix16IndexSchema")
        )
        rollout.assert_not_called()
        commerce.assert_not_called()
        cleanup.assert_not_called()
        ensure.assert_not_called()
        migrate.assert_not_called()
        execute.assert_not_called()
        run.assert_not_called()

    def test_prefix17_schema_drift_refuses_before_every_remote_mutation(self):
        base = [migration("20260101000000")]
        phases = [
            {
                **migration(str(20260921140000 + index * 100)),
                "filename": f"phase_{index}.sql",
            }
            for index in range(18)
        ]
        manifest = {
            "productionCurrent": base,
            "firebaseHistoricalRepairAllowlist": [],
            "firebaseCompatibilityCandidates": [],
        }
        plan = {
            "phaseMigrations": phases,
            "prefix13Schema": {"phaseCount": 13},
            "prefix16Schema": {"phaseCount": 16},
            "prefix16IndexSchema": {"phaseCount": 16},
            "prefix17Schema": {"phaseCount": 17},
        }
        current = sorted(
            base + apply.entries(phases[:17]), key=lambda item: item["version"]
        )
        args = Namespace(
            execute_production=True,
            project_ref=apply.PROJECT_REF,
            batch_rooms=25,
        )
        with (
            mock.patch.object(apply, "require_pinned_cli"),
            mock.patch.object(apply, "load_contract", return_value=(manifest, plan)),
            mock.patch.object(apply, "remote_history", return_value=current),
            mock.patch.object(
                apply, "verify_schema", side_effect=apply.ApplyError("prefix17 drift")
            ) as verify,
            mock.patch.object(apply, "verify_safe_rollout_state") as rollout,
            mock.patch.object(apply, "commerce_critical_snapshot") as commerce,
            mock.patch.object(apply, "cleanup_atomic_runner") as cleanup,
            mock.patch.object(apply, "ensure_atomic_runner") as ensure,
            mock.patch.object(apply, "apply_atomic_migration") as migrate,
            mock.patch.object(apply, "execute_statement") as execute,
            mock.patch.object(apply, "run") as run,
        ):
            with self.assertRaisesRegex(apply.ApplyError, "prefix17 drift"):
                apply.apply(args)
        verify.assert_called_once_with(plan, "prefix17Schema")
        rollout.assert_not_called()
        commerce.assert_not_called()
        cleanup.assert_not_called()
        ensure.assert_not_called()
        migrate.assert_not_called()
        execute.assert_not_called()
        run.assert_not_called()

    def test_resume_checkpoint_unsafe_rollout_refuses_before_cleanup_or_ddl(self):
        base = [migration("20260101000000")]
        phases = [
            {
                **migration(str(20260921140000 + index * 100)),
                "filename": f"phase_{index}.sql",
            }
            for index in range(18)
        ]
        manifest = {
            "productionCurrent": base,
            "firebaseHistoricalRepairAllowlist": [],
            "firebaseCompatibilityCandidates": [],
        }
        plan = {
            "phaseMigrations": phases,
            "prefix13Schema": {"phaseCount": 13},
            "prefix16Schema": {"phaseCount": 16},
            "prefix16IndexSchema": {"phaseCount": 16},
            "prefix17Schema": {"phaseCount": 17},
        }
        args = Namespace(
            execute_production=True,
            project_ref=apply.PROJECT_REF,
            batch_rooms=25,
        )
        for resume_count in (13, 16, 17):
            current = sorted(
                base + apply.entries(phases[:resume_count]),
                key=lambda item: item["version"],
            )
            for config in (
                {"enabled": True, "direct_events_enabled": False},
                {"enabled": False, "direct_events_enabled": True},
            ):
                with self.subTest(resume_count=resume_count, config=config):
                    schema_key = f"prefix{resume_count}Schema"
                    with (
                        mock.patch.object(apply, "require_pinned_cli"),
                        mock.patch.object(
                            apply, "load_contract", return_value=(manifest, plan)
                        ),
                        mock.patch.object(
                            apply, "remote_history", return_value=current
                        ),
                        mock.patch.object(apply, "verify_schema") as verify,
                        mock.patch.object(
                            apply, "verify_schema_variants"
                        ) as verify_variants,
                        mock.patch.object(
                            apply, "verify_sequence_backfill_complete"
                        ) as sequence_complete,
                        mock.patch.object(
                            apply, "query", return_value=[config]
                        ) as query,
                        mock.patch.object(
                            apply, "commerce_critical_snapshot"
                        ) as commerce,
                        mock.patch.object(
                            apply, "cleanup_atomic_runner"
                        ) as cleanup,
                        mock.patch.object(apply, "ensure_atomic_runner") as ensure,
                        mock.patch.object(
                            apply, "apply_atomic_migration"
                        ) as migrate,
                        mock.patch.object(apply, "execute_statement") as execute,
                        mock.patch.object(apply, "run") as run,
                    ):
                        with self.assertRaisesRegex(
                            apply.ApplyError, "not safely OFF"
                        ):
                            apply.apply(args)
                    if resume_count in (13, 17):
                        verify.assert_called_once_with(plan, schema_key)
                        verify_variants.assert_not_called()
                    else:
                        verify.assert_not_called()
                        verify_variants.assert_called_once_with(
                            plan, ("prefix16Schema", "prefix16IndexSchema")
                        )
                    if resume_count == 17:
                        sequence_complete.assert_called_once_with()
                    else:
                        sequence_complete.assert_not_called()
                    query.assert_called_once()
                    commerce.assert_not_called()
                    cleanup.assert_not_called()
                    ensure.assert_not_called()
                    migrate.assert_not_called()
                    execute.assert_not_called()
                    run.assert_not_called()

    def test_query_timeout_is_explicit_and_scoped(self):
        with (
            mock.patch.object(
                apply.pathlib.Path, "read_text", return_value=apply.PROJECT_REF
            ),
            mock.patch.object(
                apply, "run", return_value='{"rows": [{"ok": true}]}'
            ) as run,
        ):
            self.assertEqual(apply.query("select true as ok"), [{"ok": True}])
            self.assertEqual(
                apply.query("select true as ok", timeout_seconds=660),
                [{"ok": True}],
            )
        self.assertEqual(run.call_args_list[0].kwargs["timeout_seconds"], 90)
        self.assertEqual(run.call_args_list[1].kwargs["timeout_seconds"], 660)

    def test_backfill_timeout_after_commit_resumes_only_remaining_rooms(self):
        calls = 0

        def query(_sql, *, timeout_seconds):
            nonlocal calls
            calls += 1
            self.assertEqual(timeout_seconds, 660)
            if calls == 1:
                # The server committed one bounded batch but the client lost
                # the response. A later invocation must safely continue.
                raise apply.CommandTimeoutError("ambiguous committed batch")
            return [{
                "room_count": 1,
                "message_count": 2,
                "remaining_rooms": 0,
            }]

        with mock.patch.object(apply, "query", side_effect=query):
            with self.assertRaisesRegex(
                apply.CommandTimeoutError, "ambiguous committed batch"
            ):
                apply.backfill_sequences(25)
            apply.backfill_sequences(25)
        self.assertEqual(calls, 2)

    def test_prefix17_requires_complete_sequence_backfill(self):
        complete = [{
            "null_sequences": 0,
            "invalid_sequences": 0,
            "remaining_rooms": 0,
        }]
        with mock.patch.object(apply, "query", return_value=complete):
            apply.verify_sequence_backfill_complete()
        for rows in (
            [{**complete[0], "null_sequences": 1, "remaining_rooms": 1}],
            [{**complete[0], "invalid_sequences": 1}],
            [],
        ):
            with self.subTest(rows=rows), mock.patch.object(
                apply, "query", return_value=rows
            ):
                with self.assertRaisesRegex(apply.ApplyError, "incomplete"):
                    apply.verify_sequence_backfill_complete()

    def test_full_apply_reenters_after_index_create_response_loss(self):
        base = apply.entries(MANIFEST["productionCurrent"])
        phases = apply.entries(PLAN["phaseMigrations"])
        current16 = sorted(base + phases[:16], key=lambda item: item["version"])
        current17 = sorted(base + phases[:17], key=lambda item: item["version"])
        args = Namespace(
            execute_production=True,
            project_ref=apply.PROJECT_REF,
            batch_rooms=25,
        )
        stop = apply.ApplyError("stop after recovered index boundary")
        valid_index = [{
            "indisvalid": True,
            "indisready": True,
            "definition": (
                "CREATE UNIQUE INDEX messages_room_sequence_unique ON "
                "public.messages USING btree (room_id, sequence)"
            ),
        }]
        with (
            mock.patch.object(apply, "require_pinned_cli"),
            mock.patch.object(apply, "load_contract", return_value=(MANIFEST, PLAN)),
            mock.patch.object(
                apply, "remote_history", side_effect=[current16, current17]
            ),
            mock.patch.object(
                apply,
                "verify_schema_variants",
                return_value="prefix16IndexSchema",
            ) as verify_variants,
            mock.patch.object(apply, "verify_safe_rollout_state"),
            mock.patch.object(
                apply, "commerce_critical_snapshot", return_value=commerce_snapshot()
            ),
            mock.patch.object(apply, "cleanup_atomic_runner"),
            mock.patch.object(apply, "backfill_sequences") as backfill,
            mock.patch.object(
                apply,
                "ensure_concurrent_message_index",
                wraps=apply.ensure_concurrent_message_index,
            ) as ensure,
            mock.patch.object(apply, "cleanup_concurrent_jobs") as cleanup_jobs,
            mock.patch.object(apply, "query", return_value=valid_index) as query,
            mock.patch.object(apply, "record_concurrent_index_history") as record,
            mock.patch.object(
                apply, "apply_atomic_migration", side_effect=stop
            ) as migrate,
            mock.patch.object(apply, "execute_concurrent_statement") as concurrent,
        ):
            with self.assertRaisesRegex(
                apply.ApplyError, "stop after recovered index boundary"
            ):
                apply.apply(args)
        verify_variants.assert_called_once_with(
            PLAN, ("prefix16Schema", "prefix16IndexSchema")
        )
        backfill.assert_called_once_with(25)
        ensure.assert_called_once_with()
        self.assertEqual(
            cleanup_jobs.call_args_list,
            [
                mock.call(apply.CONCURRENT_CREATE_SQL),
                mock.call(apply.CONCURRENT_DROP_SQL),
            ],
        )
        query.assert_called_once()
        record.assert_called_once_with(
            apply.CONCURRENT_INDEX_VERSION,
            PLAN["phaseMigrations"][16]["name"],
        )
        concurrent.assert_not_called()
        self.assertEqual(migrate.call_count, 1)
        self.assertEqual(migrate.call_args.args[1], PLAN["phaseMigrations"][17]["version"])

    def test_full_apply_reenters_after_index_history_response_loss(self):
        base = apply.entries(MANIFEST["productionCurrent"])
        phases = apply.entries(PLAN["phaseMigrations"])
        current17 = sorted(base + phases[:17], key=lambda item: item["version"])
        args = Namespace(
            execute_production=True,
            project_ref=apply.PROJECT_REF,
            batch_rooms=25,
        )
        stop = apply.ApplyError("stop after committed index history")
        with (
            mock.patch.object(apply, "require_pinned_cli"),
            mock.patch.object(apply, "load_contract", return_value=(MANIFEST, PLAN)),
            mock.patch.object(apply, "remote_history", return_value=current17),
            mock.patch.object(apply, "verify_schema") as verify,
            mock.patch.object(
                apply, "verify_sequence_backfill_complete"
            ) as sequence_complete,
            mock.patch.object(apply, "verify_safe_rollout_state"),
            mock.patch.object(
                apply, "commerce_critical_snapshot", return_value=commerce_snapshot()
            ),
            mock.patch.object(apply, "cleanup_atomic_runner"),
            mock.patch.object(apply, "backfill_sequences") as backfill,
            mock.patch.object(apply, "ensure_concurrent_message_index") as ensure,
            mock.patch.object(apply, "record_concurrent_index_history") as record,
            mock.patch.object(
                apply, "apply_atomic_migration", side_effect=stop
            ) as migrate,
            mock.patch.object(apply, "execute_concurrent_statement") as concurrent,
        ):
            with self.assertRaisesRegex(
                apply.ApplyError, "stop after committed index history"
            ):
                apply.apply(args)
        verify.assert_called_once_with(PLAN, "prefix17Schema")
        sequence_complete.assert_called_once_with()
        backfill.assert_not_called()
        ensure.assert_not_called()
        record.assert_not_called()
        concurrent.assert_not_called()
        self.assertEqual(migrate.call_count, 1)
        self.assertEqual(migrate.call_args.args[1], PLAN["phaseMigrations"][17]["version"])

    def test_atomic_runner_cleanup_requires_exact_inventory(self):
        exact = [{
            "owner": "postgres",
            "prosecdef": True,
            "provolatile": "v",
            "prokind": "f",
            "proconfig": ["search_path=\"\""],
            "prosrc": apply.ATOMIC_RUNNER_BODY,
            "public_execute": False,
            "anon_execute": False,
            "authenticated_execute": False,
            "service_role_execute": False,
        }]
        with mock.patch.object(apply, "query", return_value=exact), \
                mock.patch.object(apply, "drop_atomic_runner") as drop:
            apply.cleanup_atomic_runner()
        drop.assert_called_once()

        drifted = [{**exact[0], "owner": "service_role"}]
        with mock.patch.object(apply, "query", return_value=drifted), \
                mock.patch.object(apply, "drop_atomic_runner") as drop:
            with self.assertRaises(apply.ApplyError):
                apply.cleanup_atomic_runner()
        drop.assert_not_called()

    def test_schema_canonicalizer_accepts_only_two_exact_constraint_variants(self):
        schema = PLAN["baseSchema"]
        first = apply.canonicalize_schema_dump(
            synthetic_schema(variant_index=0, top_blank_count=5), schema
        )
        second = apply.canonicalize_schema_dump(
            synthetic_schema(variant_index=1, top_blank_count=2), schema
        )
        self.assertEqual(first, second)

        mutated = synthetic_schema().replace(b">= 1", b">= 2", 1)
        with self.assertRaisesRegex(apply.ApplyError, "unapproved"):
            apply.canonicalize_schema_dump(mutated, schema)

        duplicate = synthetic_schema() + schema["constraintCatalog"][0][
            "dumpVariants"
        ][0].encode() + b"\n"
        with self.assertRaisesRegex(apply.ApplyError, "exactly one"):
            apply.canonicalize_schema_dump(duplicate, schema)

        missing = synthetic_schema().replace(
            schema["constraintCatalog"][1]["dumpVariants"][0].encode(), b"", 1
        )
        with self.assertRaisesRegex(apply.ApplyError, "exactly one"):
            apply.canonicalize_schema_dump(missing, schema)

    def test_schema_canonicalizer_preserves_body_comments_strings_and_crlf(self):
        canonical = apply.canonicalize_schema_dump(
            synthetic_schema(), PLAN["baseSchema"]
        )
        self.assertIn(
            b"$fn$\r\nBEGIN\r\n\r\n  RETURN 'body';\r\nEND;\r\n$fn$",
            canonical,
        )
        self.assertIn(b"SELECT 'single\n\nquoted';", canonical)
        self.assertIn(b"/* block\n\ncomment */", canonical)
        self.assertNotIn(b"\n\n\n", canonical.split(b"$fn$", 1)[0])

    def test_schema_canonicalizer_does_not_hide_acl_or_policy_changes(self):
        schema = PLAN["baseSchema"]
        original = apply.canonicalize_schema_dump(synthetic_schema(), schema)
        acl = apply.canonicalize_schema_dump(
            synthetic_schema().replace(b"GRANT SELECT", b"GRANT ALL"), schema
        )
        policy = apply.canonicalize_schema_dump(
            synthetic_schema().replace(b"USING (true)", b"USING (false)"), schema
        )
        digests = {hashlib.sha256(value).hexdigest() for value in (original, acl, policy)}
        self.assertEqual(len(digests), 3)

    def test_schema_catalog_and_auth_enum_are_exact_readback_gates(self):
        schema = PLAN["baseSchema"]
        catalog = [
            {
                "schema_name": item["schema"],
                "table_name": item["table"],
                "name": item["name"],
                "type": item["type"],
                "validated": item["validated"],
                "deferrable": item["deferrable"],
                "deferred": item["deferred"],
                "no_inherit": item["noInherit"],
                "definition": item["definition"],
            }
            for item in schema["constraintCatalog"]
        ]
        enum = [{"label": label} for label in schema["authFactorType"]]
        with mock.patch.object(apply, "query", side_effect=[catalog, enum]):
            apply.verify_schema_catalog(schema)

        wrong_enum = enum.copy()
        wrong_enum[1], wrong_enum[2] = wrong_enum[2], wrong_enum[1]
        with mock.patch.object(apply, "query", side_effect=[catalog, wrong_enum]):
            with self.assertRaisesRegex(apply.ApplyError, "enum order drift"):
                apply.verify_schema_catalog(schema)

    def test_realtime_partition_rotation_has_one_stable_app_fingerprint(self):
        first = realtime_snapshot(datetime.date(2026, 9, 18), "legacy")
        first["utcToday"] = "2026-09-21"
        second = realtime_snapshot(datetime.date(2026, 9, 19), "mixed")
        stable_first, stable_hash = stable_contract_and_hash(first)
        stable_second = apply.validate_realtime_contract_snapshot(second, stable_hash)
        self.assertEqual(stable_first, stable_second)
        app = apply.canonicalize_schema_dump(
            synthetic_schema(), PLAN["baseSchema"]
        )
        self.assertEqual(
            apply.schema_fingerprint(app, stable_first),
            apply.schema_fingerprint(app, stable_second),
        )

    def test_realtime_partition_inventory_rejects_every_structural_drift(self):
        base = realtime_snapshot()
        _, stable_hash = stable_contract_and_hash(base)
        cases = {}

        value = copy.deepcopy(base); value["children"].pop(); cases["six"] = value
        value = copy.deepcopy(base); value["children"].append(copy.deepcopy(value["children"][-1])); cases["eight"] = value
        value = copy.deepcopy(base); value["children"].pop(3); value["children"].append(realtime_snapshot(datetime.date(2026, 9, 26), "modern")["children"][0]); cases["gap"] = value
        value = copy.deepcopy(base); value["children"][3]["name"] = "messages_2026_09_29"; cases["name"] = value
        value = copy.deepcopy(base); value["children"][3]["bound"] = value["children"][2]["bound"]; cases["overlap"] = value
        value = copy.deepcopy(base); value["children"][3]["bound"] = "FOR VALUES FROM ('2026-09-23 01:00:00') TO ('2026-09-24 00:00:00')"; cases["bound"] = value
        value = copy.deepcopy(base); value["children"][3]["isPartition"] = False; cases["detached"] = value
        value = copy.deepcopy(base); value["children"][3]["owner"] = "postgres"; cases["owner"] = value
        value = copy.deepcopy(base); value["children"][3]["columns"][0]["default"] = "'x'::text"; cases["column"] = value
        value = copy.deepcopy(base); value["children"][3]["indexes"][1]["valid"] = False; cases["invalid-pk"] = value
        value = copy.deepcopy(base); value["children"][3]["indexes"][0]["ready"] = False; cases["invalid-index"] = value
        value = copy.deepcopy(base); value["children"][3]["indexes"][0]["definition"] = value["children"][3]["indexes"][0]["definition"].replace("private IS TRUE", "private IS FALSE"); cases["predicate"] = value
        value = copy.deepcopy(base); value["children"][3]["indexes"][0]["parentIndex"] = None; cases["index-detached"] = value
        value = copy.deepcopy(base); value["children"][3]["indexes"][1]["parentIndex"] = None; cases["pk-detached"] = value
        value = copy.deepcopy(base); value["children"][3]["acl"].append({"grantee": "authenticated", "privilege": "SELECT", "grantable": False}); cases["acl-grantee"] = value
        value = copy.deepcopy(base); value["children"][3]["acl"].pop(); cases["acl-missing"] = value
        for name, snapshot in cases.items():
            with self.subTest(name=name):
                with self.assertRaises(apply.ApplyError):
                    apply.validate_realtime_contract_snapshot(snapshot, stable_hash)

    def test_realtime_parent_policy_routine_and_acl_drift_fail_closed(self):
        base = realtime_snapshot()
        _, stable_hash = stable_contract_and_hash(base)
        cases = {}
        value = copy.deepcopy(base); value["parent"]["rls"] = False; cases["rls"] = value
        value = copy.deepcopy(base); value["parent"]["columns"][0]["notNull"] = False; cases["column"] = value
        value = copy.deepcopy(base); value["parent"]["acl"].pop(); cases["customer-acl"] = value
        value = copy.deepcopy(base); value["policies"][0]["withCheck"] += " "; cases["policy-token"] = value
        value = copy.deepcopy(base); value["policies"].pop(); cases["policy-missing"] = value
        value = copy.deepcopy(base); value["policies"].append(copy.deepcopy(value["policies"][0])); cases["policy-extra"] = value
        value = copy.deepcopy(base); value["routines"][0]["signature"] = "realtime.send(jsonb,text,text,boolean)"; cases["signature"] = value
        value = copy.deepcopy(base); value["routines"][1]["volatility"] = "v"; cases["routine-property"] = value
        value = copy.deepcopy(base); value["routines"][1]["execute"].pop(); cases["execute"] = value
        for name, snapshot in cases.items():
            with self.subTest(name=name):
                with self.assertRaises(apply.ApplyError):
                    apply.validate_realtime_contract_snapshot(snapshot, stable_hash)

    def test_realtime_postgres_acl_accepts_only_legacy_or_modern(self):
        for mode in ("legacy", "modern", "mixed"):
            with self.subTest(mode=mode):
                stable_contract_and_hash(realtime_snapshot(postgres_mode=mode))
        base = realtime_snapshot()
        mutations = []
        value = copy.deepcopy(base); value["parent"]["acl"].pop(); mutations.append(value)
        value = copy.deepcopy(base); value["parent"]["acl"].append({"grantee": "postgres", "privilege": "SELECT", "grantable": False}); mutations.append(value)
        value = copy.deepcopy(base); value["children"][0]["acl"].append({"grantee": "postgres", "privilege": "CONNECT", "grantable": False}); mutations.append(value)
        for snapshot in mutations:
            with self.assertRaises(apply.ApplyError):
                apply.validate_realtime_contract_snapshot(snapshot, None)

    def test_realtime_contract_is_one_query_snapshot(self):
        snapshot = realtime_snapshot()
        _, stable_hash = stable_contract_and_hash(snapshot)
        with mock.patch.object(apply, "query", return_value=[{"contract": snapshot}]) as query:
            apply.realtime_contract_snapshot(stable_hash)
        query.assert_called_once_with(apply.REALTIME_CONTRACT_SQL)
        self.assertEqual(apply.REALTIME_CONTRACT_SQL.lower().count("select ") > 1, True)
        self.assertNotIn(";", apply.REALTIME_CONTRACT_SQL.strip().rstrip(";"))

    def test_remote_schema_uses_the_selected_state_realtime_hash(self):
        schema = PLAN["readySchema"]

        def fake_run(command, **_kwargs):
            pathlib.Path(command[command.index("--file") + 1]).write_bytes(b"schema")
            return ""

        with (
            mock.patch.object(apply, "run", side_effect=fake_run),
            mock.patch.object(apply, "canonicalize_schema_dump", return_value=b"canonical"),
            mock.patch.object(apply, "realtime_contract_snapshot", return_value={"state": "ready"}) as realtime,
            mock.patch.object(apply, "schema_fingerprint", return_value="f" * 64),
        ):
            self.assertEqual(apply.remote_schema_sha256(PLAN, schema), "f" * 64)
        realtime.assert_called_once_with(schema["realtimeContractSha256"])

    def test_app_fingerprint_detects_non_realtime_schema_mutations(self):
        stable, _ = stable_contract_and_hash(realtime_snapshot())
        schema = PLAN["baseSchema"]
        original = apply.canonicalize_schema_dump(
            synthetic_schema() + b"CREATE TYPE auth.factor_type AS ENUM ('totp','webauthn','phone','recovery_code');\n",
            schema,
        )
        mutations = [
            original.replace(b"'recovery_code'", b"'recovery-code'"),
            original.replace(b"RETURN 'body'", b"RETURN 'changed'"),
            original.replace(b"GRANT SELECT", b"GRANT UPDATE"),
        ]
        baseline = apply.schema_fingerprint(original, stable)
        self.assertTrue(all(apply.schema_fingerprint(value, stable) != baseline for value in mutations))


if __name__ == "__main__":
    unittest.main()
