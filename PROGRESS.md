# Migration execution

Reference snapshots: SIDEY f939a9a, sidey-backend 6c31ef4.
Existing references remain unchanged until backend contract validation (phase 13).

| Phase | Implemented and committed | Verification |
| --- | --- | --- |
| 1 | Bootstrap: 1b1aefa, wrapper normalization 88968a1 | Maven build/test |
| 2 | Clean PostgreSQL schema/codegen: 48e1764 | PostgreSQL schema/commerce integrity tests |
| 3 | Identity, session rotation, legacy claim: ab8d5e5 | Auth/provider verifier and HTTP tests |
| 4 | Profile/equipment/tree CAS: bce3b22 | PostgreSQL profile tests |
| 5 | Room/invite/ownership lifecycle: f7c1c51 | Concurrent joins, owner mutations, deletion tests |
| 6 | Authenticated raw WebSocket, bounded delivery, membership cache | `./mvnw -q verify`: 40 tests, zero failures/errors/skips; source guardrails and diff check |

Resume audit confirmed phase 1–5 commits and existing passing reports. Phase 6
was incomplete: missing registry method, ambiguous test assertion and duplicate
Spring bean name were repaired. HTTP/WebSocket test exercises real handshake,
membership denial, subscription acknowledgement and logout socket termination.

Phase 7 complete: WS message command/ACK/publication, narrow membership locks,
same-UUID canonical retry/conflict, rate limit, cursor history and three-day pruning.
`./mvnw -q verify`: 45 tests passed; source guardrails and diff check passed.
Tests include concurrent same UUID, send-before-kick ordering, unrelated sender
progress, transaction rollback, lost response retry and 125-message pagination.

Phase 8 complete: subscribe-first recovery watermark, bounded cursor catch-up,
and concurrent commit ordering tests. `./mvnw -q verify`: 47 tests passed;
source guardrails and diff check passed. Normal sends retain shared concurrency;
only recovery checkpoint waits for in-flight room commits.

Phase 9 complete: per-connection presence/focus/heartbeat, multi-device aggregation,
typing leases, pulse/throw authorization, server-selected cosmetics and bounded
per-user transient rate windows. `./mvnw -q verify`: 50 tests passed; source
guardrails and diff check passed. Corrected earlier profile/message lookup using
`bubble_style` where the catalog domain kind is `bubble`; snapshot retry tested.

Phase 10 complete: offline streaming JDBC importer, atomic validation/report,
UUID/provider/anonymous mapping, retained messages, full commerce audit/source
ledger and Apple bindings, parent grants and historical cutover preservation.
Same run UUID returns its committed report; failed validation rolls back all data.
`./mvnw -q verify`: 51 tests passed including a real PostgreSQL legacy-shaped
fixture, intentional projection failure/rollback and successful rerun. Source
guardrails, shell syntax and diff check passed. Production import is not run.

Phase 11 complete: REST catalog/checkout/orders/completion, policy consent,
server-side PortOne requery and official SDK webhook verification, internal
idempotent refund/requery, source ledger and effective projection reconciliation.
`./mvnw -q verify`: 57 tests passed; source guardrails and diff check passed.
Tests cover concurrent completion/order rate limits, verification mismatches,
webhook hash conflicts, cancellation response loss, other active ownership
sources, historical inclusion snapshots and real HMAC verification/tampering.
Actual PortOne API requests remain deployment-credential-dependent.

Phase 12 complete: official Apple verification/API boundary, transactional submit/
restore/notification processing, environment-scoped IDs, preserved account binding,
offer inclusion snapshots, stale-state protection and historical signed-money
backfill. Added fresh Apple identity deletion and separate authorization revocation.
`./mvnw -q verify`: 67 tests passed; source guardrails and diff check passed.
Tests cover concurrent submission, account-token/binding conflicts, deletion restore,
stale refunds/money, notification replay/hash conflict, decoder normalization and
unsigned JWS rejection. Provider HTTP has bounded body/deadline tests. Real Apple
API/JWS/OCSP/revocation success remains credential-dependent. Corrected tests to
use a historical bundled guinea-pig offer; the current pig offer is solo.

