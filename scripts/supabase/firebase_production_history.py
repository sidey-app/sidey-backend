#!/usr/bin/env python3
"""Verify the pinned SIDEY production migration history without remote writes."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import sys
from typing import Any, TextIO


ROOT = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = pathlib.Path(__file__).with_name("firebase-production-history.json")
DEFAULT_MIGRATIONS = ROOT / "supabase" / "migrations"

ENTRY_KEYS = ("version", "name", "filename", "sha256")
MANIFEST_GROUPS = (
    "productionCurrent",
    "firebaseHistoricalRepairAllowlist",
    "firebaseCompatibilityCandidates",
)
EXPECTED_COUNTS = {
    "productionCurrent": 41,
    "firebaseHistoricalRepairAllowlist": 21,
    "firebaseCompatibilityCandidates": 5,
}
VERSION_PATTERN = re.compile(r"^[0-9]{14}$")
NAME_PATTERN = re.compile(r"^[a-z0-9_]+$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class VerificationError(ValueError):
    """Raised when pinned history, remote history, or local SQL is inconsistent."""


def load_json(path: str, stdin: TextIO = sys.stdin) -> Any:
    try:
        if path == "-":
            return json.load(stdin)
        with pathlib.Path(path).open(encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        raise VerificationError(f"could not read JSON from {path}: {error}") from error


def _require_entry(raw: Any, location: str) -> dict[str, str]:
    if not isinstance(raw, dict):
        raise VerificationError(f"{location} must be an object")
    if set(raw) != set(ENTRY_KEYS):
        raise VerificationError(f"{location} must contain exactly {', '.join(ENTRY_KEYS)}")

    entry = {key: raw[key] for key in ENTRY_KEYS}
    if not all(isinstance(value, str) for value in entry.values()):
        raise VerificationError(f"{location} fields must all be strings")
    if VERSION_PATTERN.fullmatch(entry["version"]) is None:
        raise VerificationError(f"{location}.version must be a 14-digit timestamp")
    if NAME_PATTERN.fullmatch(entry["name"]) is None:
        raise VerificationError(f"{location}.name must be lowercase snake_case")
    expected_filename = f'{entry["version"]}_{entry["name"]}.sql'
    if entry["filename"] != expected_filename:
        raise VerificationError(
            f"{location}.filename must be {expected_filename}, got {entry['filename']}"
        )
    if SHA256_PATTERN.fullmatch(entry["sha256"]) is None:
        raise VerificationError(f"{location}.sha256 must be 64 lowercase hex characters")
    return entry


def validate_manifest(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise VerificationError("manifest must be an object")
    if raw.get("schemaVersion") != 1:
        raise VerificationError("manifest.schemaVersion must be 1")
    project_ref = raw.get("projectRef")
    if project_ref != "whtejsviizgejauasqqt":
        raise VerificationError("manifest.projectRef must pin SIDEY production")

    normalized: dict[str, Any] = {
        "schemaVersion": 1,
        "projectRef": project_ref,
    }
    all_versions: dict[str, str] = {}
    for group in MANIFEST_GROUPS:
        raw_entries = raw.get(group)
        if not isinstance(raw_entries, list):
            raise VerificationError(f"manifest.{group} must be an array")
        if len(raw_entries) != EXPECTED_COUNTS[group]:
            raise VerificationError(
                f"manifest.{group} must contain {EXPECTED_COUNTS[group]} entries, "
                f"got {len(raw_entries)}"
            )
        entries = [
            _require_entry(entry, f"manifest.{group}[{index}]")
            for index, entry in enumerate(raw_entries)
        ]
        versions = [entry["version"] for entry in entries]
        if versions != sorted(versions):
            raise VerificationError(f"manifest.{group} must be sorted by version")
        for entry in entries:
            previous_group = all_versions.get(entry["version"])
            if previous_group is not None:
                raise VerificationError(
                    f"migration {entry['version']} appears in both {previous_group} and {group}"
                )
            all_versions[entry["version"]] = group
        normalized[group] = entries
    return normalized


def validate_local_files(manifest: dict[str, Any], migrations_dir: pathlib.Path) -> None:
    if not migrations_dir.is_dir():
        raise VerificationError(f"migrations directory does not exist: {migrations_dir}")

    for group in MANIFEST_GROUPS:
        for entry in manifest[group]:
            matches = sorted(migrations_dir.glob(f'{entry["version"]}_*.sql'))
            if len(matches) != 1:
                names = ", ".join(path.name for path in matches) or "none"
                raise VerificationError(
                    f"local migration {entry['version']} must have exactly one SQL file; found {names}"
                )
            path = matches[0]
            if path.name != entry["filename"]:
                raise VerificationError(
                    f"local migration {entry['version']} filename mismatch: "
                    f"expected {entry['filename']}, got {path.name}"
                )
            actual_hash = hashlib.sha256(path.read_bytes()).hexdigest()
            if actual_hash != entry["sha256"]:
                raise VerificationError(
                    f"local migration {path.name} SHA-256 mismatch: "
                    f"expected {entry['sha256']}, got {actual_hash}"
                )


def normalize_remote_list(raw: Any, expected_project_ref: str) -> list[dict[str, str]]:
    if isinstance(raw, dict):
        remote_project_ref = raw.get("projectRef")
        if remote_project_ref is not None and remote_project_ref != expected_project_ref:
            raise VerificationError(
                f"remote projectRef mismatch: expected {expected_project_ref}, got {remote_project_ref}"
            )
        raw = raw.get("migrations")
    if not isinstance(raw, list):
        raise VerificationError("remote JSON must be an array or an object with a migrations array")

    migrations: list[dict[str, str]] = []
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise VerificationError(f"remote migrations[{index}] must be an object")
        version = entry.get("version")
        name = entry.get("name")
        if not isinstance(version, str) or VERSION_PATTERN.fullmatch(version) is None:
            raise VerificationError(f"remote migrations[{index}].version is invalid")
        if not isinstance(name, str) or NAME_PATTERN.fullmatch(name) is None:
            raise VerificationError(f"remote migrations[{index}].name is invalid")
        migrations.append({"version": version, "name": name})
    return migrations


def validate_remote_history(
    manifest: dict[str, Any], remote_migrations: list[dict[str, str]]
) -> None:
    expected = [
        {"version": entry["version"], "name": entry["name"]}
        for entry in manifest["productionCurrent"]
    ]
    if remote_migrations == expected:
        return

    for index, (actual, wanted) in enumerate(zip(remote_migrations, expected)):
        if actual != wanted:
            raise VerificationError(
                f"remote migration mismatch at index {index}: expected {wanted}, got {actual}"
            )
    if len(remote_migrations) < len(expected):
        raise VerificationError(
            f"remote migration history is missing {len(expected) - len(remote_migrations)} entry(s); "
            f"expected {len(expected)}, got {len(remote_migrations)}"
        )
    raise VerificationError(
        f"remote migration history has {len(remote_migrations) - len(expected)} unexpected entry(s); "
        f"expected {len(expected)}, got {len(remote_migrations)}"
    )


def verify(
    manifest_path: pathlib.Path,
    migrations_dir: pathlib.Path,
    remote_path: str,
    stdin: TextIO = sys.stdin,
) -> dict[str, Any]:
    manifest = validate_manifest(load_json(str(manifest_path), stdin))
    validate_local_files(manifest, migrations_dir)
    remote = normalize_remote_list(load_json(remote_path, stdin), manifest["projectRef"])
    validate_remote_history(manifest, remote)
    return manifest


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Read-only verification of SIDEY production migration history and pinned local SQL."
        )
    )
    parser.add_argument(
        "--remote-list",
        required=True,
        metavar="PATH|-",
        help="JSON migration list file, or - to read JSON from stdin",
    )
    parser.add_argument("--manifest", type=pathlib.Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--migrations-dir", type=pathlib.Path, default=DEFAULT_MIGRATIONS)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        manifest = verify(args.manifest, args.migrations_dir, args.remote_list)
    except VerificationError as error:
        print(f"firebase production history verification failed: {error}", file=sys.stderr)
        return 1
    print(
        "firebase production history verified: "
        f"project={manifest['projectRef']} "
        f"production={len(manifest['productionCurrent'])} "
        f"repair-allowlist={len(manifest['firebaseHistoricalRepairAllowlist'])} "
        f"compatibility={len(manifest['firebaseCompatibilityCandidates'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
