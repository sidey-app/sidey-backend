# One-shot migration

Build and apply Flyway to an empty target first. Stop **all source writes**,
including Edge Functions, payment webhooks and scheduled jobs, and keep the
target application stopped. Take and test a source backup before cutover.

Set `SIDEY_MIGRATION_OFFLINE=true`, a fixed UUID `SIDEY_MIGRATION_RUN_ID`, and
`SIDEY_MIGRATION_{SOURCE,TARGET}_{URL,USER,PASSWORD}`. URLs are JDBC PostgreSQL
URLs. Credentials are environment-only; use a source role that can read auth,
public and private tables (not a PostgREST key). Run
`sh scripts/migrate-legacy.sh > migration-report.json` after `./mvnw verify`.

The source snapshot is read-only/repeatable-read. All target inserts, validation
and completion marker commit in one transaction. A failed run rolls back. A
successful rerun with the same run UUID only returns its stored report; another
run UUID or nonempty target is rejected. This is an offline copy, not an online
synchronizer. Counts exclude expired messages and obsolete abuse windows.

Preserve the invite HMAC key separately: read `sidey_invite_pepper_v2` from the
source Vault with operations credentials, decode its hex value to bytes and
encode those same bytes as base64 for `SIDEY_INVITE_PEPPER`. Never print this
secret in a report. The importer copies hashes and cannot recover invitation
plaintext. Rooms still awaiting an old invite reissue remain without an invite.

No provider identity is inferred from email. Nonanonymous users lacking a
supported Google/Apple subject, unknown providers, invalid ownership or ledger
projection differences cause validation failure. Resolve those discrepancies
explicitly before retrying; the importer does not silently repair ownership.

Historical missing payment environment/balance remains NULL. Unattributable
old webhook records use `legacy_unknown` for audit, not for new processing.
Apple source references are namespaced by environment and transaction ID;
the original reference is retained in `legacy_source_reference`. Included-item
grant IDs, parent links and cutover timestamp are preserved, never regenerated
from today's catalog. Verify the report before enabling the target application.
