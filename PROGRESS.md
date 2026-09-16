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

Remaining: phases 9–19. Production provider calls require deployment credentials;
local provider contracts use deterministic test doubles.
