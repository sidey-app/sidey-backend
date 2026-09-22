import copy
import hashlib
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT_DIR = ROOT / "scripts" / "supabase"
SCRIPT = SCRIPT_DIR / "firebase_production_history.py"
MANIFEST = SCRIPT_DIR / "firebase-production-history.json"
MIGRATIONS = ROOT / "supabase" / "migrations"

sys.path.insert(0, str(SCRIPT_DIR))
import firebase_production_history as history  # noqa: E402


def remote_payload(manifest):
    return {
        "projectRef": manifest["projectRef"],
        "migrations": [
            {"version": entry["version"], "name": entry["name"]}
            for entry in manifest["productionCurrent"]
        ],
    }


class FirebaseProductionHistoryTests(unittest.TestCase):
    def setUp(self):
        self.raw_manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        self.manifest = history.validate_manifest(self.raw_manifest)

    def test_repository_manifest_and_all_pinned_sql_hashes_are_valid(self):
        history.validate_local_files(self.manifest, MIGRATIONS)
        self.assertEqual(len(self.manifest["productionCurrent"]), 41)
        self.assertEqual(len(self.manifest["firebaseHistoricalRepairAllowlist"]), 21)
        self.assertEqual(len(self.manifest["firebaseCompatibilityCandidates"]), 5)

        production_versions = {
            entry["version"] for entry in self.manifest["productionCurrent"]
        }
        repair_versions = {
            entry["version"]
            for entry in self.manifest["firebaseHistoricalRepairAllowlist"]
        }
        compatibility_versions = {
            entry["version"]
            for entry in self.manifest["firebaseCompatibilityCandidates"]
        }
        self.assertTrue(production_versions.isdisjoint(repair_versions))
        self.assertTrue(production_versions.isdisjoint(compatibility_versions))
        self.assertTrue(repair_versions.isdisjoint(compatibility_versions))
        self.assertEqual(
            compatibility_versions,
            {
                "20260921102516",
                "20260921110000",
                "20260921132018",
                "20260921133000",
                "20260921133500",
            },
        )

    def test_exact_remote_history_is_accepted(self):
        remote = history.normalize_remote_list(
            remote_payload(self.manifest), self.manifest["projectRef"]
        )
        history.validate_remote_history(self.manifest, remote)

    def test_remote_name_drift_is_rejected(self):
        payload = remote_payload(self.manifest)
        payload["migrations"][3]["name"] = "renamed_after_the_fact"
        remote = history.normalize_remote_list(payload, self.manifest["projectRef"])
        with self.assertRaisesRegex(history.VerificationError, "mismatch at index 3"):
            history.validate_remote_history(self.manifest, remote)

    def test_remote_extra_migration_is_rejected(self):
        payload = remote_payload(self.manifest)
        payload["migrations"].append(
            {"version": "20990101000000", "name": "unexpected_remote_migration"}
        )
        remote = history.normalize_remote_list(payload, self.manifest["projectRef"])
        with self.assertRaisesRegex(history.VerificationError, "1 unexpected entry"):
            history.validate_remote_history(self.manifest, remote)

    def test_wrong_remote_project_is_rejected(self):
        payload = remote_payload(self.manifest)
        payload["projectRef"] = "fjglrvhvdthntkvrduyi"
        with self.assertRaisesRegex(history.VerificationError, "projectRef mismatch"):
            history.normalize_remote_list(payload, self.manifest["projectRef"])

    def test_manifest_overlap_is_rejected(self):
        manifest = copy.deepcopy(self.raw_manifest)
        manifest["firebaseHistoricalRepairAllowlist"][0] = copy.deepcopy(
            manifest["productionCurrent"][0]
        )
        manifest["firebaseHistoricalRepairAllowlist"].sort(key=lambda entry: entry["version"])
        with self.assertRaisesRegex(history.VerificationError, "appears in both"):
            history.validate_manifest(manifest)

    def test_local_filename_and_hash_are_both_enforced(self):
        content = b"select 1;\n"
        sha256 = hashlib.sha256(content).hexdigest()
        entry = {
            "version": "20260101000000",
            "name": "sample",
            "filename": "20260101000000_sample.sql",
            "sha256": sha256,
        }
        minimal_manifest = {
            "productionCurrent": [entry],
            "firebaseHistoricalRepairAllowlist": [],
            "firebaseCompatibilityCandidates": [],
        }
        with tempfile.TemporaryDirectory() as directory:
            migrations = pathlib.Path(directory)
            wrong_name = migrations / "20260101000000_wrong.sql"
            wrong_name.write_bytes(content)
            with self.assertRaisesRegex(history.VerificationError, "filename mismatch"):
                history.validate_local_files(minimal_manifest, migrations)

            wrong_name.rename(migrations / entry["filename"])
            history.validate_local_files(minimal_manifest, migrations)
            (migrations / entry["filename"]).write_bytes(b"select 2;\n")
            with self.assertRaisesRegex(history.VerificationError, "SHA-256 mismatch"):
                history.validate_local_files(minimal_manifest, migrations)

    def test_cli_accepts_remote_list_from_stdin(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--remote-list", "-"],
            input=json.dumps(remote_payload(self.manifest)),
            capture_output=True,
            text=True,
            cwd=ROOT,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("production=41", result.stdout)
        self.assertIn("repair-allowlist=21", result.stdout)

    def test_cli_rejects_remote_list_file_with_missing_entry(self):
        payload = remote_payload(self.manifest)
        payload["migrations"].pop()
        with tempfile.TemporaryDirectory() as directory:
            remote_file = pathlib.Path(directory) / "remote.json"
            remote_file.write_text(json.dumps(payload), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--remote-list", str(remote_file)],
                capture_output=True,
                text=True,
                cwd=ROOT,
                check=False,
            )
        self.assertEqual(result.returncode, 1)
        self.assertIn("missing 1 entry", result.stderr)

    def test_invalid_json_is_reported_as_verification_error(self):
        with self.assertRaisesRegex(history.VerificationError, "could not read JSON"):
            history.load_json("-", io.StringIO("not-json"))


if __name__ == "__main__":
    unittest.main()
