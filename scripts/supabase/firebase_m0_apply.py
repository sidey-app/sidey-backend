#!/usr/bin/env python3
"""Apply the SIDEY Firebase M0 production plan with resumable safety gates.

This is intentionally pinned to the SIDEY production project. It never enables
the client rollout flag. The operator must pass --execute-production and the
exact project ref; an interrupted run can be resumed only from a recognized
migration-prefix/backfill state.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any

import firebase_m0_rehearsal as rehearsal
import firebase_production_history as history


ROOT = pathlib.Path(__file__).resolve().parents[2]
PROJECT_REF = "whtejsviizgejauasqqt"
MANIFEST_PATH = pathlib.Path(__file__).with_name("firebase-production-history.json")
PLAN_PATH = pathlib.Path(__file__).with_name("firebase-m0-production-plan.json")
SCHEMA_EVIDENCE_PATH = (
    pathlib.Path(__file__).with_name("fixtures")
    / "firebase_m0_schema_canonicalization.json"
)
MIGRATIONS = ROOT / "supabase" / "migrations"
PRODUCTION_MIGRATIONS = ROOT / "supabase" / "production-migrations"
CONFIG = ROOT / "supabase" / "config.toml"
LINKED_PROJECT_REF = ROOT / "supabase" / ".temp" / "project-ref"
PREPARE_VERSION = "20260921141500"
FINAL_PHASE_VERSION = "20260921142300"
CONCURRENT_INDEX_VERSION = "20260921141600"
PINNED_SUPABASE_CLI_VERSION = "2.116.0"
CONCURRENT_CREATE_SQL = (
    "create unique index concurrently if not exists "
    "messages_room_sequence_unique on public.messages(room_id, sequence)"
)
CONCURRENT_DROP_SQL = (
    "drop index concurrently if exists public.messages_room_sequence_unique"
)
CONCURRENT_LOCK_TIMEOUT_SECONDS = 5
CONCURRENT_STATEMENT_TIMEOUT_SECONDS = 600
CONCURRENT_CLIENT_TIMEOUT_SECONDS = 630
COMMERCE_EXACT_SETS = (
    "commerceProducts",
    "commercePrices",
    "appStoreOffers",
    "commerceRuntime",
    "adminPaymentCatalog",
    "characterItemTransition",
)
COMMERCE_PRESERVED_SETS = (
    "profiles",
    "commerceOrders",
    "commerceEntitlements",
    "commercePayments",
    "commerceWebhooks",
    "commerceRefunds",
    "commerceGrants",
    "appStoreTransactions",
    "appStoreNotifications",
)
COMMERCE_OBSERVED_SETS = ("authUsers", "equippedState")
WIRE_CODE_CONTRACT = (
    ("bubble", "bubble_bunny_pink", "bubble_bunny_pink", 1),
    ("bubble", "bubble_butter_chick", "bubble_butter_chick", 2),
    ("bubble", "bubble_starry_cat", "bubble_starry_cat", 3),
    ("throwable", "throwable_bouncy_heart", "throwable_bouncy_heart", 1),
    ("throwable", "throwable_toy_cannon", "throwable_toy_cannon", 2),
    ("throwable", "throwable_squeaky_duck", "throwable_squeaky_duck", 3),
    ("throwable", "throwable_snowflake", "throwable_snowflake", 4),
    ("throwable", "throwable_baseball", "throwable_baseball", 5),
    ("throwable", "throwable_wakkuball", "throwable_wakkuball", 6),
    ("throwable", "throwable_dujjonku", "throwable_dujjonku", 7),
    ("throwable", "throwable_mini_paprika", "throwable_mini_paprika", 8),
    ("throwable", "throwable_banana", "throwable_banana", 9),
    ("throwable", "throwable_dust_bath_pouch", "throwable_dust_bath_pouch", 10),
    ("throwable", "throwable_starlight_orb", "throwable_starlight_orb", 11),
    ("throwable", "throwable_clam", "throwable_clam", 12),
    ("throwable", "throwable_pork", "throwable_pork", 13),
    ("throwable", "throwable_timber", "throwable_timber", 14),
    ("throwable", "throwable_tennis_ball", "throwable_tennis_ball", 15),
    ("throwable", "throwable_tissue_ball", "throwable_tissue_ball", 16),
    (
        "throwable",
        "throwable_fish_cake_skewer",
        "throwable_fish_cake_skewer",
        17,
    ),
    ("throwable", "throwable_leaf", "throwable_leaf", 18),
)
SCHEMA_CANONICALIZER_VERSION = rehearsal.SCHEMA_CANONICALIZER_VERSION
REALTIME_CONTRACT_SQL = r"""
select jsonb_build_object(
  'utcToday', ((current_timestamp at time zone 'UTC')::date)::text,
  'parent', (
    select jsonb_build_object(
      'relkind', c.relkind,
      'isPartition', c.relispartition,
      'owner', c.relowner::regrole::text,
      'rls', c.relrowsecurity,
      'forceRls', c.relforcerowsecurity,
      'partitionKey', pg_get_partkeydef(c.oid),
      'columns', (
        select jsonb_agg(jsonb_build_object(
          'name', a.attname,
          'type', format_type(a.atttypid,a.atttypmod),
          'notNull', a.attnotnull,
          'default', pg_get_expr(d.adbin,d.adrelid,true)
        ) order by a.attnum)
        from pg_attribute a
        left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
        where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
      ),
      'constraints', (
        select jsonb_agg(jsonb_build_object(
          'name', conname, 'type', contype, 'validated', convalidated,
          'definition', pg_get_constraintdef(pg_constraint.oid,true)
        ) order by conname)
        from pg_constraint where conrelid=c.oid
      ),
      'indexes', (
        select jsonb_agg(jsonb_build_object(
          'name', ic.relname, 'valid', ix.indisvalid, 'ready', ix.indisready,
          'unique', ix.indisunique, 'primary', ix.indisprimary,
          'definition', pg_get_indexdef(ix.indexrelid)
        ) order by ic.relname)
        from pg_index ix join pg_class ic on ic.oid=ix.indexrelid
        where ix.indrelid=c.oid
      ),
      'acl', (
        select jsonb_agg(jsonb_build_object(
          'grantee', acl.grantee_name, 'privilege', acl.privilege_type,
          'grantable', acl.is_grantable
        ) order by acl.grantee_name,acl.privilege_type,acl.is_grantable)
        from (
          select case when x.grantee=0 then 'PUBLIC'
                      else x.grantee::regrole::text end as grantee_name,
                 x.privilege_type,x.is_grantable
          from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
        ) acl
      )
    ) from pg_class c where c.oid='realtime.messages'::regclass
  ),
  'policies', (
    select jsonb_agg(jsonb_build_object(
      'name', policyname, 'permissive', permissive, 'cmd', cmd,
      'roles', roles, 'qual', qual, 'withCheck', with_check
    ) order by policyname)
    from pg_policies where schemaname='realtime' and tablename='messages'
  ),
  'routines', (
    select jsonb_agg(jsonb_build_object(
      'signature', format('%I.%I(%s)',n.nspname,p.proname,
                          pg_get_function_identity_arguments(p.oid)),
      'return', pg_get_function_result(p.oid),
      'owner', p.proowner::regrole::text,
      'securityDefiner', p.prosecdef,
      'volatility', p.provolatile,
      'config', p.proconfig,
      'execute', (
        select jsonb_agg(jsonb_build_object(
          'grantee', acl.grantee_name, 'grantable', acl.is_grantable
        ) order by acl.grantee_name,acl.is_grantable)
        from (
          select case when x.grantee=0 then 'PUBLIC'
                      else x.grantee::regrole::text end as grantee_name,
                 x.is_grantable
          from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
          where x.privilege_type='EXECUTE'
        ) acl
      )
    ) order by p.proname,pg_get_function_identity_arguments(p.oid))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='realtime' and (
      (p.proname='topic' and pg_get_function_identity_arguments(p.oid)='')
      or (p.proname='send' and pg_get_function_identity_arguments(p.oid)=
          'payload jsonb, event text, topic text, private boolean')
    )
  ),
  'children', (
    select jsonb_agg(jsonb_build_object(
      'name', child.relname,
      'bound', pg_get_expr(child.relpartbound,child.oid,true),
      'owner', child.relowner::regrole::text,
      'relkind', child.relkind,
      'isPartition', child.relispartition,
      'columns', (
        select jsonb_agg(jsonb_build_object(
          'name', a.attname,
          'type', format_type(a.atttypid,a.atttypmod),
          'notNull', a.attnotnull,
          'default', pg_get_expr(d.adbin,d.adrelid,true)
        ) order by a.attnum)
        from pg_attribute a
        left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
        where a.attrelid=child.oid and a.attnum>0 and not a.attisdropped
      ),
      'constraints', (
        select jsonb_agg(jsonb_build_object(
          'name', conname, 'type', contype, 'validated', convalidated,
          'definition', pg_get_constraintdef(pg_constraint.oid,true)
        ) order by conname)
        from pg_constraint where conrelid=child.oid
      ),
      'indexes', (
        select jsonb_agg(jsonb_build_object(
          'name', ic.relname, 'valid', ix.indisvalid, 'ready', ix.indisready,
          'unique', ix.indisunique, 'primary', ix.indisprimary,
          'definition', pg_get_indexdef(ix.indexrelid),
          'parentIndex', parent_index.relname
        ) order by ic.relname)
        from pg_index ix
        join pg_class ic on ic.oid=ix.indexrelid
        left join pg_inherits index_inherits on index_inherits.inhrelid=ix.indexrelid
        left join pg_class parent_index on parent_index.oid=index_inherits.inhparent
        where ix.indrelid=child.oid
      ),
      'acl', (
        select jsonb_agg(jsonb_build_object(
          'grantee', acl.grantee_name, 'privilege', acl.privilege_type,
          'grantable', acl.is_grantable
        ) order by acl.grantee_name,acl.privilege_type,acl.is_grantable)
        from (
          select case when x.grantee=0 then 'PUBLIC'
                      else x.grantee::regrole::text end as grantee_name,
                 x.privilege_type,x.is_grantable
          from aclexplode(coalesce(child.relacl,acldefault('r',child.relowner))) x
        ) acl
      )
    ) order by child.relname)
    from pg_inherits inheritance
    join pg_class child on child.oid=inheritance.inhrelid
    where inheritance.inhparent='realtime.messages'::regclass
  )
) as contract
"""


class ApplyError(RuntimeError):
    pass


class CommandTimeoutError(ApplyError):
    pass


def _fingerprint_array_sql(rows_sql: str) -> str:
    return (
        "(select coalesce(jsonb_agg(fingerprint order by fingerprint),'[]'::jsonb) "
        "from (select encode(extensions.digest(convert_to(payload::text,'UTF8'),"
        "'sha256'),'hex') as fingerprint from ("
        + rows_sql
        + ") as source(payload)) as fingerprints)"
    )


def commerce_critical_snapshot_sql() -> str:
    """Return only DB-side hashes and aggregate invariant counts, never raw data."""
    sets = {
        "authUsers": "select jsonb_build_array(id) from auth.users",
        "profiles": "select jsonb_build_array(id) from public.profiles",
        "commerceProducts": (
            "select jsonb_build_array(id,display_name,product_description,character_id,"
            "entitlement_key,active,created_at,product_kind,catalog_item_id,sort_order,"
            "related_character_product_id,render_asset_id) from public.commerce_products"
        ),
        "commercePrices": "select to_jsonb(prices) from public.commerce_prices prices",
        "appStoreOffers": (
            "select to_jsonb(offers) from private.app_store_product_offers offers"
        ),
        "commerceRuntime": (
            "select to_jsonb(settings) from private.commerce_runtime_settings settings"
        ),
        "adminPaymentCatalog": (
            "select to_jsonb(catalog) from private.admin_payment_catalog_snapshot catalog"
        ),
        "characterItemTransition": (
            "select to_jsonb(transition) from private.character_item_transition transition"
        ),
        "commerceOrders": (
            "select jsonb_build_array(id,provider_order_id,product_id,price_id,"
            "amount_krw,currency,checkout_token_hash,checkout_token_expires_at,created_at,"
            "policy_version,policy_notice,policy_consented_at) from public.commerce_orders"
        ),
        "commerceEntitlements": (
            "select jsonb_build_array(user_id,entitlement_key) "
            "from public.commerce_entitlements"
        ),
        "commercePayments": (
            "select jsonb_build_array(order_id,payment_key,portone_payment_id,"
            "portone_store_id,portone_channel_key,amount_krw,currency,provider,created_at) "
            "from private.commerce_payments"
        ),
        "commerceWebhooks": (
            "select jsonb_build_array(event_id,payload_sha256,received_at) "
            "from private.commerce_webhook_events"
        ),
        "commerceRefunds": (
            "select jsonb_build_array(order_id,request_id,reason_code,requested_by,requested_at) "
            "from private.commerce_refund_operations"
        ),
        "commerceGrants": (
            "select jsonb_build_array(id,entitlement_key,source_kind,source_reference,granted_at,"
            "included_entitlement_key,parent_grant_id) from private.commerce_grants"
        ),
        "appStoreTransactions": (
            "select jsonb_build_array(transaction_id,original_transaction_id,product_id,"
            "environment,purchased_at,store_product_id"
            ") from private.app_store_transactions"
        ),
        "appStoreNotifications": (
            "select jsonb_build_array(notification_uuid,notification_type,environment,"
            "signed_at,payload_sha256,received_at) "
            "from private.app_store_notification_events"
        ),
        "equippedState": (
            "select jsonb_build_array(id,equipped_bubble_style_id,equipped_throwable_id) "
            "from public.profiles"
        ),
    }
    set_sql = ",".join(
        f"'{name}',{_fingerprint_array_sql(statement)}"
        for name, statement in sets.items()
    )
    invalid_equipped = """
      (select jsonb_build_object(
        'bubble',count(*) filter (where p.equipped_bubble_style_id is not null and not exists (
          select 1 from public.commerce_products product
          join public.commerce_entitlements entitlement
            on entitlement.entitlement_key=product.entitlement_key
           and entitlement.user_id=p.id and entitlement.status='active'
          where product.product_kind='bubble' and product.active
            and product.catalog_item_id=p.equipped_bubble_style_id
        )),
        'throwable',count(*) filter (where p.equipped_throwable_id is not null and not exists (
          select 1 from public.commerce_products product
          join public.commerce_entitlements entitlement
            on entitlement.entitlement_key=product.entitlement_key
           and entitlement.user_id=p.id and entitlement.status='active'
          where product.product_kind='throwable' and product.active
            and product.catalog_item_id=p.equipped_throwable_id
        ))) from public.profiles p)
    """
    return (
        "select jsonb_build_object('sets',jsonb_build_object("
        + set_sql
        + "),'invalidEquipped',"
        + invalid_equipped
        + ") as snapshot"
    )


def commerce_critical_snapshot() -> dict[str, Any]:
    rows = query(commerce_critical_snapshot_sql())
    if len(rows) != 1 or not isinstance(rows[0].get("snapshot"), dict):
        raise ApplyError("commerce/auth critical snapshot returned an invalid shape")
    snapshot = rows[0]["snapshot"]
    if set(snapshot) != {"sets", "invalidEquipped"} or not isinstance(
        snapshot["sets"], dict
    ):
        raise ApplyError("commerce/auth critical snapshot keys drifted")
    expected_sets = set(
        COMMERCE_EXACT_SETS + COMMERCE_PRESERVED_SETS + COMMERCE_OBSERVED_SETS
    )
    if set(snapshot["sets"]) != expected_sets:
        raise ApplyError("commerce/auth critical snapshot set inventory drifted")
    for name, values in snapshot["sets"].items():
        if (
            not isinstance(values, list)
            or values != sorted(values)
            or len(values) != len(set(values))
            or any(
                not isinstance(value, str)
                or re.fullmatch(r"[0-9a-f]{64}", value) is None
                for value in values
            )
        ):
            raise ApplyError(f"commerce/auth critical snapshot {name} is invalid")
    if snapshot["invalidEquipped"] != {"bubble": 0, "throwable": 0}:
        raise ApplyError(
            "commerce equipped ownership invariant failed: "
            f"{snapshot['invalidEquipped']}"
        )
    return snapshot


def verify_commerce_critical_preserved(
    before: dict[str, Any], after: dict[str, Any]
) -> dict[str, Any]:
    if before.get("invalidEquipped") != {"bubble": 0, "throwable": 0}:
        raise ApplyError("pre-apply equipped ownership invariant was not clean")
    if after.get("invalidEquipped") != {"bubble": 0, "throwable": 0}:
        raise ApplyError("post-apply equipped ownership invariant failed")
    before_sets = before.get("sets")
    after_sets = after.get("sets")
    if not isinstance(before_sets, dict) or not isinstance(after_sets, dict):
        raise ApplyError("commerce/auth critical snapshot sets are missing")
    deltas: dict[str, int] = {}
    for name in COMMERCE_EXACT_SETS:
        if before_sets.get(name) != after_sets.get(name):
            raise ApplyError(f"commerce critical exact set changed: {name}")
        deltas[name] = 0
    for name in COMMERCE_PRESERVED_SETS:
        left = before_sets.get(name)
        right = after_sets.get(name)
        if not isinstance(left, list) or not isinstance(right, list):
            raise ApplyError(f"commerce critical preserved set is invalid: {name}")
        missing = set(left) - set(right)
        if missing:
            raise ApplyError(
                f"commerce critical existing rows changed or disappeared: {name} "
                f"missing={len(missing)}"
            )
        deltas[name] = len(right) - len(left)
    return {
        "deltas": deltas,
        "equippedStateChanged": (
            before_sets.get("equippedState") != after_sets.get("equippedState")
        ),
    }


def verify_wire_code_contract() -> None:
    rows = query(
        "select product_kind, id as product_id, catalog_item_id, wire_code "
        "from public.commerce_products "
        "where product_kind in ('bubble','throwable') "
        "order by product_kind, wire_code, id"
    )
    expected = [
        {
            "product_kind": product_kind,
            "product_id": product_id,
            "catalog_item_id": catalog_item_id,
            "wire_code": wire_code,
        }
        for product_kind, product_id, catalog_item_id, wire_code in sorted(
            WIRE_CODE_CONTRACT, key=lambda item: (item[0], item[3], item[1])
        )
    ]
    if rows != expected:
        raise ApplyError("commerce wire-code contract read-back mismatch")


def run(
    command: list[str], *, capture: bool = False, timeout_seconds: int | None = None,
    env_overrides: dict[str, str] | None = None,
) -> str:
    try:
        result = subprocess.run(
            command,
            cwd=ROOT,
            text=True,
            capture_output=capture,
            check=False,
            timeout=timeout_seconds,
            env={**os.environ, **(env_overrides or {})},
        )
    except subprocess.TimeoutExpired as error:
        raise CommandTimeoutError(
            f"command timed out after {timeout_seconds}s: {' '.join(command[:4])}"
        ) from error
    if result.returncode != 0:
        detail = result.stderr.strip() if capture else f"exit={result.returncode}"
        raise ApplyError(f"command failed: {' '.join(command[:4])}: {detail}")
    return result.stdout if capture else ""


def require_pinned_cli() -> None:
    actual = run(["supabase", "--version"], capture=True).strip()
    if actual != PINNED_SUPABASE_CLI_VERSION:
        raise ApplyError(
            "Supabase CLI version mismatch for rehearsed atomic runner: "
            f"expected={PINNED_SUPABASE_CLI_VERSION} actual={actual}"
        )


def query(sql: str, *, timeout_seconds: int = 90) -> list[dict[str, Any]]:
    try:
        linked = LINKED_PROJECT_REF.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise ApplyError("Supabase checkout is not linked to production") from error
    if linked != PROJECT_REF:
        raise ApplyError("Supabase checkout is linked to the wrong project")
    output = run(
        [
            "supabase",
            "db",
            "query",
            "--linked",
            "--workdir",
            str(ROOT),
            "--output",
            "json",
            sql,
        ],
        capture=True,
        timeout_seconds=timeout_seconds,
    )
    try:
        payload = json.loads(output)
    except json.JSONDecodeError as error:
        raise ApplyError(f"database query returned invalid JSON: {error}") from error
    rows = payload.get("rows")
    if not isinstance(rows, list):
        raise ApplyError("database query did not return a rows array")
    return rows


def execute_statement(
    sql: str, *, timeout_seconds: int = 90,
    env_overrides: dict[str, str] | None = None,
) -> None:
    try:
        linked = LINKED_PROJECT_REF.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise ApplyError("Supabase checkout is not linked to production") from error
    if linked != PROJECT_REF:
        raise ApplyError("Supabase checkout is linked to the wrong project")
    run([
        "supabase", "db", "query", "--linked", "--workdir", str(ROOT), sql,
    ], capture=True, timeout_seconds=timeout_seconds, env_overrides=env_overrides)


def execute_sql_file(path: pathlib.Path, *, timeout_seconds: int = 660) -> None:
    try:
        linked = LINKED_PROJECT_REF.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise ApplyError("Supabase checkout is not linked to production") from error
    if linked != PROJECT_REF:
        raise ApplyError("Supabase checkout is linked to the wrong project")
    run([
        "supabase",
        "db",
        "query",
        "--linked",
        "--workdir",
        str(ROOT),
        "--file",
        str(path),
    ], capture=True, timeout_seconds=timeout_seconds)


def migration_body(source: str, version: str) -> str:
    lines = source.splitlines()
    controls = [
        (index, line.strip().lower())
        for index, line in enumerate(lines)
        if line.strip().lower() in {"begin;", "commit;"}
    ]
    if (
        len(controls) != 2
        or controls[0][1] != "begin;"
        or controls[1][1] != "commit;"
    ):
        raise ApplyError(f"migration {version} must contain one BEGIN/COMMIT pair")
    begin_index, commit_index = controls[0][0], controls[1][0]
    if begin_index >= commit_index:
        raise ApplyError(f"migration {version} has invalid transaction boundaries")
    prefix = "\n".join(lines[:begin_index])
    suffix = "\n".join(lines[commit_index + 1:])
    if re.sub(r"(?m)^\s*--.*$", "", prefix).strip() or suffix.strip():
        raise ApplyError(f"migration {version} has SQL outside its transaction")
    body = "\n".join(lines[begin_index + 1:commit_index]).strip()
    if re.search(r"(?im)^\s*(?:begin|commit|rollback)\s*;", body):
        raise ApplyError(f"migration {version} has nested transaction control")
    if re.search(r"(?i)\bconcurrently\b", body):
        raise ApplyError(f"migration {version} requires the concurrent-index runner")
    return body


def split_sql_statements(sql: str) -> list[str]:
    statements: list[str] = []
    current: list[str] = []
    state = "normal"
    dollar_tag = ""
    index = 0
    while index < len(sql):
        char = sql[index]
        pair = sql[index:index + 2]
        if state == "normal":
            if pair == "--":
                state = "line_comment"
                current.append(pair)
                index += 2
                continue
            if pair == "/*":
                state = "block_comment"
                current.append(pair)
                index += 2
                continue
            if char == "'":
                state = "single"
            elif char == '"':
                state = "double"
            elif char == "$":
                match = re.match(r"\$[A-Za-z_0-9]*\$", sql[index:])
                if match:
                    dollar_tag = match.group(0)
                    state = "dollar"
                    current.append(dollar_tag)
                    index += len(dollar_tag)
                    continue
            elif char == ";":
                statement = "".join(current).strip()
                if statement:
                    statements.append(statement)
                current = []
                index += 1
                continue
            current.append(char)
            index += 1
            continue
        if state == "single":
            current.append(char)
            if char == "'":
                if index + 1 < len(sql) and sql[index + 1] == "'":
                    current.append("'")
                    index += 2
                    continue
                state = "normal"
            index += 1
            continue
        if state == "double":
            current.append(char)
            if char == '"':
                if index + 1 < len(sql) and sql[index + 1] == '"':
                    current.append('"')
                    index += 2
                    continue
                state = "normal"
            index += 1
            continue
        if state == "dollar":
            if sql.startswith(dollar_tag, index):
                current.append(dollar_tag)
                index += len(dollar_tag)
                state = "normal"
            else:
                current.append(char)
                index += 1
            continue
        if state == "line_comment":
            current.append(char)
            index += 1
            if char == "\n":
                state = "normal"
            continue
        if state == "block_comment":
            current.append(char)
            if pair == "*/":
                current.append("/")
                index += 2
                state = "normal"
            else:
                index += 1
            continue
    if state not in {"normal", "line_comment"}:
        raise ApplyError(f"unterminated SQL lexical state: {state}")
    trailing = "".join(current).strip()
    if trailing:
        statements.append(trailing)
    return statements


ATOMIC_RUNNER_BODY = r"""
declare
  statement text;
  recorded_name text;
