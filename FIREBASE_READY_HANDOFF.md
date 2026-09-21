# Firebase Gate 1 handoff

상태: **NOT FIREBASE_READY — local candidate 검증 완료, remote 배포 미수행**
기준일: 2026-09-21
base commit: `d459dc4c50faa26caa5a56d78f18334b3752bc72`
branch: `shared/firebase-v2-production-rollout`
local implementation commit SHA: `2a98dcf8b8431d28cc2b870675f1d2312893dc67`

## 판정

Gate 1의 local implementation과 emulator 검증까지 완료했다. Firebase production deploy, 10명 staging smoke, 배포 후 Rules/Functions 재조회는 수행하지 않았다. 따라서 이 문서는 client handoff 승인서가 아니고 macOS/Windows live integration 시작 근거로 사용하면 안 된다.

## local candidate contract

- machine-readable fixture: `firebase/contract-v2.fixture.json`
- fixture SHA-256: `4785705721e971ae463a5692bc80cadc7ff49ed0e20aab495dc1b0d6be0619d0`
- Rules SHA-256: `46992380013bf1526532527e8680d09d412d5a2ae97017245bfbc50bb4e392e0`
- staging support migration SHA-256: `0f9b2a925cfe9c05c4b53dfbbabf09178f95eac639f27c9ab637b3efe7f04372`
- Firebase project: `sidey-realtime`
- RTDB instance/target: `sidey`
- database URL: `https://sidey.asia-southeast1.firebasedatabase.app`
- Functions codebase/region: `sidey-v2` / `asia-southeast1`
- App Check enforcement: OFF
- Presence: Supabase private Realtime only

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

Legacy `/v2/rooms`, `/v2/chat`, `/v2/access`, `/v2/internal`과 `/v2/r`은 client read/write가 모두 거부된다. `persistChatCommand`는 local export에서 제거돼 다음 Functions deploy 시 삭제 대상이다.

## local function target

다음 9개 export만 존재한다.

- `bootstrapRealtime`
- `reconcileRealtimeAccess`
- `retryRealtimeAccess`
- `retryRealtimeChat`
- `retryRealtimeRoomRevisions`
- `sendRealtimeChat`
- `syncRealtimeAccess`
- `syncRealtimeChat`
- `syncRealtimeRoomRevisions`

배포 config는 target 없는 default RTDB deploy를 허용하지 않는다.

```text
database:sidey
functions:sidey-v2
```

## 변경 요약

- RTDB Presence와 legacy RTDB chat command Rules/trigger 제거
- server mirror를 `/v2/a` 아래로 이동
- typing을 임의 connection ID에서 Firebase claim과 동일한 Supabase session UUID slot으로 변경
- active session source를 최대 128개까지 검증한 뒤 expiry/UUID 순으로 16개를 결정적으로 mirror해 17번째 session이 사용자 전체를 quarantine하지 않게 함
- session revoke typing slot을 durable cleanup marker로 exact 삭제
- room deletion tombstone 첫 delivery를 ACK하지 않고 90초 claim 뒤 두 번째 cleanup에서만 ACK해 60초 chat worker의 ambiguous publish를 최종 제거
- kick/leave/refund/session revoke/account suspend/global health expiry를 기존 token에서도 fail-closed 처리
- bootstrap limiter를 server-only `/v2/a/b`로 이동하고 account inactive cleanup 추가
- Functions package의 test/log/env/cache/node_modules 제외
- immediate chat 지연 로그에서 room/message identifier 제거
- `sidey` RTDB target과 `sidey-v2` Functions codebase 명시
- Windows canonical REST `.json?auth=`, SSE `put`/`patch`, safe 307 fixture 추가
- staging smoke를 exact staging Supabase ref + 명시적 10-user opt-in + Firebase Admin ADC로 제한하고, 생성 요청 전 journal·known UID Admin cleanup·Supabase/Firebase Auth/room/RTDB read-back을 구현
- service-role 전용 `firebase_delivery_status`/`firebase_finalize_deleted_delivery` forward migration을 추가해 test-owned access/room/chat outbox의 exact ACK를 확인하고, 삭제된 source만 transaction 안에서 queue tombstone까지 제거한 뒤 RTDB durable fence를 정리하도록 함

## test evidence

| 검증 | 결과 |
| --- | --- |
| Functions syntax/unit/embedded SQL/contract | PASS `57/57` |
| RTDB Rules emulator (`demo-sidey`) | PASS `11/11` |
| Edge protocol/load harness | PASS `402/402` |
| JSON config parse / `git diff --check` | PASS |
| full local migration reset + pgTAP | PASS `651/651` (22 files), Gate 1 service-role delivery-status migration 포함 |
| Gate 0 DB concurrency suites | PASS; Gate 1 delivery-status forward migration은 full migration reset + pgTAP에 포함 |
| 10명 staging smoke | NOT RUN — remote deploy와 mutation 승인 필요 |
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

## Rules audit

```json
{
  "score": 5,
  "summary": "Local candidate Rules는 server-only authority, per-request session/membership checks, exact owner slots, payload allowlists, revocation health와 room tombstone fence를 모두 적용하며 emulator에서 권한 회수와 abuse fixture를 통과했다.",
  "findings": []
}
```

