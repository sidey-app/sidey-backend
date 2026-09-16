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

Remaining: phases 13–19. Production provider calls require deployment credentials;
local provider contracts use deterministic test doubles.