begin
  if session_user <> 'postgres'
     and not pg_has_role(session_user, 'postgres', 'member') then
    raise exception using errcode = '42501', message = 'atomic_runner_forbidden';
  end if;
  if p_version !~ '^[0-9]{14}$' or p_name !~ '^[a-z0-9_]+$'
     or p_statements is null or cardinality(p_statements) < 1 then
    raise exception using errcode = '22023', message = 'atomic_runner_invalid';
  end if;
  select migrations.name into recorded_name
  from supabase_migrations.schema_migrations as migrations
  where migrations.version = p_version;
  if found then
    if recorded_name <> p_name then
      raise exception using errcode = 'P0001', message = 'atomic_runner_history_drift';
    end if;
    return;
  end if;
  foreach statement in array p_statements loop
    execute statement;
  end loop;
  insert into supabase_migrations.schema_migrations(version, statements, name)
  values (p_version, p_statements, p_name);
end;
"""


ATOMIC_RUNNER_SQL = r"""create or replace function private.sidey_apply_atomic_migration(
  p_version text,
  p_name text,
  p_statements text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $runner$""" + ATOMIC_RUNNER_BODY + "$runner$"

ATOMIC_RUNNER_REVOKE_SQL = (
    "revoke all on function private.sidey_apply_atomic_migration(text,text,text[]) "
    "from public, anon, authenticated, service_role"
)


def atomic_runner_install_sql() -> str:
    # One top-level DO statement gives the Management API exactly one prepared
    # statement while keeping function creation and ACL hardening atomic.
    return (
        "do $sidey_install$ begin execute "
        + dollar_quote(ATOMIC_RUNNER_SQL, 900)
        + "; execute "
        + dollar_quote(ATOMIC_RUNNER_REVOKE_SQL, 901)
        + "; end $sidey_install$"
    )


def ensure_atomic_runner() -> None:
    execute_statement(atomic_runner_install_sql())


def drop_atomic_runner() -> None:
    execute_statement(
        "drop function if exists "
        "private.sidey_apply_atomic_migration(text,text,text[])"
    )


def cleanup_atomic_runner() -> None:
    rows = query(
        "select p.proowner::regrole::text as owner, p.prosecdef, p.provolatile, "
        "p.prokind, p.proconfig, p.prosrc, "
        "has_function_privilege('public', p.oid, 'execute') as public_execute, "
        "has_function_privilege('anon', p.oid, 'execute') as anon_execute, "
        "has_function_privilege('authenticated', p.oid, 'execute') "
        "as authenticated_execute, "
        "has_function_privilege('service_role', p.oid, 'execute') "
        "as service_role_execute "
        "from pg_proc as p where p.oid=to_regprocedure("
        "'private.sidey_apply_atomic_migration(text,text,text[])')"
    )
    if not rows:
        return
    expected = [{
        "owner": "postgres",
        "prosecdef": True,
        "provolatile": "v",
        "prokind": "f",
        "proconfig": ["search_path=\"\""],
        "prosrc": ATOMIC_RUNNER_BODY,
        "public_execute": False,
        "anon_execute": False,
        "authenticated_execute": False,
        "service_role_execute": False,
    }]
    if rows != expected:
        raise ApplyError(f"atomic runner inventory drift; refusing cleanup: {rows}")
    drop_atomic_runner()


def dollar_quote(value: str, index: int) -> str:
    suffix = index
    while True:
        tag = f"$sidey_m0_{suffix}$"
        if tag not in value:
            return f"{tag}{value}{tag}"
        suffix += 1


def atomic_migration_call_sql(source: str, version: str, name: str) -> str:
    statements = split_sql_statements(migration_body(source, version))
    if not statements:
        raise ApplyError(f"migration {version} contains no SQL statements")
    encoded = ",".join(
        dollar_quote(statement, index) for index, statement in enumerate(statements)
    )
    return (
        "select private.sidey_apply_atomic_migration("
        f"'{version}','{name}',array[{encoded}]::text[])"
    )


def apply_atomic_migration(path: pathlib.Path, version: str, name: str) -> None:
    source = path.read_text(encoding="utf-8")
    ensure_atomic_runner()
    query(atomic_migration_call_sql(source, version, name))


def validate_concurrent_statement(statement: str) -> str:
    normalized = statement.strip().rstrip(";").lower()
    if normalized not in {CONCURRENT_CREATE_SQL, CONCURRENT_DROP_SQL}:
        raise ApplyError("concurrent runner accepts only DROP/CREATE INDEX CONCURRENTLY")
    return normalized


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def concurrent_job_names(statement: str) -> tuple[str, str]:
    operation = "create" if statement == CONCURRENT_CREATE_SQL else "drop"
    return f"sidey-m0-index-{operation}", f"sidey-m0-index-{operation}-watchdog"


def concurrent_watchdog_sql(statement: str) -> str:
    return (
        "select pg_cancel_backend(pid) from pg_stat_activity "
        "where datname=current_database() and query=" + sql_literal(statement) + " "
        "and ((wait_event_type='Lock' and clock_timestamp()-query_start > "
        f"interval '{CONCURRENT_LOCK_TIMEOUT_SECONDS} seconds') "
        "or clock_timestamp()-query_start > "
        f"interval '{CONCURRENT_STATEMENT_TIMEOUT_SECONDS} seconds')"
    )


def cleanup_concurrent_jobs(statement: str) -> None:
    job_name, watchdog_name = concurrent_job_names(statement)
    rows = query(
        "select jobid, jobname, schedule, command, database, username, active "
        "from cron.job where jobname in ("
        f"{sql_literal(job_name)},{sql_literal(watchdog_name)}) order by jobname"
    )
    expected_commands = {
        job_name: statement,
        watchdog_name: concurrent_watchdog_sql(statement),
    }
    for row in rows:
        name = row.get("jobname")
        if (
            name not in expected_commands
            or row.get("schedule") != "1 second"
            or row.get("command") != expected_commands[name]
            or row.get("database") != "postgres"
            or row.get("username") != "postgres"
            or row.get("active") is not True
        ):
            raise ApplyError(f"concurrent index cron inventory drift: {rows}")
    if rows:
        execute_statement(
            "select cron.unschedule(jobid) from cron.job where jobname in ("
            f"{sql_literal(job_name)},{sql_literal(watchdog_name)})"
        )
    execute_statement(
        "select pg_cancel_backend(pid) from pg_stat_activity "
        "where datname=current_database() and query=" + sql_literal(statement)
    )
    remaining = query(
        "select jobname from cron.job where jobname in ("
        f"{sql_literal(job_name)},{sql_literal(watchdog_name)})"
    )
    if remaining:
        raise ApplyError(f"concurrent index cron cleanup failed: {remaining}")


def execute_concurrent_statement(statement: str) -> None:
    sql = validate_concurrent_statement(statement)
    job_name, watchdog_name = concurrent_job_names(sql)
    cleanup_concurrent_jobs(sql)
    try:
        watchdog = concurrent_watchdog_sql(sql)
        watchdog_rows = query(
            "select cron.schedule(" + sql_literal(watchdog_name) + ", '1 second', "
            + sql_literal(watchdog) + ") as jobid"
        )
        if len(watchdog_rows) != 1 or not isinstance(
            watchdog_rows[0].get("jobid"), int
        ):
            raise ApplyError(f"concurrent watchdog schedule failed: {watchdog_rows}")
        job_rows = query(
            "select cron.schedule(" + sql_literal(job_name) + ", '1 second', "
            + sql_literal(sql) + ") as jobid"
        )
        if len(job_rows) != 1 or not isinstance(job_rows[0].get("jobid"), int):
            raise ApplyError(f"concurrent index schedule failed: {job_rows}")
        job_id = job_rows[0]["jobid"]
        started = time.monotonic()
        while time.monotonic() - started < CONCURRENT_CLIENT_TIMEOUT_SECONDS:
            runs = query(
                "select status, return_message from cron.job_run_details "
                f"where jobid={job_id} order by runid desc limit 1"
            )
            if runs and runs[0].get("status") == "succeeded":
                return
            if runs and runs[0].get("status") == "failed":
                raise ApplyError(
                    "concurrent index cron command failed: "
                    f"{runs[0].get('return_message')}"
                )
            time.sleep(1)
        raise CommandTimeoutError(
            f"concurrent index cron command exceeded {CONCURRENT_CLIENT_TIMEOUT_SECONDS}s"
        )
    finally:
        cleanup_concurrent_jobs(sql)


def ensure_concurrent_message_index() -> None:
    # A process can die after cron reports success but before its finally block.
    # Always remove both exact CREATE/DROP job pairs before inspecting the index,
    # including the valid-index early-return path.
    cleanup_concurrent_jobs(CONCURRENT_CREATE_SQL)
    cleanup_concurrent_jobs(CONCURRENT_DROP_SQL)
    rows = query(
        "select i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) as definition "
        "from pg_index as i "
        "where i.indexrelid = to_regclass('public.messages_room_sequence_unique')"
    )
    expected_definition = (
        "CREATE UNIQUE INDEX messages_room_sequence_unique ON public.messages "
        "USING btree (room_id, sequence)"
    )
    if rows and (
        len(rows) != 1 or rows[0].get("definition") != expected_definition
    ):
        raise ApplyError(f"message sequence index definition drift: {rows}")
    if rows and rows[0].get("indisvalid") is True and rows[0].get("indisready") is True:
        return
    try:
        if rows:
            execute_concurrent_statement(CONCURRENT_DROP_SQL)
        execute_concurrent_statement(CONCURRENT_CREATE_SQL)
    except (ApplyError, CommandTimeoutError) as error:
        state = query(
            "select i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) as definition "
            "from pg_index as i where i.indexrelid = "
            "to_regclass('public.messages_room_sequence_unique')"
        )
        raise ApplyError(
            f"concurrent index command failed; post-cancel state={state}: {error}"
        ) from error
    verified = query(
        "select i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) as definition "
        "from pg_index as i "
        "where i.indexrelid = 'public.messages_room_sequence_unique'::regclass"
    )
    if verified != [{
        "indisvalid": True,
        "indisready": True,
        "definition": expected_definition,
    }]:
        raise ApplyError(f"message sequence concurrent index read-back failed: {verified}")


def record_concurrent_index_history(version: str, name: str) -> None:
    # The index lives outside the ordinary migration directory and cannot use
    # `supabase migration repair`. Its only non-atomic gap is safe because the
    # caller first proves the exact valid index definition on every resume.
    execute_statement(
        "insert into supabase_migrations.schema_migrations(version, statements, name) "
        f"values ('{version}', ARRAY[]::text[], '{name}') "
        "on conflict (version) do nothing"
    )
    rows = query(
        "select version, name from supabase_migrations.schema_migrations "
        f"where version = '{version}'"
    )
    if rows != [{"version": version, "name": name}]:
        raise ApplyError(f"concurrent index history read-back failed: {rows}")


def remote_history() -> list[dict[str, str]]:
    rows = query(
        "select version, name from supabase_migrations.schema_migrations "
        "order by version"
    )
    return [
        {"version": str(row["version"]), "name": str(row["name"])}
        for row in rows
    ]


def entries(group: list[dict[str, str]]) -> list[dict[str, str]]:
    return [{"version": item["version"], "name": item["name"]} for item in group]


def exact_prefix_count(
    current: list[dict[str, str]],
    fixed: list[dict[str, str]],
    ordered_additions: list[dict[str, str]],
) -> int | None:
    """Return an exact applied-prefix length, rejecting subsets and extra rows."""
    for count in range(len(ordered_additions) + 1):
        expected = sorted(
            fixed + ordered_additions[:count], key=lambda item: item["version"]
        )
        if current == expected:
            return count
    return None


def approved_resume_state(
    current: list[dict[str, str]],
    base: list[dict[str, str]],
    phases: list[dict[str, str]],
    repairs: list[dict[str, str]],
    candidates: list[dict[str, str]],
) -> tuple[str, int]:
    phase_count = exact_prefix_count(current, base, phases)
    if phase_count is not None and phase_count < len(phases):
        return "phase", phase_count
    repair_count = exact_prefix_count(current, base + phases, repairs)
    if repair_count is not None and repair_count < len(repairs):
        return "repair", repair_count
    candidate_count = exact_prefix_count(
        current, base + phases + repairs, candidates
    )
    if candidate_count is not None:
        return "candidate", candidate_count
    raise ApplyError(
        "remote migration history is not an approved resumable state; "
        "refusing mutation"
    )


def load_contract() -> tuple[dict[str, Any], dict[str, Any]]:
    manifest = history.validate_manifest(history.load_json(str(MANIFEST_PATH)))
    history.validate_local_files(manifest, MIGRATIONS)
    plan = rehearsal.validate_phase_plan(
        json.loads(PLAN_PATH.read_text(encoding="utf-8")), manifest
    )
    rehearsal.validate_schema_canonicalization_evidence(
        json.loads(SCHEMA_EVIDENCE_PATH.read_text(encoding="utf-8")), plan
    )
    rehearsal.validate_deploy_bundle(
        build_bundle(manifest, plan, plan["phaseMigrations"], include_candidates=False),
        manifest,
        plan,
    )
    return manifest, plan


def build_bundle(
    manifest: dict[str, Any],
    plan: dict[str, Any],
    phases: list[dict[str, str]],
    *,
    include_candidates: bool,
) -> pathlib.Path:
    root = pathlib.Path(tempfile.mkdtemp(prefix="sidey-firebase-m0-"))
    supabase_dir = root / "supabase"
    migrations_dir = supabase_dir / "migrations"
    migrations_dir.mkdir(parents=True)
    shutil.copy2(CONFIG, supabase_dir / "config.toml")
    for item in manifest["productionCurrent"]:
        shutil.copy2(MIGRATIONS / item["filename"], migrations_dir / item["filename"])
    for item in phases:
        source = PRODUCTION_MIGRATIONS / item["filename"]
        if not source.is_file():
            raise ApplyError(f"missing production phase: {item['filename']}")
        shutil.copy2(source, migrations_dir / item["filename"])
    if include_candidates:
        for group in ("firebaseHistoricalRepairAllowlist", "firebaseCompatibilityCandidates"):
            for item in manifest[group]:
                shutil.copy2(MIGRATIONS / item["filename"], migrations_dir / item["filename"])
    return migrations_dir


def push(bundle: pathlib.Path, *, include_all: bool = False, dry_run: bool = False) -> None:
    command = [
        "supabase",
        "db",
        "push",
        "--project-ref",
        PROJECT_REF,
        "--workdir",
        str(bundle.parent.parent),
        "--skip-vault",
        "--yes",
    ]
    if include_all:
        command.append("--include-all")
    if dry_run:
        command.append("--dry-run")
    run(command)


def require_private_table_count(expected: int) -> None:
    rows = query(
        "select count(*)::integer as count "
        "from pg_class c join pg_namespace n on n.oid=c.relnamespace "
        "where n.nspname='private' and c.relkind in ('r','p') "
        "and c.relname like 'firebase_%'"
    )
    if len(rows) != 1 or rows[0].get("count") != expected:
        raise ApplyError(
            f"private Firebase table inventory mismatch: expected={expected} rows={rows}"
        )


def _advance_schema_lexical_state(
    line: str, state: str, dollar_tag: str, block_depth: int
) -> tuple[str, str, int]:
    """Track SQL lexical state without changing any schema-dump bytes."""
    index = 0
    while index < len(line):
        char = line[index]
        pair = line[index:index + 2]
        if state == "normal":
            if pair == "--":
                state = "line_comment"
                index += 2
                continue
            if pair == "/*":
                state = "block_comment"
                block_depth = 1
                index += 2
                continue
            if char == "'":
                state = "single"
                index += 1
                continue
            if char == '"':
                state = "double"
                index += 1
                continue
            if char == "$":
                match = re.match(r"\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$", line[index:])
                if match is not None:
                    dollar_tag = match.group(0)
                    state = "dollar"
                    index += len(dollar_tag)
                    continue
        elif state == "line_comment":
            if char in "\r\n":
                state = "normal"
        elif state == "block_comment":
            if pair == "/*":
                block_depth += 1
                index += 2
                continue
            if pair == "*/":
                block_depth -= 1
                index += 2
                if block_depth == 0:
                    state = "normal"
                continue
        elif state == "single":
            if pair == "''":
                index += 2
                continue
            if char == "'":
                state = "normal"
        elif state == "double":
            if pair == '""':
                index += 2
                continue
            if char == '"':
                state = "normal"
        elif state == "dollar" and line.startswith(dollar_tag, index):
            index += len(dollar_tag)
            dollar_tag = ""
            state = "normal"
            continue
        index += 1
    if state == "line_comment":
        state = "normal"
    return state, dollar_tag, block_depth


def canonicalize_schema_dump(raw: bytes, schema: dict[str, Any]) -> bytes:
    """Canonicalize only two approved CHECK spellings and top-level separators."""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ApplyError("schema dump is not UTF-8") from error

    catalog = schema.get("constraintCatalog")
    if not isinstance(catalog, list) or len(catalog) != 2:
        raise ApplyError("schema canonicalizer requires exactly two constraint rows")
    expected_identities = rehearsal.CANONICAL_CONSTRAINT_IDENTITIES
    for index, constraint in enumerate(catalog):
        identity = (
            constraint.get("schema"), constraint.get("table"), constraint.get("name")
        )
        if identity != expected_identities[index]:
            raise ApplyError("schema canonicalizer constraint identity drift")
        name = constraint["name"]
        variants = constraint.get("dumpVariants")
        if (
            not isinstance(variants, list)
            or len(variants) != 2
            or len(set(variants)) != 2
        ):
            raise ApplyError("schema canonicalizer constraint variant drift")
        marker = f'CONSTRAINT "{name}"'
        if text.count(marker) != 1:
            raise ApplyError(
                f"schema canonicalizer expected exactly one {name} constraint"
            )
        matches = [(variant, text.count(variant)) for variant in variants]
        if sum(count for _, count in matches) != 1 or any(count > 1 for _, count in matches):
            raise ApplyError(
                f"schema canonicalizer found an unapproved {name} definition"
            )
        matched = next(variant for variant, count in matches if count == 1)
        sentinel = f'    CONSTRAINT "{name}" SIDEY_CANONICAL_CHECK_V1,'
        text = text.replace(matched, sentinel, 1)

    output: list[str] = []
    pending_top_level_blank = False
    state = "normal"
    dollar_tag = ""
    block_depth = 0
    for line in text.splitlines(keepends=True):
        top_level_blank = state == "normal" and line.rstrip("\r\n") == ""
        if top_level_blank:
            pending_top_level_blank = True
            continue
        if pending_top_level_blank and output:
            output.append("\n")
        pending_top_level_blank = False
        output.append(line)
        state, dollar_tag, block_depth = _advance_schema_lexical_state(
            line, state, dollar_tag, block_depth
        )
    if state != "normal":
        raise ApplyError(f"unterminated schema dump lexical state: {state}")
    canonical = "".join(output)
    if not canonical.endswith(("\n", "\r")):
        canonical += "\n"
    return canonical.encode("utf-8")


TABLE_PRIVILEGES = {
    "DELETE", "INSERT", "MAINTAIN", "REFERENCES", "SELECT", "TRIGGER",
    "TRUNCATE", "UPDATE",
}
POSTGRES_MODERN_ACL = {
    (privilege, privilege in {"INSERT", "SELECT"})
    for privilege in TABLE_PRIVILEGES
}
POSTGRES_LEGACY_ACL = {(privilege, False) for privilege in TABLE_PRIVILEGES}


def _acl_map(rows: Any) -> dict[str, set[tuple[str, bool]]]:
    if not isinstance(rows, list):
        raise ApplyError("realtime ACL inventory is not an array")
    result: dict[str, set[tuple[str, bool]]] = {}
    for row in rows:
        if not isinstance(row, dict) or set(row) != {
            "grantee", "privilege", "grantable"
        }:
            raise ApplyError("realtime ACL inventory row shape drift")
        value = (row["privilege"], row["grantable"])
        if (
            not isinstance(row["grantee"], str)
            or row["privilege"] not in TABLE_PRIVILEGES
            or not isinstance(row["grantable"], bool)
            or value in result.setdefault(row["grantee"], set())
        ):
            raise ApplyError("realtime ACL inventory value drift")
        result[row["grantee"]].add(value)
    return result


def _validate_postgres_acl(privileges: set[tuple[str, bool]]) -> None:
    if frozenset(privileges) not in {
        frozenset(POSTGRES_LEGACY_ACL), frozenset(POSTGRES_MODERN_ACL)
    }:
        raise ApplyError("realtime postgres ACL is not an approved semantic variant")


def _stable_acl(rows: Any, *, parent: bool) -> list[dict[str, Any]]:
    acl = _acl_map(rows)
    expected_grantees = {
        "supabase_realtime_admin", "postgres", "dashboard_user"
    }
    if parent:
        expected_grantees.update({"anon", "authenticated", "service_role"})
    if set(acl) != expected_grantees:
        raise ApplyError(f"realtime ACL grantee drift: {sorted(acl)}")
    all_non_grantable = {(privilege, False) for privilege in TABLE_PRIVILEGES}
    for grantee in ("supabase_realtime_admin", "dashboard_user"):
        if acl[grantee] != all_non_grantable:
            raise ApplyError(f"realtime {grantee} ACL drift")
    if parent:
        customer = {(privilege, False) for privilege in {"INSERT", "SELECT", "UPDATE"}}
        for grantee in ("anon", "authenticated", "service_role"):
            if acl[grantee] != customer:
                raise ApplyError(f"realtime {grantee} ACL drift")
    _validate_postgres_acl(acl["postgres"])
    return sorted(
        [
            {
                "grantee": grantee,
                "privilege": privilege,
                "grantable": grantable,
            }
            for grantee, privileges in acl.items()
            if grantee != "postgres"
            for privilege, grantable in privileges
        ],
        key=lambda row: (row["grantee"], row["privilege"], row["grantable"]),
    )


def validate_realtime_contract_snapshot(
    snapshot: Any, expected_stable_sha256: str | None
) -> dict[str, Any]:
    if not isinstance(snapshot, dict) or set(snapshot) != {
        "utcToday", "parent", "policies", "routines", "children"
    }:
        raise ApplyError("realtime contract snapshot shape drift")
    parent = snapshot["parent"]
    if not isinstance(parent, dict) or "acl" not in parent:
        raise ApplyError("realtime parent inventory is missing")
    stable_parent = dict(parent)
    stable_parent["acl"] = _stable_acl(parent["acl"], parent=True)
    stable = {
        "parent": stable_parent,
        "policies": snapshot["policies"],
        "routines": snapshot["routines"],
    }
    stable_payload = json.dumps(
        stable, ensure_ascii=True, sort_keys=True, separators=(",", ":")
    ).encode("utf-8") + b"\n"
    stable_sha256 = hashlib.sha256(stable_payload).hexdigest()
    if (
        expected_stable_sha256 is not None
        and stable_sha256 != expected_stable_sha256
    ):
        raise ApplyError("realtime stable contract drift")

    try:
        today = datetime.date.fromisoformat(snapshot["utcToday"])
    except (TypeError, ValueError) as error:
        raise ApplyError("realtime snapshot UTC date is invalid") from error
    children = snapshot["children"]
    if not isinstance(children, list) or len(children) != 7:
        raise ApplyError("realtime partition count must be exactly seven")
    parsed: list[tuple[datetime.date, dict[str, Any]]] = []
    for child in children:
        if not isinstance(child, dict):
            raise ApplyError("realtime partition row shape drift")
        name = child.get("name")
        match = re.fullmatch(r"messages_(\d{4})_(\d{2})_(\d{2})", str(name))
        if match is None:
            raise ApplyError("realtime partition name drift")
        try:
            lower = datetime.date(*(int(value) for value in match.groups()))
        except ValueError as error:
            raise ApplyError("realtime partition date drift") from error
        upper = lower + datetime.timedelta(days=1)
        expected_bound = (
            f"FOR VALUES FROM ('{lower.isoformat()} 00:00:00') "
            f"TO ('{upper.isoformat()} 00:00:00')"
        )
        if child.get("bound") != expected_bound:
            raise ApplyError("realtime partition bound/name drift")
        if (
            child.get("owner") != "supabase_realtime_admin"
            or child.get("relkind") != "r"
            or child.get("isPartition") is not True
            or child.get("columns") != parent.get("columns")
        ):
            raise ApplyError("realtime partition structure drift")
        constraints = child.get("constraints")
        expected_constraints = [
            {
                "name": f"{name}_pkey",
                "type": "p",
                "validated": True,
                "definition": "PRIMARY KEY (id, inserted_at)",
            },
            {
                "name": "messages_payload_exclusive",
                "type": "c",
                "validated": True,
                "definition": "CHECK (payload IS NULL OR binary_payload IS NULL)",
            },
        ]
        if not isinstance(constraints, list) or sorted(
            constraints, key=lambda item: item.get("name", "")
        ) != sorted(expected_constraints, key=lambda item: item["name"]):
            raise ApplyError("realtime partition constraint drift")
        expected_indexes = [
            {
                "name": f"{name}_inserted_at_topic_idx",
                "valid": True,
                "ready": True,
                "unique": False,
                "primary": False,
                "definition": (
                    f"CREATE INDEX {name}_inserted_at_topic_idx ON realtime.{name} "
                    "USING btree (inserted_at DESC, topic) WHERE "
                    "((extension = 'broadcast'::text) AND (private IS TRUE))"
                ),
                "parentIndex": "messages_inserted_at_topic_index",
            },
            {
                "name": f"{name}_pkey",
                "valid": True,
                "ready": True,
                "unique": True,
                "primary": True,
                "definition": (
                    f"CREATE UNIQUE INDEX {name}_pkey ON realtime.{name} "
                    "USING btree (id, inserted_at)"
                ),
                "parentIndex": "messages_pkey",
            },
        ]
        indexes = child.get("indexes")
        if not isinstance(indexes, list) or sorted(
            indexes, key=lambda item: item.get("name", "")
        ) != sorted(expected_indexes, key=lambda item: item["name"]):
            raise ApplyError("realtime partition index drift")
        _stable_acl(child.get("acl"), parent=False)
        parsed.append((lower, child))
    dates = sorted(date for date, _ in parsed)
    if dates != [dates[0] + datetime.timedelta(days=index) for index in range(7)]:
        raise ApplyError("realtime partition range is not continuous")
    if today not in dates or today + datetime.timedelta(days=1) not in dates:
        raise ApplyError("realtime partitions do not cover UTC today and tomorrow")
    return stable


def realtime_contract_snapshot(expected_stable_sha256: str) -> dict[str, Any]:
    rows = query(REALTIME_CONTRACT_SQL)
    if len(rows) != 1 or set(rows[0]) != {"contract"}:
        raise ApplyError("realtime contract query returned an unexpected shape")
    return validate_realtime_contract_snapshot(
        rows[0]["contract"], expected_stable_sha256
    )


def schema_fingerprint(canonical_dump: bytes, realtime_contract: dict[str, Any]) -> str:
    contract = json.dumps(
        realtime_contract, ensure_ascii=True, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    payload = canonical_dump + b"\nSIDEY_REALTIME_CONTRACT_V2\n" + contract + b"\n"
    return hashlib.sha256(payload).hexdigest()


def verify_schema_catalog(schema: dict[str, Any]) -> None:
    rows = query(
        "select n.nspname as schema_name, c.relname as table_name, "
        "con.conname as name, con.contype as type, con.convalidated as validated, "
        "con.condeferrable as deferrable, con.condeferred as deferred, "
        "con.connoinherit as no_inherit, "
        "pg_get_constraintdef(con.oid,true) as definition "
        "from pg_constraint con join pg_class c on c.oid=con.conrelid "
        "join pg_namespace n on n.oid=c.relnamespace "
        "where (n.nspname,c.relname,con.conname) in "
        "(('private','app_store_transactions','app_store_transactions_id_length'),"
        "('private','commerce_payments','commerce_payments_portone_fields')) "
        "order by n.nspname,c.relname,con.conname"
    )
    expected = [
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
    if rows != expected:
        raise ApplyError(f"schema constraint catalog drift: {rows}")

    enum_rows = query(
        "select e.enumlabel as label from pg_type t "
        "join pg_namespace n on n.oid=t.typnamespace "
        "join pg_enum e on e.enumtypid=t.oid "
        "where n.nspname='auth' and t.typname='factor_type' "
        "order by e.enumsortorder"
    )
    expected_enum = [{"label": label} for label in schema["authFactorType"]]
    if enum_rows != expected_enum:
        raise ApplyError(f"auth.factor_type enum order drift: {enum_rows}")


def remote_schema_sha256(plan: dict[str, Any], schema: dict[str, Any]) -> str:
    try:
        linked = LINKED_PROJECT_REF.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise ApplyError("Supabase checkout is not linked to production") from error
    if linked != PROJECT_REF:
        raise ApplyError("Supabase checkout is linked to the wrong project")
    with tempfile.TemporaryDirectory(prefix="sidey-firebase-schema-") as directory:
        dump = pathlib.Path(directory) / "schema.sql"
        run(
            [
                "supabase",
                "db",
                "dump",
                "--linked",
                "--workdir",
                str(ROOT),
                "--schema",
                "public,private,auth",
                "--file",
                str(dump),
            ],
            timeout_seconds=660,
        )
        canonical = canonicalize_schema_dump(dump.read_bytes(), schema)
        realtime_contract = realtime_contract_snapshot(
            schema["realtimeContractSha256"]
        )
        return schema_fingerprint(canonical, realtime_contract)


def verify_schema(plan: dict[str, Any], schema_key: str) -> None:
    schema = plan[schema_key]
    require_private_table_count(schema["objectCount"])
    verify_schema_catalog(schema)
    actual_sha = remote_schema_sha256(plan, schema)
    expected_shas = [schema["sha256"]]
    atomic_runner_sha = schema.get("atomicRunnerSha256")
    if atomic_runner_sha is not None:
        expected_shas.append(atomic_runner_sha)
    if actual_sha not in expected_shas:
        raise ApplyError(
            f"remote {schema_key} fingerprint mismatch: "
            f"expected={expected_shas} actual={actual_sha}"
        )


def verify_schema_variants(
    plan: dict[str, Any], schema_keys: tuple[str, ...]
) -> str:
    if not schema_keys:
        raise ApplyError("resume schema variant set must not be empty")
    schemas = [plan[key] for key in schema_keys]
    first = schemas[0]
    invariant_keys = (
        "objectCount",
        "realtimeContractSha256",
        "constraintCatalog",
        "authFactorType",
    )
    if any(
        any(schema[key] != first[key] for key in invariant_keys)
        for schema in schemas[1:]
    ):
        raise ApplyError("resume schema variants do not share exact invariants")
    require_private_table_count(first["objectCount"])
    verify_schema_catalog(first)
    actual_sha = remote_schema_sha256(plan, first)
    expected: list[tuple[str, str]] = []
    for key, schema in zip(schema_keys, schemas, strict=True):
        expected.append((key, schema["sha256"]))
        atomic_runner_sha = schema.get("atomicRunnerSha256")
        if atomic_runner_sha is not None:
            expected.append((key, atomic_runner_sha))
    for key, expected_sha in expected:
        if actual_sha == expected_sha:
            return key
    raise ApplyError(
        "remote resume schema fingerprint mismatch: "
        f"expected={expected} actual={actual_sha}"
    )


def backfill_sequences(batch_rooms: int) -> None:
    while True:
        rows = query(
            "select room_count, message_count, remaining_rooms "
            f"from private.backfill_firebase_message_sequences({batch_rooms})",
            timeout_seconds=660,
        )
        if len(rows) != 1:
            raise ApplyError("message sequence backfill returned an unexpected row count")
        result = rows[0]
        remaining = result.get("remaining_rooms")
        print(
            "firebase M0 backfill: "
            f"rooms={result.get('room_count')} messages={result.get('message_count')} "
            f"remaining={remaining}",
            flush=True,
        )
        if remaining == 0:
            return
        if not isinstance(remaining, int) or remaining < 0:
            raise ApplyError("message sequence backfill returned invalid remaining_rooms")


def verify_sequence_backfill_complete() -> None:
    rows = query(
        "select "
        "count(*) filter (where sequence is null)::integer as null_sequences, "
        "count(*) filter (where sequence < 1 or sequence > 9007199254740991)::integer "
        "as invalid_sequences, "
        "count(distinct room_id) filter (where sequence is null)::integer "
        "as remaining_rooms from public.messages"
    )
    expected = [{
        "null_sequences": 0,
        "invalid_sequences": 0,
        "remaining_rooms": 0,
    }]
    if rows != expected:
        raise ApplyError(f"message sequence backfill is incomplete: {rows}")


def verify_ready(plan: dict[str, Any], *, schema_key: str) -> None:
    verify_schema(plan, schema_key)
    rows = query(
        "select "
        "count(*) filter (where sequence is null)::integer as null_sequences, "
        "count(*) filter (where sequence < 1 or sequence > 9007199254740991)::integer "
        "as invalid_sequences, "
        "(select indisvalid and indisready from pg_index where indexrelid="
        "'public.messages_room_sequence_unique'::regclass) as index_ready "
        "from public.messages"
    )
    if rows != [{"null_sequences": 0, "invalid_sequences": 0, "index_ready": True}]:
        raise ApplyError(f"message sequence finalize read-back failed: {rows}")
    verify_safe_rollout_state()


def verify_safe_rollout_state() -> None:
    config = query(
        "select enabled, direct_events_enabled from private.firebase_live_config"
    )
    if config != [{"enabled": False, "direct_events_enabled": False}]:
        raise ApplyError(f"live dispatch is not safely OFF: {config}")

    dispatch = query(
        "select not enabled as disabled, owner_run_id is null as owner_clear, "
        "run_deadline_at is null as deadline_clear, edge_region is null as edge_clear, "
        "(to_jsonb(config)->>'publisher_url') is null as publisher_clear "
        "from private.firebase_live_dispatch_config as config where id"
    )
    expected_dispatch = [{
        "disabled": True,
        "owner_clear": True,
        "deadline_clear": True,
        "edge_clear": True,
        "publisher_clear": True,
    }]
    if dispatch != expected_dispatch:
        raise ApplyError(f"live dispatch singleton is not safely empty: {dispatch}")

    access = query(
        "select wake_url is null as wake_clear "
        "from private.firebase_access_dispatch where singleton"
    )
    if access != [{"wake_clear": True}]:
        raise ApplyError(f"access dispatch wake URL is not safely empty: {access}")

    cohorts = query(
        "select "
        "(select count(*)::integer from private.firebase_shadow_users "
        " where enabled) as shadow_users, "
        "(select count(*)::integer from private.firebase_live_users "
        " where enabled) as live_users, "
        "(select count(*)::integer from private.firebase_live_rooms "
        " where enabled) as live_rooms"
    )
    expected_cohorts = [{"shadow_users": 0, "live_users": 0, "live_rooms": 0}]
    if cohorts != expected_cohorts:
        raise ApplyError(f"Firebase live/shadow cohort is not empty: {cohorts}")


def apply(args: argparse.Namespace) -> None:
    if not args.execute_production or args.project_ref != PROJECT_REF:
        raise ApplyError(
            "refusing production mutation without --execute-production and exact project ref"
        )
    require_pinned_cli()
    manifest, plan = load_contract()
    base = entries(manifest["productionCurrent"])
    phases = entries(plan["phaseMigrations"])
    repairs = entries(manifest["firebaseHistoricalRepairAllowlist"])
    candidates = entries(manifest["firebaseCompatibilityCandidates"])
    current = remote_history()
    # Prove history is an approved exact prefix before touching even our
    # reserved recovery helper. Unknown history must be a zero-mutation abort.
    resume_kind, resume_count = approved_resume_state(
        current, base, phases, repairs, candidates
    )
    # A migration-history prefix does not prove that the corresponding schema
    # is intact. Only explicitly pinned phase resume points may proceed, and
    # their full app+Realtime fingerprint is checked before helper cleanup or
    # any other remote mutation. Each reviewed checkpoint permits exactly the
    # clean schema or that schema plus this runner's exact crash-leftover helper.
    if resume_kind == "phase":
        if resume_count == 0:
            verify_schema(plan, "baseSchema")
        elif resume_count == plan["prefix13Schema"]["phaseCount"]:
            verify_schema(plan, "prefix13Schema")
            verify_safe_rollout_state()
        elif resume_count == plan["prefix16Schema"]["phaseCount"]:
            verify_schema_variants(
                plan, ("prefix16Schema", "prefix16IndexSchema")
            )
            verify_safe_rollout_state()
        elif resume_count == plan["prefix17Schema"]["phaseCount"]:
            verify_schema(plan, "prefix17Schema")
            verify_sequence_backfill_complete()
            verify_safe_rollout_state()
        else:
            raise ApplyError(
                "phase history is an exact prefix but has no pinned schema "
                "resume checkpoint; refusing mutation"
            )
    # Customer accounts and commerce ownership outrank the Firebase transport
    # migration. Keep only DB-side hashes in memory: catalog/config are exact,
    # while existing ledger/account fingerprints must remain a subset so live
    # purchases may append rows without masking deletion or immutable drift.
    commerce_before = commerce_critical_snapshot()
    # A process may stop after the last atomic call but before helper cleanup.
    # Remove it only if its owner, body, security settings and ACL are exactly
    # the implementation embedded in this runner.
    cleanup_atomic_runner()

    prepare_index = next(
        index for index, item in enumerate(phases) if item["version"] == PREPARE_VERSION
    )
    index_position = next(
        index for index, item in enumerate(phases)
        if item["version"] == CONCURRENT_INDEX_VERSION
    )
    if index_position != prepare_index + 1:
        raise ApplyError("concurrent index must immediately follow sequence prepare")
    phase_prefix_count = exact_prefix_count(current, base, phases)
    expected_complete = sorted(
        base + phases + repairs + candidates, key=lambda item: item["version"]
    )

    if phase_prefix_count is not None:
        for index in range(phase_prefix_count, len(phases)):
            item = plan["phaseMigrations"][index]
            if index == index_position:
                # Each backfill RPC call commits independently. Re-running after
                # interruption is bounded and resumes only remaining rooms.
                backfill_sequences(args.batch_rooms)
                ensure_concurrent_message_index()
                # CONCURRENTLY cannot share a transaction with migration history.
                # Exact definition/validity read-back above makes this one gap
                # safely repairable after create-success/history-loss.
                record_concurrent_index_history(item["version"], item["name"])
            else:
                apply_atomic_migration(
                    PRODUCTION_MIGRATIONS / item["filename"],
                    item["version"],
                    item["name"],
                )
            current = remote_history()
            expected_prefix = sorted(
                base + phases[: index + 1], key=lambda entry: entry["version"]
            )
            if current != expected_prefix:
                raise ApplyError(
                    f"phase history read-back failed after {item['version']}"
                )
        cleanup_atomic_runner()

    repair_prefix_count = exact_prefix_count(current, base + phases, repairs)
    if repair_prefix_count is not None and repair_prefix_count < len(repairs):
        verify_ready(plan, schema_key="readySchema")
        run(
            [
                "supabase",
                "migration",
                "repair",
                "--project-ref",
                PROJECT_REF,
                "--status",
                "applied",
                *[
                    item["version"]
                    for item in manifest["firebaseHistoricalRepairAllowlist"][
                        repair_prefix_count:
                    ]
                ],
            ]
        )
        current = remote_history()

    candidate_prefix_count = exact_prefix_count(
        current, base + phases + repairs, candidates
    )
    if candidate_prefix_count is not None and candidate_prefix_count < len(candidates):
        if candidate_prefix_count == 0:
            verify_ready(plan, schema_key="readySchema")
        for index in range(candidate_prefix_count, len(candidates)):
            item = manifest["firebaseCompatibilityCandidates"][index]
            apply_atomic_migration(
                MIGRATIONS / item["filename"], item["version"], item["name"]
            )
            current = remote_history()
            expected_candidate_prefix = sorted(
                base + phases + repairs + candidates[: index + 1],
                key=lambda entry: entry["version"],
            )
            if current != expected_candidate_prefix:
                raise ApplyError(
                    f"candidate history read-back failed after {item['version']}"
                )

    cleanup_atomic_runner()

    if current != expected_complete:
        raise ApplyError(
            "remote migration history is not an approved resumable state; refusing mutation"
        )

    verify_ready(plan, schema_key="finalSchema")
    verify_wire_code_contract()
    commerce_after = commerce_critical_snapshot()
    commerce_evidence = verify_commerce_critical_preserved(
        commerce_before, commerce_after
    )
    rollout = query(
        "select enabled, kill_switch, cohort_basis_points, protocol_version, "
        "contract_hash, cache_ttl_seconds "
        "from private.firebase_client_rollout_config where id"
    )
    expected_rollout = [{
        "enabled": False,
        "kill_switch": True,
        "cohort_basis_points": 0,
        "protocol_version": 2,
        "contract_hash": "3c836b40cfc44437e9d069b84787cd3d8793026ce40de46d82b9ece79127b7e5",
        "cache_ttl_seconds": 300,
    }]
    if rollout != expected_rollout:
        raise ApplyError(f"rollout selector did not fail closed: {rollout}")
    print(
        "commerce/auth preservation verified; "
        + " ".join(
            f"{name}={delta:+d}"
            for name, delta in sorted(commerce_evidence["deltas"].items())
        )
        + " equipped_state_changed="
        + str(commerce_evidence["equippedStateChanged"]).lower()
    )
    print("firebase M0 production apply verified; client rollout remains OFF")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute-production", action="store_true")
    parser.add_argument("--project-ref", required=True)
    parser.add_argument("--batch-rooms", type=int, default=25)
    args = parser.parse_args(argv)
    if args.batch_rooms < 1 or args.batch_rooms > 100:
        parser.error("--batch-rooms must be between 1 and 100")
    return args


def main(argv: list[str] | None = None) -> int:
    try:
        apply(parse_args(argv))
    except (ApplyError, history.VerificationError, rehearsal.RehearsalError) as error:
        print(f"firebase M0 production apply failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