이 score는 local candidate Rules에 대한 평가다. production에 같은 hash가 배포됐다는 뜻이 아니다. Admin SDK가 Rules를 우회하므로 Functions의 two-pass tombstone cleanup, Supabase claim invalidation, 90초 claim 대 60초 worker timeout 불변식도 함께 유지해야 한다. RTDB Rules 자체에는 child-count 연산이 없으므로 typing slot bound는 server-only 16-session mirror, exact claim 비교, durable revoke cleanup과 access-health fail-closed의 결합으로 보장한다.

## compatibility evidence

current private client repository `main` commit `135a354f57908cc6efc54dec53094d1f6b24151d`의 macOS/Windows source는 Firebase SDK, RTDB URL 또는 `/v2` 경로를 사용하지 않는다. 양 플랫폼은 현재 Supabase RPC/Broadcast/Presence만 사용한다. 따라서 Rules에서 legacy Firebase client 경로를 닫는 것이 현재 공개 client 동작을 깨뜨린다는 source evidence는 없다.

Supabase staging의 `/v2/rooms/{room}/epochs/{epoch}`, `/v2/access/{room}`, `/v2/leases` Edge 실험 모델은 이 contract에 포함하지 않는다. 기능 flag가 꺼진 상태를 유지하고 Gate 2에서 compatibility/migration 대상으로 검토한다.

## deploy 전 필수 조건

1. 변경을 검토해 유효한 shared commit으로 고정한다.
2. `/private/tmp/sidey-firebase-deployed-recovery/archives/`의 rollback archive를 휘발성 경로 밖의 접근 제한 artifact로 보존하고 SHA-256 `2247f646061a5322652433caef152dcb62037430efd376e2215133613df06178`을 재확인한다.
3. 배포 diff에서 `persistChatCommand` 삭제, 9개 유지 export, `database:sidey`, `functions:sidey-v2`만 표시되는지 확인한다.
4. Functions를 먼저 배포하고 bootstrap/access/chat worker가 `/v2/a,l,n`을 사용하는지 재조회한다.
5. Rules `469923...`을 `database:sidey`에 배포한다. `sidey-realtime-default-rtdb`는 조회·수정하지 않는다.
6. 배포 직후 Rules hash, 9개 Functions revision/config, 삭제된 legacy trigger와 App Check OFF를 read-back한다.
7. production Supabase는 건드리지 않고, 별도 staging DB mutation 승인 후 `20260921070000_firebase_delivery_status.sql`만 staging에 적용해 service-role exact outbox read-back/finalizer를 준비한다.
8. Firebase Admin ADC가 `sidey-realtime` Auth/RTDB의 exact test-owned UID/path만 정리할 수 있는지 확인한다.
9. exact staging config와 `SIDEY_FIREBASE_GATE1_SMOKE_APPROVED=10`을 사용해 10명 smoke를 한 번 실행한다. temporary Supabase/Firebase Auth와 room이 없고, exact access/room/chat outbox ACK 완료 후 queue tombstone과 RTDB `/v2/a|l|n` 잔여가 0인지 재조회한다.

## rollback

현재 rollback은 **자료 확보됨, 실행 미검증** 상태다.

- 이전 Functions archive SHA-256: `2247f646061a5322652433caef152dcb62037430efd376e2215133613df06178`
- 이전 Rules canonical SHA-256: `ed94e215cf305a0bbbfd6b9801b2c04ec7c20d6a8e529aa9bada2c3edccbe4e8`
- 현재 local 위치: `/private/tmp/sidey-firebase-deployed-recovery/`

rollback 시 exact 이전 Functions source를 `functions:sidey-v2`에 복원한 뒤 이전 Rules를 `database:sidey`에 복원하고 두 hash/revision을 재조회한다. 이 경로는 아직 휘발성이므로 durable artifact 보존 전 production deploy를 시작하면 안 된다. Supabase production mutation은 없으므로 DB rollback은 이 Gate에 없다.

## gate report

| 항목 | 결과 |
| --- | --- |
| 대상 환경 | local emulator; production target config only |
| 변경 파일·migration | Firebase Functions/Rules/config/tests/docs + staging smoke 지원용 forward migration 1; remote/production 적용 0 |
| remote mutation | 없음 |
| test | Functions 57 PASS, Rules 11 PASS, pgTAP 651 PASS, Edge harness 402 PASS |
| compatibility | current macOS/Windows Firebase usage 0; live smoke 미실행 |
| security | local Rules audit 5/5; revocation/A-B/tombstone PASS |
| cost | 측정 안 됨; `minInstances=0`, 사용자별 schedule 추가 없음 |
| cleanup | local Firebase emulator와 isolated Supabase stack 종료; remote temporary data 생성 안 함 |
| rollback | exact baseline hashes/source 확보, durable 보존·실행 검증 전 |
| 다음 gate | commit/rollback artifact 고정 후 staging support migration + Firebase deploy + 10명 smoke의 각각 별도 승인 |
