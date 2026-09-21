# Firebase Gate 1 handoff

상태: **FIREBASE_READY — Gate 1 PASS**
기준일: 2026-09-21
base commit: `d459dc4c50faa26caa5a56d78f18334b3752bc72`
branch: `shared/firebase-v2-production-rollout`
Firebase runtime 배포 source commit: `223b8c4`
최종 smoke source commit: `8633621`

## 판정

Firebase production Functions/Rules 배포, Supabase staging 전용 지원 migration, 10명 end-to-end smoke와 cleanup 후 외부 read-back을 완료했다. Gate 2 macOS client implementation/validation을 시작할 수 있다.

이 판정은 Firebase production과 Supabase **staging** 조합에 한정한다. Supabase production migration, client 변경, public release, store upload는 수행하지 않았다.

## deployed contract

- machine-readable fixture: `firebase/contract-v2.fixture.json`
- fixture SHA-256: `4785705721e971ae463a5692bc80cadc7ff49ed0e20aab495dc1b0d6be0619d0`
- local Rules raw SHA-256: `46992380013bf1526532527e8680d09d412d5a2ae97017245bfbc50bb4e392e0`
- local/remote Rules canonical SHA-256: `2bc71cbc8a6823816ce84d701be7ebc791319d291f7c13abd5544f047ed0d622` — exact match
- Firebase project: `sidey-realtime`
- active RTDB instance/target: `sidey`
- database URL: `https://sidey.asia-southeast1.firebasedatabase.app`
- disabled default RTDB: `sidey-realtime-default-rtdb`
- Functions codebase/region/runtime: `sidey-v2` / `asia-southeast1` / Node.js 22
- App Check: RTDB/Auth `UNENFORCED`; replay protection omitted, therefore default `OFF`
- Presence: Supabase private Realtime only

Firebase-generated `FIREBASE_CONFIG`에는 disabled default RTDB URL이 들어 있지만, application code는 `sidey` regional URL을 명시적으로 초기화한다. Smoke와 Admin read-back도 `sidey`만 사용했다.

### canonical paths

| path | ownership | purpose |
| --- | --- | --- |
| `/v2/a/s/v` | server only | global access health |
| `/v2/a/u/{uid}` | server only | account, rooms, entitlements, session expiry mirror |
| `/v2/a/d/{roomId}` | server only | permanent room deletion tombstone |
| `/v2/a/b/{uid}` | server only | bootstrap rate limiter |
| `/v2/l/{roomId}/t/{uid}/{sideySessionId}` | own session write, member read | typing timestamp |
| `/v2/l/{roomId}/c/{uid}` | own UID write, member read | pulse timestamp |
| `/v2/l/{roomId}/x/{uid}` | own UID write, member read | compact throw `{u,k,t}` |
| `/v2/l/{roomId}/e` | server write, member read | latest compact chat `{i,s,b,t,n,k?}` |
| `/v2/n/{uid}` | server write, owner read | access/room/chat hints |

Legacy `/v2/rooms`, `/v2/chat`, `/v2/access`, `/v2/internal`과 `/v2/r`은 client read/write가 모두 거부된다. `persistChatCommand`는 production에서 삭제됐고 재조회한 function 목록에도 없다.

## production Functions read-back

모든 function은 `ACTIVE`, `asia-southeast1`, Node.js 22, 256 MiB, `minInstances=0`이다.

| function | source generation | source hash | limit |
| --- | ---: | --- | --- |
| `bootstrapRealtime` | `1789975208595191` | `b9cb5669...` | max 10 / concurrency 20 |
| `reconcileRealtimeAccess` | `1789975260453676` | `b9cb5669...` | max 1 / concurrency 1 |
| `retryRealtimeAccess` | `1789975260488371` | `b9cb5669...` | max 1 / concurrency 1 |
| `retryRealtimeChat` | `1789975260906257` | `b9cb5669...` | max 1 / concurrency 1 |
| `retryRealtimeRoomRevisions` | `1789975260660227` | `b9cb5669...` | max 1 / concurrency 1 |
| `sendRealtimeChat` | `1789975260644163` | `b9cb5669...` | max 10 / concurrency 20 |
| `syncRealtimeAccess` | `1789975261304544` | `3f3ba81b...` | max 1 / concurrency 1 |
| `syncRealtimeChat` | `1789975260652664` | `3f3ba81b...` | max 1 / concurrency 1 |
| `syncRealtimeRoomRevisions` | `1789975260666845` | `3f3ba81b...` | max 1 / concurrency 1 |

