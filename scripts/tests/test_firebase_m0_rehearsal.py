import copy
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT_DIR = ROOT / "scripts" / "supabase"
SCRIPT = SCRIPT_DIR / "firebase_m0_rehearsal.py"
MANIFEST_PATH = SCRIPT_DIR / "firebase-production-history.json"
MIGRATIONS = ROOT / "supabase" / "migrations"

sys.path.insert(0, str(SCRIPT_DIR))
import firebase_m0_rehearsal as rehearsal  # noqa: E402
import firebase_production_history as history  # noqa: E402


PHASE_CONTENT = b"select 'firebase m0 phase';\n"
PHASE_VERSION = "20261001000000"
PHASE_NAME = "firebase_m0_production_phase"
READY_SHA = "a" * 64
PRODUCTION_PLAN = json.loads(
    (SCRIPT_DIR / "firebase-m0-production-plan.json").read_text(encoding="utf-8")
)


def schema_state(object_count, sha256):
    baseline = PRODUCTION_PLAN["baseSchema"]
    return {
        "objectCount": object_count,
        "sha256": sha256,
        "realtimeContractSha256": baseline["realtimeContractSha256"],
        "constraintCatalog": copy.deepcopy(baseline["constraintCatalog"]),
        "authFactorType": list(baseline["authFactorType"]),
    }


def phase_entry(index=0):
    version = str(int(PHASE_VERSION) + index)
    name = f"{PHASE_NAME}_{index:02d}"
    return {
        "version": version,
        "name": name,
        "filename": f"{version}_{name}.sql",
        "sha256": hashlib.sha256(PHASE_CONTENT).hexdigest(),
    }


def make_plan(manifest):
    return {
        "schemaVersion": 1,
        "schemaCanonicalizerVersion": rehearsal.SCHEMA_CANONICALIZER_VERSION,
        "realtimeContractVersion": rehearsal.REALTIME_CONTRACT_VERSION,
        "projectRef": manifest["projectRef"],
        "baseRemoteHistorySha256": rehearsal.canonical_history_sha256(
            manifest["productionCurrent"]
        ),
        "phaseMigrations": [
            phase_entry(index)
            for index in range(rehearsal.PREFIX17_PHASE_COUNT + 1)
        ],
        "baseSchema": schema_state(0, "c" * 64),
        "prefix13Schema": {
            **schema_state(20, "d" * 64),
            "phaseCount": rehearsal.PREFIX13_PHASE_COUNT,
            "atomicRunnerSha256": "e" * 64,
        },
        "prefix16Schema": {
            **schema_state(22, "f" * 64),
            "phaseCount": rehearsal.PREFIX16_PHASE_COUNT,
            "atomicRunnerSha256": "1" * 64,
        },
        "prefix16IndexSchema": {
            **schema_state(22, "2" * 64),
            "phaseCount": rehearsal.PREFIX16_PHASE_COUNT,
            "atomicRunnerSha256": "3" * 64,
        },
        "prefix17Schema": {
            **schema_state(22, "2" * 64),
            "phaseCount": rehearsal.PREFIX17_PHASE_COUNT,
        },
        "readySchema": schema_state(91, READY_SHA),
        "finalSchema": schema_state(93, "b" * 64),
        "historicalRepairVersions": [
            entry["version"] for entry in manifest["firebaseHistoricalRepairAllowlist"]
        ],
        "compatibilityCandidateVersions": [
            entry["version"] for entry in manifest["firebaseCompatibilityCandidates"]
        ],
    }


def remote_payload(entries, project_ref):
    return {
        "projectRef": project_ref,
        "migrations": [
            {"version": entry["version"], "name": entry["name"]}
            for entry in entries
        ],
    }


def dry_run_text(entries):
    lines = ["DRY RUN: migrations will not be pushed to the database."]
    lines.extend(f" • {entry['filename']}" for entry in entries)
    return "\n".join(lines) + "\n"


