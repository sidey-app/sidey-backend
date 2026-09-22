#!/usr/bin/env python3
"""Validate Firebase M0 production-shaped rehearsal evidence without remote writes.

This tool consumes only previously captured, read-only evidence. It never invokes the
Supabase CLI, connects to a database, repairs migration history, or applies SQL.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import pathlib
import re
import sys
from typing import Any, TextIO

import firebase_production_history as history


ROOT = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = pathlib.Path(__file__).with_name("firebase-production-history.json")
DEFAULT_MIGRATIONS = ROOT / "supabase" / "migrations"

PLAN_KEYS = (
    "schemaVersion",
    "schemaCanonicalizerVersion",
    "realtimeContractVersion",
    "projectRef",
    "baseRemoteHistorySha256",
    "phaseMigrations",
    "baseSchema",
    "prefix13Schema",
    "prefix16Schema",
    "prefix16IndexSchema",
    "prefix17Schema",
    "readySchema",
    "finalSchema",
    "historicalRepairVersions",
    "compatibilityCandidateVersions",
)
READY_SCHEMA_KEYS = (
    "objectCount",
    "sha256",
    "realtimeContractSha256",
    "constraintCatalog",
    "authFactorType",
)
PREFIX_SCHEMA_KEYS = READY_SCHEMA_KEYS + ("phaseCount", "atomicRunnerSha256")
HISTORY_SCHEMA_KEYS = READY_SCHEMA_KEYS + ("phaseCount",)
PREFIX13_PHASE_COUNT = 13
PREFIX16_PHASE_COUNT = 16
PREFIX17_PHASE_COUNT = 17
CONSTRAINT_CATALOG_KEYS = (
    "schema",
    "table",
    "name",
    "type",
    "validated",
    "deferrable",
    "deferred",
    "noInherit",
    "definition",
    "dumpVariants",
)
SCHEMA_CANONICALIZER_VERSION = 2
REALTIME_CONTRACT_VERSION = 2
CANONICAL_CONSTRAINT_IDENTITIES = (
    ("private", "app_store_transactions", "app_store_transactions_id_length"),
    ("private", "commerce_payments", "commerce_payments_portone_fields"),
)
AUTH_FACTOR_TYPE = ("totp", "webauthn", "phone", "recovery_code")
EXPECTED_REALTIME_COMPONENT_HASHES = {
    "parent": "9a4f61ccd00f4758f4257c951e6121fe0ac8e1cf0627692931732aa9dc1c7f32",
    "routines": "c2b4b0d87af7a63e9e3a01bb20e786f462bfb86aaaf7b850ebfd45b6b90b5a9f",
    "children": "182957c312fa1c3c91fd3cf7f8ffbb6e8ec689bf566ccb14dace782c1b42b417",
    "basePolicies": "e6d862ae1566631f202af2f7c61377ae90b965847a034186f4b70977576e9e40",
    "postPhasePolicies": "29c6cf07919a178f45b7d8bca96e56c02a3c8cfb4aa188c49eedb2cb5e3408e9",
}
EXPECTED_REALTIME_POLICY_CHANGES = [
    {
        "path": "sidey_room_channels_insert.withCheck",
        "beforeSha256": "7da771b03dabe4130f5e6c641f46298ed0d510cfd0afba0a07fa84bfd42641a1",
        "afterSha256": "9c689be8bef9e39640654882ce283601b4031faf98a40c91e22914021e076355",
    },
    {
        "path": "sidey_room_channels_select.qual",
        "beforeSha256": "afed3874086e59a260820627653b099f683a929acfcd22edbb90338c8d0fc2dd",
        "afterSha256": "9c3a118c60dfbdc97131055519da8ad8f1d8d165b8c24877558159c37a87db42",
    },
]
INVENTORY_KEYS = ("schemaVersion", "projectRef", "firebaseObjectCount", "schemaSha256")
BACKUP_COUNT_KEYS = (
    "authUsers",
    "authSessions",
    "profiles",
    "rooms",
    "roomMembers",
    "messages",
    "commerceProducts",
    "commercePrices",
    "commerceOrders",
    "commerceEntitlements",
    "commercePayments",
    "commerceWebhooks",
    "commerceRefunds",
    "commerceGrants",
    "commerceRuntime",
    "appStoreTransactions",
    "appStoreOffers",
    "appStoreNotifications",
    "adminPaymentCatalog",
    "characterItemTransition",
    "equippedProfiles",
)
MIGRATION_FILENAME_PATTERN = re.compile(
    r"(?<![0-9A-Za-z_])([0-9]{14})_([a-z0-9_]+)\.sql(?![0-9A-Za-z_])"
)
DRY_RUN_PATTERN = re.compile(r"dry[ -]?run", re.IGNORECASE)
MUTATION_PATTERN = re.compile(
    r"\b(?:applying|applied|executing)\s+migration\b", re.IGNORECASE
)


class RehearsalError(ValueError):
    """Raised when rehearsal evidence is incomplete, unsafe, or inconsistent."""


def _strict_keys(raw: Any, expected: tuple[str, ...], location: str) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise RehearsalError(f"{location} must be an object")
    if set(raw) != set(expected):
        raise RehearsalError(f"{location} must contain exactly {', '.join(expected)}")
    return raw


def _load_json(path: pathlib.Path) -> Any:
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        raise RehearsalError(f"could not read JSON from {path}: {error}") from error


def _load_remote_json(path: str, stdin: TextIO) -> Any:
    try:
        if path == "-":
            return json.load(stdin)
        with pathlib.Path(path).open(encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        raise RehearsalError(f"could not read remote JSON from {path}: {error}") from error


def canonical_history_sha256(entries: list[dict[str, str]]) -> str:
    canonical = json.dumps(
        [{"version": entry["version"], "name": entry["name"]} for entry in entries],
        ensure_ascii=True,
        separators=(",", ":"),
    )
    return hashlib.sha256((canonical + "\n").encode("utf-8")).hexdigest()


def _manifest_entries(manifest: dict[str, Any], group: str) -> list[dict[str, str]]:
    return [
        {"version": entry["version"], "name": entry["name"]}
        for entry in manifest[group]
    ]


def _require_migration_entry(raw: Any, location: str) -> dict[str, str]:
    entry = _strict_keys(raw, history.ENTRY_KEYS, location)
    if not all(isinstance(entry[key], str) for key in history.ENTRY_KEYS):
        raise RehearsalError(f"{location} fields must all be strings")
    if history.VERSION_PATTERN.fullmatch(entry["version"]) is None:
        raise RehearsalError(f"{location}.version must be a 14-digit timestamp")
    if history.NAME_PATTERN.fullmatch(entry["name"]) is None:
        raise RehearsalError(f"{location}.name must be lowercase snake_case")
    expected_filename = f'{entry["version"]}_{entry["name"]}.sql'
    if entry["filename"] != expected_filename:
        raise RehearsalError(
            f"{location}.filename must be {expected_filename}, got {entry['filename']}"
        )
    if history.SHA256_PATTERN.fullmatch(entry["sha256"]) is None:
        raise RehearsalError(f"{location}.sha256 must be 64 lowercase hex characters")
    return {key: entry[key] for key in history.ENTRY_KEYS}


def validate_phase_plan(raw: Any, manifest: dict[str, Any]) -> dict[str, Any]:
    plan = _strict_keys(raw, PLAN_KEYS, "phase plan")
    if plan["schemaVersion"] != 1:
        raise RehearsalError("phase plan.schemaVersion must be 1")
    if plan["schemaCanonicalizerVersion"] != SCHEMA_CANONICALIZER_VERSION:
        raise RehearsalError(
            "phase plan.schemaCanonicalizerVersion is unsupported"
        )
    if plan["realtimeContractVersion"] != REALTIME_CONTRACT_VERSION:
        raise RehearsalError("phase plan.realtimeContractVersion is unsupported")
    if plan["projectRef"] != manifest["projectRef"]:
        raise RehearsalError("phase plan.projectRef must pin SIDEY production")

    expected_base_hash = canonical_history_sha256(manifest["productionCurrent"])
    if plan["baseRemoteHistorySha256"] != expected_base_hash:
        raise RehearsalError("phase plan base remote history SHA-256 mismatch")

    raw_phases = plan["phaseMigrations"]
    if not isinstance(raw_phases, list) or not raw_phases:
        raise RehearsalError("phase plan.phaseMigrations must be a non-empty array")
    phases: list[dict[str, str]] = []
    for index, raw_entry in enumerate(raw_phases):
        entry = _require_migration_entry(
            raw_entry, f"phase plan.phaseMigrations[{index}]"
        )
        phases.append(entry)

    phase_versions = [entry["version"] for entry in phases]
    if phase_versions != sorted(set(phase_versions)):
        raise RehearsalError("phase plan.phaseMigrations must have unique sorted versions")
    pinned_versions = {
        entry["version"]
        for group in history.MANIFEST_GROUPS
        for entry in manifest[group]
    }
    if any(version in pinned_versions for version in phase_versions):
        raise RehearsalError("phase migration version collides with pinned repository history")
    if min(phase_versions) <= max(pinned_versions):
        raise RehearsalError("phase migration versions must follow all pinned repository migrations")
    if len(phases) <= PREFIX17_PHASE_COUNT:
        raise RehearsalError("phase plan must include work after the prefix17 checkpoint")

    schemas: dict[str, dict[str, Any]] = {}
    schema_keys = (
        "baseSchema",
        "prefix13Schema",
        "prefix16Schema",
        "prefix16IndexSchema",
        "prefix17Schema",
        "readySchema",
        "finalSchema",
    )
    helper_schema_keys = {
        "prefix13Schema", "prefix16Schema", "prefix16IndexSchema"
    }
    phase_schema_keys = helper_schema_keys | {"prefix17Schema"}
    expected_phase_counts = {
        "prefix13Schema": PREFIX13_PHASE_COUNT,
        "prefix16Schema": PREFIX16_PHASE_COUNT,
        "prefix16IndexSchema": PREFIX16_PHASE_COUNT,
        "prefix17Schema": PREFIX17_PHASE_COUNT,
    }
    for schema_key in schema_keys:
        if schema_key in helper_schema_keys:
            expected_keys = PREFIX_SCHEMA_KEYS
        elif schema_key in phase_schema_keys:
            expected_keys = HISTORY_SCHEMA_KEYS
        else:
            expected_keys = READY_SCHEMA_KEYS
        ready = _strict_keys(
            plan[schema_key], expected_keys, f"phase plan.{schema_key}"
        )
        if schema_key in phase_schema_keys:
            expected_phase_count = expected_phase_counts[schema_key]
            if ready["phaseCount"] != expected_phase_count:
                raise RehearsalError(
                    f"phase plan.{schema_key}.phaseCount must be {expected_phase_count}"
                )
        if schema_key in helper_schema_keys:
            if history.SHA256_PATTERN.fullmatch(
                str(ready["atomicRunnerSha256"])
            ) is None or ready["atomicRunnerSha256"] == ready["sha256"]:
                raise RehearsalError(
                    f"phase plan.{schema_key}.atomicRunnerSha256 must pin a distinct SHA-256"
                )
        object_count = ready["objectCount"]
        if (
            isinstance(object_count, bool)
            or not isinstance(object_count, int)
            or object_count < 0
        ):
            raise RehearsalError(
                f"phase plan.{schema_key}.objectCount must be a non-negative integer"
            )
        if not isinstance(ready["sha256"], str) or history.SHA256_PATTERN.fullmatch(
            ready["sha256"]
        ) is None:
            raise RehearsalError(
                f"phase plan.{schema_key}.sha256 must be 64 lowercase hex characters"
            )
        if history.SHA256_PATTERN.fullmatch(
            str(ready["realtimeContractSha256"])
        ) is None:
            raise RehearsalError(
                f"phase plan.{schema_key}.realtimeContractSha256 must be 64 lowercase hex characters"
            )
        raw_catalog = ready["constraintCatalog"]
        if not isinstance(raw_catalog, list) or len(raw_catalog) != 2:
            raise RehearsalError(
                f"phase plan.{schema_key}.constraintCatalog must contain exactly two rows"
            )
        catalog: list[dict[str, Any]] = []
        for index, raw_constraint in enumerate(raw_catalog):
            location = f"phase plan.{schema_key}.constraintCatalog[{index}]"
            constraint = _strict_keys(
                raw_constraint, CONSTRAINT_CATALOG_KEYS, location
            )
            identity = (
                constraint["schema"], constraint["table"], constraint["name"]
            )
            if identity != CANONICAL_CONSTRAINT_IDENTITIES[index]:
                raise RehearsalError(
                    f"{location} must pin the approved constraint identity"
                )
            if constraint["type"] != "c":
                raise RehearsalError(f"{location}.type must be c")
            for key, expected in (
                ("validated", True),
                ("deferrable", False),
                ("deferred", False),
                ("noInherit", False),
            ):
                if constraint[key] is not expected:
                    raise RehearsalError(f"{location}.{key} must be {expected}")
            if not isinstance(constraint["definition"], str) or not constraint[
                "definition"
            ].startswith("CHECK ("):
                raise RehearsalError(f"{location}.definition must pin a CHECK")
            variants = constraint["dumpVariants"]
            if (
                not isinstance(variants, list)
                or len(variants) != 2
                or len(set(variants)) != 2
                or not all(isinstance(value, str) for value in variants)
                or not all(
                    value.startswith(f'    CONSTRAINT "{constraint["name"]}" CHECK ')
                    for value in variants
                )
            ):
                raise RehearsalError(
                    f"{location}.dumpVariants must contain exactly two full approved lines"
                )
            catalog.append(dict(constraint))
        if ready["authFactorType"] != list(AUTH_FACTOR_TYPE):
            raise RehearsalError(
                f"phase plan.{schema_key}.authFactorType must pin exact enum order"
            )
        schemas[schema_key] = {
            "objectCount": object_count,
            "sha256": ready["sha256"],
            "realtimeContractSha256": ready["realtimeContractSha256"],
            "constraintCatalog": catalog,
            "authFactorType": list(AUTH_FACTOR_TYPE),
            **(
                {"atomicRunnerSha256": ready["atomicRunnerSha256"]}
                if schema_key in helper_schema_keys else {}
            ),
            **(
                {"phaseCount": ready["phaseCount"]}
                if schema_key in phase_schema_keys else {}
            ),
        }
    if any(
        schemas[schema_key]["constraintCatalog"]
        != schemas["baseSchema"]["constraintCatalog"]
        for schema_key in schema_keys[1:]
    ):
        raise RehearsalError(
            "phase plan constraint catalog must be identical at base/ready/final"
        )

    expected_repair = [
        entry["version"] for entry in manifest["firebaseHistoricalRepairAllowlist"]
    ]
    expected_candidates = [
        entry["version"] for entry in manifest["firebaseCompatibilityCandidates"]
    ]
    if plan["historicalRepairVersions"] != expected_repair:
        raise RehearsalError("phase plan historical repair allowlist mismatch")
    if plan["compatibilityCandidateVersions"] != expected_candidates:
        raise RehearsalError("phase plan compatibility candidate allowlist mismatch")

    return {
        **plan,
        "phaseMigrations": phases,
        **schemas,
    }


def validate_schema_canonicalization_evidence(
    raw: Any, plan: dict[str, Any]
) -> dict[str, Any]:
    evidence = _strict_keys(
        raw,
        (
            "schemaVersion",
            "schemaCanonicalizerVersion",
            "realtimeContractVersion",
            "appSchemaScope",
            "rehearsal",
            "realtimeContract",
            "migrationReplay",
        ),
        "schema canonicalization evidence",
    )
    if evidence["schemaVersion"] != 1:
        raise RehearsalError("schema canonicalization evidence.schemaVersion must be 1")
    if evidence["schemaCanonicalizerVersion"] != plan["schemaCanonicalizerVersion"]:
        raise RehearsalError("schema canonicalization evidence version mismatch")
    if evidence["realtimeContractVersion"] != plan["realtimeContractVersion"]:
        raise RehearsalError("realtime contract evidence version mismatch")
    if evidence["appSchemaScope"] != "public,private,auth":
        raise RehearsalError("schema canonicalization evidence scope mismatch")

    replay = evidence["rehearsal"]
    expected_states = {
        "productionBase": ("baseSchema", 0),
        "prefix13": ("prefix13Schema", plan["prefix13Schema"]["objectCount"]),
        "prefix16": ("prefix16Schema", plan["prefix16Schema"]["objectCount"]),
        "prefix16Index": (
            "prefix16IndexSchema", plan["prefix16IndexSchema"]["objectCount"]
        ),
        "prefix17": ("prefix17Schema", plan["prefix17Schema"]["objectCount"]),
        "ready": ("readySchema", plan["readySchema"]["objectCount"]),
        "final": ("finalSchema", plan["finalSchema"]["objectCount"]),
    }
    for evidence_key, (plan_key, count) in expected_states.items():
        item = _strict_keys(
            replay.get(evidence_key),
            (
                "rawSha256",
                "canonicalAppSha256",
                "realtimeContractSha256",
                "fingerprintSha256",
            ) + (() if evidence_key == "productionBase" else ("firebasePrivateTableCount",)),
            f"schema canonicalization {evidence_key}",
        )
        if item.get("fingerprintSha256") != plan[plan_key]["sha256"]:
            raise RehearsalError(
                f"schema canonicalization {evidence_key} hash mismatch"
            )
        if item.get("realtimeContractSha256") != plan[plan_key][
            "realtimeContractSha256"
        ]:
            raise RehearsalError(
                f"schema canonicalization {evidence_key} realtime hash mismatch"
            )
        if history.SHA256_PATTERN.fullmatch(str(item.get("rawSha256"))) is None:
            raise RehearsalError(
                f"schema canonicalization {evidence_key} raw hash is invalid"
            )
        if evidence_key != "productionBase" and item.get(
            "firebasePrivateTableCount"
        ) != count:
            raise RehearsalError(
                f"schema canonicalization {evidence_key} object count mismatch"
            )
    restored = _strict_keys(
        replay.get("restoredBase"),
        (
            "rawSha256",
            "canonicalAppSha256",
            "realtimeContractSha256",
            "fingerprintSha256",
        ),
        "schema canonicalization restoredBase",
    )
    if (
        restored.get("fingerprintSha256") != plan["baseSchema"]["sha256"]
        or restored.get("realtimeContractSha256")
        != plan["baseSchema"]["realtimeContractSha256"]
        or history.SHA256_PATTERN.fullmatch(str(restored.get("rawSha256"))) is None
    ):
        raise RehearsalError("schema canonicalization restored base mismatch")
    production_base = replay["productionBase"]
    if (
        production_base.get("canonicalAppSha256")
        != restored.get("canonicalAppSha256")
    ):
        raise RehearsalError("production and restored app schemas differ")
    production_prefix = _strict_keys(
        replay.get("productionPrefix13"),
        (
            "firebasePrivateTableCount",
            "rawSha256",
            "canonicalAppSha256",
            "realtimeContractSha256",
            "fingerprintSha256",
            "atomicRunnerExact",
        ),
        "schema canonicalization productionPrefix13",
    )
    if (
        production_prefix["firebasePrivateTableCount"]
        != plan["prefix13Schema"]["objectCount"]
        or production_prefix["fingerprintSha256"]
        != plan["prefix13Schema"]["atomicRunnerSha256"]
        or production_prefix["realtimeContractSha256"]
        != plan["prefix13Schema"]["realtimeContractSha256"]
        or production_prefix["atomicRunnerExact"] is not True
        or history.SHA256_PATTERN.fullmatch(
            str(production_prefix["rawSha256"])
        ) is None
    ):
        raise RehearsalError("production prefix13 atomic-runner checkpoint mismatch")
    production_prefix16 = _strict_keys(
        replay.get("productionPrefix16"),
        (
            "firebasePrivateTableCount",
            "rawSha256",
            "canonicalAppSha256",
            "realtimeContractSha256",
            "fingerprintSha256",
            "atomicRunnerExact",
        ),
        "schema canonicalization productionPrefix16",
    )
    if (
        production_prefix16["firebasePrivateTableCount"]
        != plan["prefix16Schema"]["objectCount"]
        or production_prefix16["fingerprintSha256"]
        != plan["prefix16Schema"]["atomicRunnerSha256"]
        or production_prefix16["realtimeContractSha256"]
        != plan["prefix16Schema"]["realtimeContractSha256"]
        or production_prefix16["atomicRunnerExact"] is not True
        or history.SHA256_PATTERN.fullmatch(
            str(production_prefix16["rawSha256"])
        ) is None
    ):
        raise RehearsalError("production prefix16 atomic-runner checkpoint mismatch")
    prefix16_index_helper = _strict_keys(
        replay.get("prefix16IndexHelper"),
        (
            "firebasePrivateTableCount",
            "rawSha256",
            "canonicalAppSha256",
            "realtimeContractSha256",
            "fingerprintSha256",
            "atomicRunnerExact",
        ),
        "schema canonicalization prefix16IndexHelper",
    )
    if (
        prefix16_index_helper["firebasePrivateTableCount"]
        != plan["prefix16IndexSchema"]["objectCount"]
        or prefix16_index_helper["fingerprintSha256"]
        != plan["prefix16IndexSchema"]["atomicRunnerSha256"]
        or prefix16_index_helper["realtimeContractSha256"]
        != plan["prefix16IndexSchema"]["realtimeContractSha256"]
        or prefix16_index_helper["atomicRunnerExact"] is not True
        or history.SHA256_PATTERN.fullmatch(
            str(prefix16_index_helper["rawSha256"])
        ) is None
    ):
        raise RehearsalError("prefix16 index/helper checkpoint mismatch")
    for key in (
        "productionBase", "restoredBase", "prefix13", "productionPrefix13",
        "prefix16", "productionPrefix16", "prefix16Index",
        "prefix16IndexHelper", "prefix17", "ready", "final"
    ):
        if history.SHA256_PATTERN.fullmatch(
            str(replay[key].get("canonicalAppSha256"))
        ) is None:
            raise RehearsalError(
                f"schema canonicalization {key} app hash is invalid"
            )

    realtime = _strict_keys(
        evidence["realtimeContract"],
        (
            "singleStatementSnapshot",
            "componentHashes",
            "transition",
            "partitionInventory",
        ),
        "realtime contract evidence",
    )
    if realtime["singleStatementSnapshot"] is not True:
        raise RehearsalError("realtime contract must use one snapshot statement")
    if realtime["componentHashes"] != EXPECTED_REALTIME_COMPONENT_HASHES:
        raise RehearsalError("realtime stable component hashes mismatch")
    transition = realtime["transition"]
    if transition != {
        "baseSha256": plan["baseSchema"]["realtimeContractSha256"],
        "readySha256": plan["readySchema"]["realtimeContractSha256"],
        "finalSha256": plan["finalSchema"]["realtimeContractSha256"],
        "changedFields": EXPECTED_REALTIME_POLICY_CHANGES,
    }:
        raise RehearsalError("realtime base-to-final transition mismatch")
    inventory = _strict_keys(
        realtime["partitionInventory"],
        (
            "snapshotUtcDate",
            "names",
            "postgresAclModes",
            "count",
            "continuous",
            "coversUtcTodayAndTomorrow",
        ),
        "realtime partition inventory",
    )
    names = inventory["names"]
    modes = inventory["postgresAclModes"]
    if (
        inventory["count"] != 7
        or inventory["continuous"] is not True
        or inventory["coversUtcTodayAndTomorrow"] is not True
        or not isinstance(names, list)
        or len(names) != 7
        or not isinstance(modes, list)
        or len(modes) != 7
    ):
        raise RehearsalError("realtime partition inventory summary mismatch")
    try:
        snapshot_date = datetime.date.fromisoformat(inventory["snapshotUtcDate"])
        dates = [
            datetime.date(
                *(int(value) for value in re.fullmatch(
                    r"messages_(\d{4})_(\d{2})_(\d{2})", name
                ).groups())
            )
            for name in names
        ]
    except (AttributeError, TypeError, ValueError) as error:
        raise RehearsalError("realtime partition inventory date is invalid") from error
    if dates != [dates[0] + datetime.timedelta(days=i) for i in range(7)]:
        raise RehearsalError("realtime partition evidence is not continuous")
    if snapshot_date not in dates or snapshot_date + datetime.timedelta(days=1) not in dates:
        raise RehearsalError("realtime partition evidence lacks today/tomorrow")
    if modes != [
        {"name": name, "mode": "legacy" if index < 6 else "modern"}
        for index, name in enumerate(names)
    ]:
        raise RehearsalError("realtime partition postgres ACL modes mismatch")

    migrations = evidence["migrationReplay"]
    if migrations != {
        "productionPhaseCount": len(plan["phaseMigrations"]),
        "historicalRepairSqlReplayed": False,
        "compatibilityCandidateCount": len(plan["compatibilityCandidateVersions"]),
    }:
        raise RehearsalError("schema canonicalization migration replay mismatch")
    return evidence


def validate_backup_snapshot_delta(
    before: Any, after: Any
) -> dict[str, Any]:
    if not isinstance(before, dict) or not isinstance(after, dict):
        raise RehearsalError("backup snapshots must be objects")
    for key in ("database", "serverVersion"):
        if before.get(key) != after.get(key) or not isinstance(before.get(key), str):
            raise RehearsalError(f"backup snapshot {key} drift")
    if before.get("migrationHistory") != after.get("migrationHistory"):
        raise RehearsalError("backup migration history drift")
    if before.get("cronJobs") != after.get("cronJobs"):
        raise RehearsalError("backup cron inventory drift")
    deltas: dict[str, int] = {}
    for key in BACKUP_COUNT_KEYS:
        left = before.get(key)
        right = after.get(key)
        if (
            isinstance(left, bool)
            or isinstance(right, bool)
            or not isinstance(left, int)
            or not isinstance(right, int)
            or left < 0
            or right < 0
        ):
            raise RehearsalError(f"backup snapshot {key} count is invalid")
        deltas[key] = right - left
    negative = sorted(key for key, delta in deltas.items() if delta < 0)
    return {
        "deltas": deltas,
        "negativeDeltas": negative,
        "manualReviewRequired": bool(negative),
        "migrationCount": len(before["migrationHistory"]),
        "cronJobCount": len(before["cronJobs"]),
    }


def classify_inventory(
    raw: Any, plan: dict[str, Any], expected_state: str
) -> str:
    inventory = _strict_keys(raw, INVENTORY_KEYS, "schema inventory")
    if inventory["schemaVersion"] != 1:
        raise RehearsalError("schema inventory.schemaVersion must be 1")
    if inventory["projectRef"] != plan["projectRef"]:
        raise RehearsalError("schema inventory.projectRef mismatch")

    count = inventory["firebaseObjectCount"]
    fingerprint = inventory["schemaSha256"]
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        raise RehearsalError("schema inventory.firebaseObjectCount must be a non-negative integer")
    if fingerprint is not None and (
        not isinstance(fingerprint, str)
        or history.SHA256_PATTERN.fullmatch(fingerprint) is None
    ):
        raise RehearsalError(
            "schema inventory.schemaSha256 must be null or 64 lowercase hex characters"
        )

    if count == 0 and fingerprint is None:
        actual_state = "EMPTY"
    elif (
        count == plan["readySchema"]["objectCount"]
        and fingerprint == plan["readySchema"]["sha256"]
    ):
        actual_state = "READY"
    else:
        raise RehearsalError(
            "schema inventory is PARTIAL/DRIFT; only exact EMPTY or exact READY is allowed"
        )

    if actual_state != expected_state:
        raise RehearsalError(
            f"schema state mismatch: expected {expected_state}, got {actual_state}"
        )
    return actual_state


def _expected_remote_history(
    manifest: dict[str, Any], plan: dict[str, Any], state: str
) -> list[dict[str, str]]:
    entries = _manifest_entries(manifest, "productionCurrent")
    if state == "READY":
        entries.extend(_manifest_entries(manifest, "firebaseHistoricalRepairAllowlist"))
        entries.extend(
            {"version": entry["version"], "name": entry["name"]}
            for entry in plan["phaseMigrations"]
        )
    return sorted(entries, key=lambda entry: entry["version"])


def validate_remote_history(
    remote: list[dict[str, str]],
    manifest: dict[str, Any],
    plan: dict[str, Any],
    state: str,
) -> None:
    expected = _expected_remote_history(manifest, plan, state)
    if remote == expected:
        return
    for index, (actual, wanted) in enumerate(zip(remote, expected)):
        if actual != wanted:
            raise RehearsalError(
                f"remote history is not allowlisted at index {index}; "
                f"expected {wanted['version']}_{wanted['name']}"
            )
    if len(remote) < len(expected):
        raise RehearsalError(
            f"remote history is missing {len(expected) - len(remote)} allowlisted entry(s)"
        )
    raise RehearsalError(
        f"remote history has {len(remote) - len(expected)} non-allowlisted entry(s)"
    )


def validate_deploy_bundle(
    bundle_dir: pathlib.Path, manifest: dict[str, Any], plan: dict[str, Any]
) -> None:
    if not bundle_dir.is_dir():
        raise RehearsalError(f"deploy bundle directory does not exist: {bundle_dir}")
    expected_entries = [*manifest["productionCurrent"], *plan["phaseMigrations"]]
    expected_names = {entry["filename"] for entry in expected_entries}
    actual_paths = sorted(bundle_dir.glob("*.sql"))
    actual_names = {path.name for path in actual_paths}
    if actual_names != expected_names:
        missing = len(expected_names - actual_names)
        unexpected = len(actual_names - expected_names)
        raise RehearsalError(
            f"deploy bundle SQL allowlist mismatch: missing={missing} unexpected={unexpected}"
        )
    for entry in expected_entries:
        path = bundle_dir / entry["filename"]
        actual_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual_hash != entry["sha256"]:
            raise RehearsalError(f"deploy bundle SQL SHA-256 mismatch: {entry['filename']}")


def parse_dry_run_migrations(text: str) -> list[dict[str, str]]:
    if DRY_RUN_PATTERN.search(text) is None:
        raise RehearsalError("dry-run output does not contain an explicit DRY RUN marker")
    if MUTATION_PATTERN.search(text) is not None:
        raise RehearsalError("dry-run output contains a migration mutation marker")
    matches = MIGRATION_FILENAME_PATTERN.findall(text)
    migrations: list[dict[str, str]] = []
    seen: set[str] = set()
    for version, name in matches:
        filename = f"{version}_{name}.sql"
        if filename in seen:
            continue
        seen.add(filename)
        migrations.append({"version": version, "name": name, "filename": filename})
    return migrations


def validate_dry_run(
    text: str, manifest: dict[str, Any], plan: dict[str, Any], state: str
) -> list[dict[str, str]]:
    actual = parse_dry_run_migrations(text)
    if state == "EMPTY":
        expected_entries = plan["phaseMigrations"]
    else:
        expected_entries = manifest["firebaseCompatibilityCandidates"]
    expected = [
        {
            "version": entry["version"],
            "name": entry["name"],
            "filename": entry["filename"],
        }
        for entry in expected_entries
    ]
    if actual != expected:
        raise RehearsalError(
            f"dry-run migration plan mismatch: expected={len(expected)} got={len(actual)}"
        )
    return actual


def verify(
    *,
    manifest_path: pathlib.Path,
    migrations_dir: pathlib.Path,
    remote_path: str,
    inventory_path: pathlib.Path,
    plan_path: pathlib.Path,
    bundle_dir: pathlib.Path,
    dry_run_path: pathlib.Path,
    expected_state: str,
    stdin: TextIO = sys.stdin,
) -> dict[str, Any]:
    try:
        manifest = history.validate_manifest(history.load_json(str(manifest_path)))
        history.validate_local_files(manifest, migrations_dir)
        remote = history.normalize_remote_list(
            _load_remote_json(remote_path, stdin), manifest["projectRef"]
        )
    except history.VerificationError as error:
        raise RehearsalError(str(error)) from error

    plan = validate_phase_plan(_load_json(plan_path), manifest)
    state = classify_inventory(_load_json(inventory_path), plan, expected_state)
    validate_remote_history(remote, manifest, plan, state)
    validate_deploy_bundle(bundle_dir, manifest, plan)
    try:
        dry_run_text = dry_run_path.read_text(encoding="utf-8")
    except OSError as error:
        raise RehearsalError(
            f"could not read dry-run output from {dry_run_path}: {error}"
        ) from error
    dry_run = validate_dry_run(dry_run_text, manifest, plan, state)
    return {
        "projectRef": manifest["projectRef"],
        "state": state,
        "remoteCount": len(remote),
        "bundleCount": len([*manifest["productionCurrent"], *plan["phaseMigrations"]]),
        "dryRunCount": len(dry_run),
        "planSha256": hashlib.sha256(plan_path.read_bytes()).hexdigest(),
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Offline/read-only validation of Firebase M0 production-shaped rehearsal evidence."
        )
    )
    parser.add_argument("--remote-list", required=True, metavar="PATH|-")
    parser.add_argument("--schema-inventory", required=True, type=pathlib.Path)
    parser.add_argument("--phase-plan", required=True, type=pathlib.Path)
    parser.add_argument("--deploy-bundle-dir", required=True, type=pathlib.Path)
    parser.add_argument("--dry-run-output", required=True, type=pathlib.Path)
    parser.add_argument("--expect-state", required=True, choices=("EMPTY", "READY"))
    parser.add_argument("--manifest", type=pathlib.Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--migrations-dir", type=pathlib.Path, default=DEFAULT_MIGRATIONS)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        result = verify(
            manifest_path=args.manifest,
            migrations_dir=args.migrations_dir,
            remote_path=args.remote_list,
            inventory_path=args.schema_inventory,
            plan_path=args.phase_plan,
            bundle_dir=args.deploy_bundle_dir,
            dry_run_path=args.dry_run_output,
            expected_state=args.expect_state,
        )
    except RehearsalError as error:
        print(f"firebase M0 rehearsal verification failed: {error}", file=sys.stderr)
        return 1
    print(
        "firebase M0 rehearsal verified: "
        f"project={result['projectRef']} state={result['state']} "
        f"remote={result['remoteCount']} bundle={result['bundleCount']} "
        f"dry-run={result['dryRunCount']} plan-sha256={result['planSha256']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