두 source hash는 secret binding이 다른 endpoint 묶음에서 Firebase가 생성한 정상 결과다. 최종 wake read-back은 access/room/chat 모두 HTTP 200, claimed/delivered/failed `0`이었다.

## Supabase staging

대상 ref는 `fjglrvhvdthntkvrduyi`다. production Supabase는 수정하지 않았다.

적용한 forward-only migration:

| migration | SHA-256 | purpose |
| --- | --- | --- |
| `20260921070000_firebase_delivery_status.sql` | `0f9b2a925cfe9c05c4b53dfbbabf09178f95eac639f27c9ab637b3efe7f04372` | exact delivery status + deleted-source finalizer |
| `20260921070944_firebase_access_delivery_snapshot.sql` | `21efb70e01e60de88c20758b51f8f2ca83172875dd2209718efd549eff57bb28` | stale worker가 finalized access tombstone을 재생성하지 못하게 함 |

두 RPC는 `SECURITY DEFINER`, 빈 `search_path`, `service_role` 전용이며 `anon`/`authenticated` 실행 권한이 없다. 최종 security advisor는 ERROR 0이었다. 출력된 WARN은 기존에 의도적으로 authenticated에 공개된 SECURITY DEFINER RPC들뿐이고 새 Gate 1 RPC는 포함되지 않았다.

## 변경 요약

- RTDB Presence와 legacy RTDB chat command Rules/trigger 제거
- server mirror를 `/v2/a` 아래로 이동하고 session/membership/entitlement revocation을 fail-closed 처리
- typing을 Firebase claim과 같은 Supabase session UUID slot으로 고정
- active session source를 최대 128개 검증한 뒤 16개만 결정적으로 mirror
- room deletion을 90초 claim 뒤 두 번째 cleanup에서 ACK해 60초 chat worker의 ambiguous publish 제거
- compact chat/throw와 per-user inbox를 server-authoritative 경로로 제한
- bootstrap limiter를 server-only `/v2/a/b`로 이동
- account revoke 시 RTDB 부모/자식 multi-location delete 충돌을 coalesce
- finalizer와 stale delivery snapshot lock으로 cleanup 뒤 outbox 재생성 race 제거
- smoke PASS를 cleanup 완료 뒤에만 출력하고, worker wake timeout·재시도·3회 연속 zero-residual 확인 추가
- service role에도 금지된 table 직접 조회를 제거하고 database source 부재는 transaction finalizer가 검증

## test evidence

| 검증 | 결과 |
| --- | --- |
| Functions syntax/unit/embedded SQL/contract | PASS `66/66` |
| RTDB Rules emulator (`demo-sidey`) | PASS `11/11` |
| Edge protocol/load harness | PASS `402/402` |
| full local migration reset + pgTAP | PASS `654/654` (`22` files) |
| DB concurrency suites | PASS 전체 |
| Rules security audit | PASS `5/5` |
| staging security advisor | PASS, ERROR `0`; 기존 의도된 WARN만 존재 |
| 10명 staging smoke | PASS: callable chat sequence `1`, compact throw, exact 10-user auth/access/room cleanup |
| post-smoke worker wake | PASS: 3 endpoints HTTP `200`, pending/failed `0` |
| post-smoke DB read-back | PASS: access pending `0`, room pending `0` |
| post-smoke Rules read-back | PASS: canonical SHA-256 exact match |
| 3,000 connections, 600 seconds | NOT RUN; 기존 2,400 시험은 FAIL |

Rules emulator가 확인한 보안 fixture:

- invalid UID/session/membership/timestamp/payload/entitlement 거부
- 동일 UID A/B session이 각자 typing slot만 사용
- session A revoke 후 B read/write 유지
- account suspend 후 A/B 모두 거부
- kick 후 이미 열린 listener cancel 및 신규 write 거부
- refund 후 room read 유지, throw write 거부
- global access health expiry fail-closed
- stale membership이 남아도 room tombstone 뒤 read/write 거부
- 모든 legacy namespace와 server-owned event/access node client 거부