class FirebaseM0RehearsalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = history.validate_manifest(
            json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        )

    def setUp(self):
        self.raw_plan = make_plan(self.manifest)
        self.plan = rehearsal.validate_phase_plan(self.raw_plan, self.manifest)

    def test_phase_plan_pins_base_history_and_exact_allowlists(self):
        self.assertEqual(
            self.plan["baseRemoteHistorySha256"],
            rehearsal.canonical_history_sha256(self.manifest["productionCurrent"]),
        )
        bad = copy.deepcopy(self.raw_plan)
        bad["historicalRepairVersions"].pop()
        with self.assertRaisesRegex(rehearsal.RehearsalError, "repair allowlist mismatch"):
            rehearsal.validate_phase_plan(bad, self.manifest)

    def test_presence_delivery_phase_claims_realtime_then_rooms_before_auth_ddl(self):
        path = ROOT / "supabase" / "production-migrations" / (
            "20260921141300_firebase_production_presence_inbox_delivery.sql"
        )
        source = path.read_text(encoding="utf-8").lower()
        realtime_lock = "lock table realtime.messages in access exclusive mode;"
        rooms_lock = "lock table public.rooms in access exclusive mode;"
        self.assertEqual(source.count(realtime_lock), 1)
        self.assertEqual(source.count(rooms_lock), 1)
        self.assertLess(source.index(realtime_lock), source.index(rooms_lock))
        self.assertLess(
            source.index(rooms_lock),
            source.index("create function private.can_read_user_presence_topic"),
        )
        self.assertLess(
            source.index(rooms_lock),
            source.index("drop trigger if exists firebase_room_revision_deleted"),
        )

    def test_phase_plan_rejects_pinned_version_collision_and_bad_hash(self):
        bad = copy.deepcopy(self.raw_plan)
        bad["phaseMigrations"][0] = copy.deepcopy(
            self.manifest["firebaseCompatibilityCandidates"][0]
        )
        with self.assertRaisesRegex(rehearsal.RehearsalError, "collides"):
            rehearsal.validate_phase_plan(bad, self.manifest)

        bad = copy.deepcopy(self.raw_plan)
        bad["baseRemoteHistorySha256"] = "0" * 64
        with self.assertRaisesRegex(rehearsal.RehearsalError, "history SHA-256 mismatch"):
            rehearsal.validate_phase_plan(bad, self.manifest)

    def test_phase_plan_rejects_unknown_canonicalizer_or_catalog_drift(self):
        bad = copy.deepcopy(self.raw_plan)
        bad["schemaCanonicalizerVersion"] += 1
        with self.assertRaisesRegex(rehearsal.RehearsalError, "unsupported"):
            rehearsal.validate_phase_plan(bad, self.manifest)

        bad = copy.deepcopy(self.raw_plan)
        bad["realtimeContractVersion"] += 1
        with self.assertRaisesRegex(rehearsal.RehearsalError, "unsupported"):
            rehearsal.validate_phase_plan(bad, self.manifest)

        bad = copy.deepcopy(self.raw_plan)
        bad["readySchema"].pop("realtimeContractSha256")
        with self.assertRaisesRegex(rehearsal.RehearsalError, "exactly"):
            rehearsal.validate_phase_plan(bad, self.manifest)

        bad = copy.deepcopy(self.raw_plan)
        bad["readySchema"]["constraintCatalog"][0]["dumpVariants"].pop()
        with self.assertRaisesRegex(rehearsal.RehearsalError, "two full approved"):
            rehearsal.validate_phase_plan(bad, self.manifest)

        bad = copy.deepcopy(self.raw_plan)
        bad["finalSchema"]["authFactorType"] = ["totp", "phone", "webauthn"]
        with self.assertRaisesRegex(rehearsal.RehearsalError, "exact enum order"):
            rehearsal.validate_phase_plan(bad, self.manifest)

        bad = copy.deepcopy(self.raw_plan)
        bad["prefix13Schema"]["phaseCount"] = 12
        with self.assertRaisesRegex(rehearsal.RehearsalError, "must be 13"):
            rehearsal.validate_phase_plan(bad, self.manifest)

        bad = copy.deepcopy(self.raw_plan)
        bad["prefix13Schema"]["atomicRunnerSha256"] = bad["prefix13Schema"]["sha256"]
        with self.assertRaisesRegex(rehearsal.RehearsalError, "distinct SHA-256"):
            rehearsal.validate_phase_plan(bad, self.manifest)

        bad = copy.deepcopy(self.raw_plan)
        bad["prefix16Schema"]["phaseCount"] = 15
        with self.assertRaisesRegex(rehearsal.RehearsalError, "must be 16"):
            rehearsal.validate_phase_plan(bad, self.manifest)

        bad = copy.deepcopy(self.raw_plan)
        bad["prefix16Schema"]["atomicRunnerSha256"] = bad["prefix16Schema"]["sha256"]
        with self.assertRaisesRegex(rehearsal.RehearsalError, "distinct SHA-256"):
            rehearsal.validate_phase_plan(bad, self.manifest)

        bad = copy.deepcopy(self.raw_plan)
        bad["prefix16IndexSchema"]["phaseCount"] = 17
        with self.assertRaisesRegex(rehearsal.RehearsalError, "must be 16"):
            rehearsal.validate_phase_plan(bad, self.manifest)

        bad = copy.deepcopy(self.raw_plan)
        bad["prefix17Schema"]["phaseCount"] = 16
        with self.assertRaisesRegex(rehearsal.RehearsalError, "must be 17"):
            rehearsal.validate_phase_plan(bad, self.manifest)

    def test_schema_canonicalization_evidence_is_plan_pinned(self):
        production_plan = rehearsal.validate_phase_plan(
            copy.deepcopy(PRODUCTION_PLAN), self.manifest
        )
        evidence = json.loads(
            (SCRIPT_DIR / "fixtures" / "firebase_m0_schema_canonicalization.json")
            .read_text(encoding="utf-8")
        )
        rehearsal.validate_schema_canonicalization_evidence(evidence, production_plan)

        bad = copy.deepcopy(evidence)
        bad["rehearsal"]["ready"]["fingerprintSha256"] = "0" * 64
        with self.assertRaisesRegex(rehearsal.RehearsalError, "ready hash mismatch"):
            rehearsal.validate_schema_canonicalization_evidence(bad, production_plan)

        bad = copy.deepcopy(evidence)
        bad["rehearsal"]["prefix13"]["fingerprintSha256"] = "0" * 64
        with self.assertRaisesRegex(rehearsal.RehearsalError, "prefix13 hash mismatch"):
            rehearsal.validate_schema_canonicalization_evidence(bad, production_plan)

        bad = copy.deepcopy(evidence)
        bad["rehearsal"]["productionPrefix13"]["atomicRunnerExact"] = False
        with self.assertRaisesRegex(rehearsal.RehearsalError, "atomic-runner checkpoint"):
            rehearsal.validate_schema_canonicalization_evidence(bad, production_plan)

        bad = copy.deepcopy(evidence)
        bad["rehearsal"]["productionPrefix16"]["atomicRunnerExact"] = False
        with self.assertRaisesRegex(rehearsal.RehearsalError, "prefix16 atomic-runner"):
            rehearsal.validate_schema_canonicalization_evidence(bad, production_plan)

        bad = copy.deepcopy(evidence)
        bad["rehearsal"]["prefix16IndexHelper"]["atomicRunnerExact"] = False
        with self.assertRaisesRegex(rehearsal.RehearsalError, "index/helper"):
            rehearsal.validate_schema_canonicalization_evidence(bad, production_plan)

        bad = copy.deepcopy(evidence)
        bad["realtimeContract"]["transition"]["changedFields"].append(
            {"path": "parent.rls", "beforeSha256": "0" * 64, "afterSha256": "1" * 64}
        )
        with self.assertRaisesRegex(rehearsal.RehearsalError, "transition mismatch"):
            rehearsal.validate_schema_canonicalization_evidence(bad, production_plan)

        bad = copy.deepcopy(evidence)
        bad["realtimeContract"]["componentHashes"]["parent"] = "0" * 64
        with self.assertRaisesRegex(rehearsal.RehearsalError, "component hashes"):
            rehearsal.validate_schema_canonicalization_evidence(bad, production_plan)

    def test_inventory_accepts_only_exact_empty_or_ready(self):
        empty = {
            "schemaVersion": 1,
            "projectRef": self.manifest["projectRef"],
            "firebaseObjectCount": 0,
            "schemaSha256": None,
        }
        ready = {
            "schemaVersion": 1,
            "projectRef": self.manifest["projectRef"],
            "firebaseObjectCount": 91,
            "schemaSha256": READY_SHA,
        }
        self.assertEqual(rehearsal.classify_inventory(empty, self.plan, "EMPTY"), "EMPTY")
        self.assertEqual(rehearsal.classify_inventory(ready, self.plan, "READY"), "READY")

        partial = {**ready, "firebaseObjectCount": 90}
        with self.assertRaisesRegex(rehearsal.RehearsalError, "PARTIAL/DRIFT"):
            rehearsal.classify_inventory(partial, self.plan, "READY")

    def test_backup_snapshot_allows_live_growth_and_flags_decrease(self):
        before = {
            "database": "postgres",
            "serverVersion": "17.6",
            "migrationHistory": [{"version": "1", "name": "one"}],
            "cronJobs": [{"jobid": 1, "jobname": "one"}],
            **{key: 10 for key in rehearsal.BACKUP_COUNT_KEYS},
        }
        after = copy.deepcopy(before)
        for index, key in enumerate(rehearsal.BACKUP_COUNT_KEYS, start=1):
            after[key] += index
        result = rehearsal.validate_backup_snapshot_delta(before, after)
        self.assertFalse(result["manualReviewRequired"])
        self.assertEqual(result["migrationCount"], 1)
        self.assertEqual(result["cronJobCount"], 1)

        after["messages"] = before["messages"] - 1
        result = rehearsal.validate_backup_snapshot_delta(before, after)
        self.assertTrue(result["manualReviewRequired"])
        self.assertEqual(result["negativeDeltas"], ["messages"])

    def test_backup_snapshot_rejects_history_cron_and_identity_drift(self):
        before = {
            "database": "postgres",
            "serverVersion": "17.6",
            "migrationHistory": [{"version": "1", "name": "one"}],
            "cronJobs": [{"jobid": 1, "jobname": "one"}],
            **{key: 10 for key in rehearsal.BACKUP_COUNT_KEYS},
        }
        mutations = []
        value = copy.deepcopy(before); value["database"] = "other"; mutations.append(value)
        value = copy.deepcopy(before); value["migrationHistory"] = []; mutations.append(value)
        value = copy.deepcopy(before); value["cronJobs"] = []; mutations.append(value)
        for after in mutations:
            with self.assertRaises(rehearsal.RehearsalError):
                rehearsal.validate_backup_snapshot_delta(before, after)

    def test_inventory_expected_state_mismatch_fails_closed(self):
        empty = {
            "schemaVersion": 1,
            "projectRef": self.manifest["projectRef"],
            "firebaseObjectCount": 0,
            "schemaSha256": None,
        }
        with self.assertRaisesRegex(rehearsal.RehearsalError, "expected READY, got EMPTY"):
            rehearsal.classify_inventory(empty, self.plan, "READY")

    def test_empty_remote_history_must_equal_production_current(self):
        remote = rehearsal._expected_remote_history(self.manifest, self.plan, "EMPTY")
        rehearsal.validate_remote_history(remote, self.manifest, self.plan, "EMPTY")
        remote.append({"version": "20990101000000", "name": "unexpected"})
        with self.assertRaisesRegex(rehearsal.RehearsalError, "non-allowlisted"):
            rehearsal.validate_remote_history(remote, self.manifest, self.plan, "EMPTY")

    def test_ready_remote_history_requires_phase_and_exact_repair_allowlist(self):
        remote = rehearsal._expected_remote_history(self.manifest, self.plan, "READY")
        rehearsal.validate_remote_history(remote, self.manifest, self.plan, "READY")
        missing_repair = [
            entry
            for entry in remote
            if entry["version"]
            != self.manifest["firebaseHistoricalRepairAllowlist"][0]["version"]
        ]
        with self.assertRaises(rehearsal.RehearsalError):
            rehearsal.validate_remote_history(
                missing_repair, self.manifest, self.plan, "READY"
            )

    def test_deploy_bundle_is_exact_and_sha_pinned(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = pathlib.Path(directory)
            for entry in self.manifest["productionCurrent"]:
                shutil.copy2(MIGRATIONS / entry["filename"], bundle / entry["filename"])
            for entry in self.plan["phaseMigrations"]:
                (bundle / entry["filename"]).write_bytes(PHASE_CONTENT)
            rehearsal.validate_deploy_bundle(bundle, self.manifest, self.plan)

            forbidden = self.manifest["firebaseHistoricalRepairAllowlist"][0]
            shutil.copy2(MIGRATIONS / forbidden["filename"], bundle / forbidden["filename"])
            with self.assertRaisesRegex(rehearsal.RehearsalError, "allowlist mismatch"):
                rehearsal.validate_deploy_bundle(bundle, self.manifest, self.plan)

    def test_deploy_bundle_rejects_phase_hash_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = pathlib.Path(directory)
            for entry in self.manifest["productionCurrent"]:
                shutil.copy2(MIGRATIONS / entry["filename"], bundle / entry["filename"])
            for entry in self.plan["phaseMigrations"]:
                (bundle / entry["filename"]).write_bytes(PHASE_CONTENT)
            (bundle / phase_entry()["filename"]).write_text("select 'changed';\n")
            with self.assertRaisesRegex(rehearsal.RehearsalError, "SHA-256 mismatch"):
                rehearsal.validate_deploy_bundle(bundle, self.manifest, self.plan)

    def test_empty_dry_run_requires_only_phase_migrations(self):
        text = dry_run_text(self.plan["phaseMigrations"])
        actual = rehearsal.validate_dry_run(text, self.manifest, self.plan, "EMPTY")
        self.assertEqual(
            [entry["version"] for entry in actual],
            [entry["version"] for entry in self.plan["phaseMigrations"]],
        )

        unexpected = text + " • 20260921102516_firebase_production_compatibility.sql\n"
        with self.assertRaisesRegex(rehearsal.RehearsalError, "plan mismatch"):
            rehearsal.validate_dry_run(unexpected, self.manifest, self.plan, "EMPTY")

    def test_ready_dry_run_requires_only_compatibility_candidates_in_order(self):
        entries = self.manifest["firebaseCompatibilityCandidates"]
        rehearsal.validate_dry_run(
            dry_run_text(entries), self.manifest, self.plan, "READY"
        )
        with self.assertRaisesRegex(rehearsal.RehearsalError, "plan mismatch"):
            rehearsal.validate_dry_run(
                dry_run_text(list(reversed(entries))), self.manifest, self.plan, "READY"
            )

    def test_dry_run_rejects_missing_marker_and_mutation_marker(self):
        filename = phase_entry()["filename"]
        with self.assertRaisesRegex(rehearsal.RehearsalError, "DRY RUN marker"):
            rehearsal.parse_dry_run_migrations(filename)
        with self.assertRaisesRegex(rehearsal.RehearsalError, "mutation marker"):
            rehearsal.parse_dry_run_migrations(
                f"DRY RUN\nApplying migration {filename}\n"
            )

    def test_cli_verifies_complete_empty_evidence_without_remote_access(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            bundle = root / "bundle"
            bundle.mkdir()
            for entry in self.manifest["productionCurrent"]:
                shutil.copy2(MIGRATIONS / entry["filename"], bundle / entry["filename"])
            for entry in self.plan["phaseMigrations"]:
                (bundle / entry["filename"]).write_bytes(PHASE_CONTENT)

            plan_path = root / "plan.json"
            inventory_path = root / "inventory.json"
            remote_path = root / "remote.json"
            dry_run_path = root / "dry-run.txt"
            plan_path.write_text(json.dumps(self.raw_plan), encoding="utf-8")
            inventory_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "projectRef": self.manifest["projectRef"],
                        "firebaseObjectCount": 0,
                        "schemaSha256": None,
                    }
                ),
                encoding="utf-8",
            )
            remote_path.write_text(
                json.dumps(
                    remote_payload(
                        self.manifest["productionCurrent"], self.manifest["projectRef"]
                    )
                ),
                encoding="utf-8",
            )
            dry_run_path.write_text(
                dry_run_text(self.plan["phaseMigrations"]), encoding="utf-8"
            )

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--remote-list",
                    str(remote_path),
                    "--schema-inventory",
                    str(inventory_path),
                    "--phase-plan",
                    str(plan_path),
                    "--deploy-bundle-dir",
                    str(bundle),
                    "--dry-run-output",
                    str(dry_run_path),
                    "--expect-state",
                    "EMPTY",
                ],
                capture_output=True,
                text=True,
                cwd=ROOT,
                check=False,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("state=EMPTY", result.stdout)
        self.assertIn("remote=41", result.stdout)
        self.assertNotIn("select", result.stdout)


if __name__ == "__main__":
    unittest.main()