Phase 13 complete: `./mvnw -q clean verify` passed 68 tests with zero failures,
errors or skips. Actual PostgreSQL schema/codegen, concurrency, migration,
HTTP/WS, provider contracts and cryptographic rejection tests ran. Source
guardrails and diff checks passed. Fixed uncertain after-commit cache authority,
offline-user profile publication, account-deletion room hints, connection capacity
race, request-body bounds and blocking socket timeout. Added session-expiry revoke.
Backend contract is ready for client migration. Existing reference repositories
remain unchanged (their pre-existing untracked exporter files are preserved).

Phase 14 complete: macOS migration in `macos/spring-backend-macos`, commit
42e652e. Replaced SDK/auth/transport with SIDEY sessions, provider login, secure
legacy claim, raw WS and subscribe-first cursor recovery. Both distributions
pass full Swift 6 strict source checks. Standalone actual-source auth/config,
transport, recovery and App Store HTTP contracts passed. Native wrapper validates
57 assets and 11 Python tests, then stops because this host has Command Line Tools
but no Xcode/XCTest. Native application build/runtime remains unverified.

Phase 15 complete: Windows migration in `windows/spring-backend-windows`, 7403392.
Google login, rotated SIDEY credentials/legacy claim, authenticated raw WS,
same-logical-UUID retry, cursor recovery and focused presence replaced Supabase.
Core 204, Presentation 150 and portable actual Infrastructure contract 50 tests
passed. Cross-target managed libraries and actual coordinator source compile.
Solution native build cannot execute Windows MakePri/mt on this macOS host;
WinUI runtime validation remains unverified. Full cross-target format passed.

Phase 16 complete: website checkout in `shared/spring-backend-web`, d4c7252.
REST checkout contract/CSP, fragment token scrubbing, server consent/amount,
provider-verified completion and privacy copy migrated. `pnpm --dir website test`
passed 27 tests; real Chrome desktop/mobile checkout and three privacy locales
passed deterministic-network browser checks. Server commit 6677e72 adds browser
contract and allowed/foreign-origin CORS tests (7 focused tests passed).

Phase 17 complete: macOS 0334fb3, Windows 6056ce0, shared docs 76d6ecf.
Removed unused SDK/Phoenix/epoch/RPC helpers, keeping only legacy ownership-proof
compatibility. Corrected Google-only account deletion in both Mac distributions;
added independent socket silence/write deadlines and App Store test target
coverage. Mac strict source checks passed both distributions; actual-source
standalone transport 14, recovery 10, domain/catalog/etc. 98 and App Store HTTP 8
checks passed. These are not native XCTest runs. Windows Core 201, Presentation
150, Infrastructure contracts 58, installer/language source checks 62 passed.
Windows format and managed compiler checks passed. Repository workflow checks
passed on each platform/shared snapshot; native platform gaps still apply.

Phase 18 complete: nerdctl image/run configuration, Nginx/tunnel/Prometheus
examples and fail-closed blue/green operator. Admission covers HTTP, WS and
maintenance; inactive processes cannot expire active-instance sessions. Drain
closes WS with 1012, waits for admitted work, and invalidates membership on
reactivation. Management metrics are loopback-listener-only. `./mvnw -q verify`
passed 72 tests; affected HTTP/WS/deployment tests passed again after adding
DB-backed readiness. Seven operator failure/response-loss tests and real local
Nginx syntax/REST/WS/private-route/log checks passed. Shell/source/diff checks
passed. Target Linux nerdctl/containerd image execution and existing host config
integration were not run on this macOS host.

Phase 19 complete within the available local environment: `./mvnw -q clean verify`
passed 73 tests, zero failures/errors/skips. The new real HTTP/JWT/WS/PostgreSQL
end-to-end journey exercises login/rotation, legacy ownership proof/UUID retention,
profile, room create/join, normal chat, lost ACK canonical retry/conflict,
subscribe-first live/cursor merge, multi-device presence, typing, kick denial,
owner leave/account-deletion succession, logout socket close and provider-verified
commerce entitlement. External identity/payment providers alone are deterministic
test doubles. Executable jar inspection confirms these doubles are not packaged.
Migration, concurrency, schema, cryptographic rejection and deployment tests are
included in the clean run. Source guards, deployment operator tests and diff checks
also passed. See VALIDATION.md for exact commands, branches and external gaps.

No production import, external payment, release upload, remote push/merge or
production cutover was performed. Native macOS/XCTest, WinUI execution and Linux
containerd deployment validation remain environment-dependent and are not claimed
as passing. Client branches remain separate pending their required native checks.