## smoke cleanup evidence

최종 성공 run은 임시 Supabase 사용자 10명, Firebase Auth 사용자 10명, 방 1개를 만들었다. 종료 전에 다음을 모두 확인했다.

- Supabase/Firebase Auth test UID 부재
- room source 및 RTDB live room 부재
- access 10건과 room 1건의 exact revision ACK
- chat publish/cleanup pending 0
- finalizer가 source 부재를 row lock 안에서 재확인한 뒤 exact queue tombstone 삭제
- exact `/v2/a/u`, `/v2/a/b`, `/v2/n`, `/v2/a/d`, `/v2/l` test paths 부재
- 10초 간격 zero-residual read-back 3회 연속 통과
- 별도 최종 wake 뒤 access/room/chat worker 모두 할 일 0

현재 `/v2` shallow root는 `a`, `access`, `internal`, `n`이다. `access`/`internal`은 기존 legacy data root이지만 production Rules가 client read/write를 거부한다.

비차단 staging hygiene debt: 이번 Gate 이전부터 존재한 source-absent·fully-settled access tombstone `72`건이 있다. 이번 smoke UID와 무관하고 pending은 `0`이며 deny-all 상태다. 과거 staging 데이터까지 무단 삭제하지 않았고 별도 정리 작업으로 남긴다.

## Rules audit

```json
{
  "score": 5,
  "summary": "Production Rules는 server-only authority, per-request session/membership checks, exact owner slots, payload allowlists, revocation health와 room tombstone fence를 적용하며 emulator와 production canonical hash read-back을 통과했다.",
  "findings": []
}
```

Admin SDK는 Rules를 우회하므로 Functions의 two-pass tombstone cleanup, Supabase claim invalidation, 90초 claim 대 60초 worker timeout 불변식도 함께 유지해야 한다. typing slot bound는 server-only 16-session mirror, exact claim 비교, durable revoke cleanup과 access-health fail-closed 결합으로 보장한다.

## rollback

rollback 자료는 durable user-only 경로에 보존했지만 실행 자체는 검증하지 않았다.

- Firebase baseline: `/Users/aryu/Library/Application Support/SIDEY/rollout-artifacts/firebase-v2/2026-09-21-pre-gate1`
- Supabase staging baseline: `/Users/aryu/Library/Application Support/SIDEY/rollout-artifacts/supabase-staging/2026-09-21-pre-gate1`
- directory permission: `0700`
- 이전 Functions archive SHA-256: `2247f646061a5322652433caef152dcb62037430efd376e2215133613df06178`
- 이전 Rules canonical SHA-256: `ed94e215cf305a0bbbfd6b9801b2c04ec7c20d6a8e529aa9bada2c3edccbe4e8`
- Supabase recovery artifact: `65`개 checksum 확인 완료

Firebase rollback은 exact 이전 Functions source를 `functions:sidey-v2`에 복원한 뒤 이전 Rules를 `database:sidey`에 복원하고 hash/generation을 다시 조회한다. Firebase deploy ZIP은 재패키징 시 byte-identical하지 않을 수 있으므로 runtime-equivalent source 기준이다. Supabase production mutation은 없어서 production DB rollback은 없다.

## gate report

| 항목 | 결과 |
| --- | --- |
| 대상 환경 | Firebase production + Supabase staging |
| remote mutation | Firebase Functions/Rules production, Supabase staging migration 2개 |
| production Supabase | 미변경 |
| function inventory | `9 ACTIVE`, legacy trigger `0` |
| test | Functions 66, Rules 11, pgTAP 654, Edge 402, concurrency PASS |
| smoke | exact 10-user PASS + cleanup + 3회 연속 zero-residual |
| security | Rules 5/5, remote hash match, advisor ERROR 0, App Check UNENFORCED |
| cost | `minInstances=0`, worker max 1, 사용자별 scheduler 없음; 3,000 동접 부하는 미검증 |
| cleanup | 이번 smoke exact residual 0; 기존 staging tombstone 72건 별도 debt |
| rollback | durable artifact 보존, 실행 미검증 |
| 다음 gate | Gate 2 macOS client implementation/validation. production Supabase와 release는 별도 승인 필요 |
