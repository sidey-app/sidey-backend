# Client/backend handoff pre-M0 draft

상태: **SUPERSEDED — historical pre-M0 record**
기준일: 2026-09-22

Supabase production M0와 Firebase publication이 완료됐으므로 현재 계약은
`CLIENT_BACKEND_HANDOFF.md`가 유일한 client/backend handoff다. 아래 내용은 partial migration과 독립 검토가
진행 중이던 당시의 판단·재개 조건을 보존한 기록이며 현재 production 상태나 실행 지침으로 사용하면 안 된다.

## 당시 gate snapshot

| 구성 | 상태 |
| --- | --- |
| Firebase `sidey-realtime` Gate 1 | Functions 9 ACTIVE, Rules/read-back/10-user smoke PASS |
| Supabase staging | Firebase migration 21개 적용 |
| Supabase production | production phase 16/26 적용, sequence bounded backfill remaining rooms 93에서 resume 보류 |
| compatibility migrations `20260921102516`, `20260921110000`, `20260921132018`, `20260921133000`, `20260921133500` | local candidate, 미배포 |
| changed `bootstrapRealtime` grant barrier | local candidate, 미배포 |
| client release | 미실행 |

Gate 1 deployed fixture는 `firebase/contract-v2.gate1-deployed.fixture.json`이며 SHA-256은
`4785705721e971ae463a5692bc80cadc7ff49ed0e20aab495dc1b0d6be0619d0`이다. 확장된 M0/client candidate는
`firebase/contract-v2.fixture.json`이며 현재 SHA-256은
`3c836b40cfc44437e9d069b84787cd3d8793026ce40de46d82b9ece79127b7e5`다. 후자는 M0 전까지 동결값이 아니다.

## 구현 가능한 고정 경계

- RTDB URL: `https://sidey.asia-southeast1.firebasedatabase.app`
- region: `asia-southeast1`
- bootstrap HTTPS function: `bootstrapRealtime`
- chat callable: `sendRealtimeChat`
- active listener: `/v2/l/{activeRoomId}` 한 개
- inbox listener: `/v2/n/{uid}` 한 개
- Presence: 기존 Supabase Realtime socket의 private topic
  `presence:{roomId}:{realtimeEpoch}:{targetUserId}`
- mixed-version typing/pulse/throw: 기존 authenticated Supabase RPC와 private Broadcast를 공용 plane으로
  사용한다. compact `/v2/l/{room}/t|c|x` client write는 Rules에서 금지하며 수신도 무시한다.
  staging-only `/v2/rooms/.../events` outbox는 compact `/v2/l` client 계약이 아니다.
- Supabase가 durable source of truth다. 호환 기간의 typing/pulse/throw delivery는 Supabase가 맡고,
  Firebase compact 경로는 server-only chat event와 access/room/chat hint만 전달한다.

## 아직 live integration에 사용하면 안 되는 항목

- `bootstrapRealtime.minimumAccessRevision`과 응답 `accessRevision`/`wireItems`
- `create_room_v2`, `join_room_v2`, `set_equipped_cosmetic_v2`
- `current_firebase_access_revision`, `get_store_state_v2.wireCode`

이 항목은 local test는 통과했지만 Firebase production 및 Supabase production에 각각 배포되지 않았다.
클라이언트는 interface/fake/unit test까지 구현할 수 있으나 production feature flag를 켜면 안 된다.

## client 핵심 semantics

- Firebase custom token 교환과 ID token refresh는 Firebase Auth SDK가 소유한다. 별도로 client는
  `refreshAfter`에 selector와 bootstrap을 재호출해 최대 300초 `sideyRolloutUntil` lease를 갱신한다.
  OFF/non-selected/stale capability는 bootstrap에서 거부되고, cohort/session 제거는 lease 만료 후
  최대 300초 안에 RTDB Rules가 거부한다. 전역 emergency kill은 별도 `/v2/a/g/e` gate이며 false/누락 시
  Rules가 기존 listener를 즉시 끊고 bootstrap/chat도 매 요청 거부한다.
- Supabase logout/account/session switch는 Firebase listener/Auth/pending generation을 모두 폐기한다.
- access/room revision은 20자리 decimal string이며 lexical compare한다.
- permission denial은 fail-closed이며 legacy로 자동 downgrade하지 않는다.
- compact pulse/throw snapshot/high-water 규칙은 향후 별도 전환 gate용 예약 계약이다. 현재 client는
  `/v2/l/{room}/t|c|x`를 발행하거나 소비하지 않으며 Supabase Broadcast만 사용한다.
- chat transport/deadline/internal/unavailable은 commit-ambiguous다. 동일 UUID를 자동 재전송하지 말고
  Supabase 3일 history로 조정한다.
- throwable code는 `get_store_state_v2.wireCode`에서 읽고 RTDB `k`에는 decimal string으로 쓴다.
  `"0"`은 `patch_soft_ball`; unknown은 drop한다.
- bridge에는 runtime cutoff가 없다. 7일은 최소 관찰 기간이며 자동 종료 시점이 아니다. 활성 client
  capability 측정 또는 최소 버전 강제와 old↔new chat/typing/pulse/throw/Presence matrix PASS 전에는 legacy
  Broadcast 수신/발행을 제거하는 forward migration을 만들지 않는다.

## M0 전 차단

- production migration은 staging history 21개를 그대로 push하지 않는다. production 전용 26-phase atomic
  runner는 phase 16개까지 적용했다. 수정된 `realtime.messages`→`rooms`→auth dependency lock 순서로
  `20260921141300`을 적용한 뒤 sequence bounded backfill에서 client timeout이 발생했지만 read-only 확인상
  server는 마지막 25-room batch를 commit해 remaining rooms가 118→93으로 줄었다. prefix16 exact schema/OFF
  checkpoint와 backfill 전용 660초 client timeout, ambiguous-commit resume를 구현했다. concurrent index
  CREATE 성공/history 미기록과 history commit/응답 유실도 각각 prefix16 index-present와 prefix17 exact
  checkpoint로만 재개하며, prefix17에서는 `NULL sequence=0`, invalid sequence=0, remaining rooms=0을
  mutation 전에 추가 확인한다. 두 JIT full-data resume 모두 index 재생성 없이 commerce/auth preservation
  PASS다.
  이 변경의 새 aggregate를 독립 review하기 전 production resume는 금지다.
- changed Firebase Functions를 staging 배포/read-back하지 않았다.
- 3,000×600 추가 부하 시험은 사용자 결정에 따라 이 기능/호환 gate에서 제외했다.
- fresh production-shaped rehearsal, old-client PostgREST smoke, v2 backend unit/pgTAP/Rules는 PASS했다.
  production remote apply/deploy와 실제 mixed-version smoke/read-back이 남았다.

## 최종 handoff에서 추가할 값

- production migration version과 적용/read-back 시각
- frozen candidate fixture SHA-256과 production wire-code map
- deployed Firebase source revision
- production Presence/RLS와 RPC signature read-back
- feature flag 기본값, canary 범위, rollback 명령
- M0 monitoring 결과와 `T0` 미시작 확인
