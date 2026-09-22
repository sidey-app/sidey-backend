# Firebase Realtime wire contract

상태: **old production contract rollout OFF / transient bridge source candidate 미배포**
프로토콜 목표 버전: `2`

## 고정 전제

- RTDB instance: `sidey`
- URL: `https://sidey.asia-southeast1.firebasedatabase.app`
- Firebase project: `sidey-realtime`
- Presence: Supabase private Realtime Presence
- 식별자: canonical lowercase UUID
- revision/sequence: JavaScript safe integer 범위를 넘기지 않으며, 정밀도 보존이 필요한 DB 값은 decimal string으로 전달
- 모호한 transient write 응답은 즉시 재시도하지 않음

## 목표 namespace

| 경로 | 소유자 | 의미 |
| --- | --- | --- |
| `/v2/a` | server only | access/session/membership mirror와 revocation fence |
| `/v2/l/{roomId}` | room member read; t/c/x는 제한된 client write, e는 server write | active room의 compact transient slot `t/c/x`와 최신 chat event `e` |
| `/v2/n/{userId}` | 해당 사용자 read, server write | access, room revision, chat sequence hint |

클라이언트 read는 유효한 Supabase session claim, active account, room membership, 최신 global access health를
모두 만족해야 한다. t/c/x write는 자기 UID/current session slot, room/target membership, entitlement,
gate/lease/access health와 각 cooldown을 만족할 때만 허용한다.

### server-only access layout

| 경로 | 의미 |
| --- | --- |
| `/v2/a/s/v` | access worker global health deadline (epoch milliseconds) |
| `/v2/a/u/{uid}` | revision, active, rooms, wire items, 최대 16개 active session expiry |
| `/v2/a/d/{roomId}` | 영구 room deletion tombstone revision |
| `/v2/a/b/{uid}` | bootstrap rate-limit window; account 비활성화 시 제거 |

`/v2/a` 전체는 Rules에서 client read/write가 모두 거부된다. room UUID는 재사용하지 않는다.
Supabase Auth가 16개를 초과하는 active session을 일시적으로 반환하면 Functions는 expiry 내림차순,
UUID 오름차순으로 16개만 결정적으로 mirror한다. 제외된 session은 fail-closed이며, source-side session
lifecycle/상한은 Gate 2 migration에서 확정한다. session revoke는 access mirror 안의 durable
`cleanup_sessions` marker가 해당 session의 모든 기존 room typing slot을 제거한 뒤에만 ACK된다.

### compact client payload

| 경로 | payload | 제약 |
| --- | --- | --- |
| `/v2/l/{rid}/t/{uid}/{sideySessionId}` | epoch millisecond number | 자기 exact session slot; 1500ms cooldown; delete는 exact cleanup 허용 |
| `/v2/l/{rid}/c/{uid}` | epoch millisecond number | 자기 UID; 1000ms cooldown |
| `/v2/l/{rid}/x/{uid}` | `{u, k, t}` | 자기 UID; target member와 wire entitlement; 500ms cooldown |
| `/v2/l/{rid}/e` | `{i, s, b, t, n, k?}` | server-only latest chat event |
| `/v2/n/{uid}/a` | 20자리 decimal revision string | server-only access hint |
| `/v2/n/{uid}/r/{rid}/v` | 20자리 decimal revision string | server-only room hint |
| `/v2/n/{uid}/r/{rid}/n` | positive safe integer | server-only chat sequence hint |

Gate 1에 실제 배포된 byte-identical fixture는
`firebase/contract-v2.gate1-deployed.fixture.json`에 보존한다. M0/client production candidate 계약은
`firebase/contract-v2.fixture.json`에 두며, Firebase Gate 1·Supabase staging·Supabase production·client
release 상태를 서로 분리한다.

현재 source candidate fixture SHA-256은
`0f2845d033df248b1745c6526c8c7100b8d8fa6839b45f28c73b1023053fce2e`다. production에는 old hash가
남아 있고 selector/gate는 OFF다. 배포는 old gate/selector OFF read-back 유지 → forward migration →
Functions/Rules → exact read-back → selector ON → Firebase gate true 순서만 허용한다.

## Bootstrap과 grant convergence

- `bootstrapRealtime`은 Supabase Bearer token을 받는 `POST` endpoint다. 빈 body와 `{}`는 기존
  client 호환을 위해 허용한다.
- 선택적인 `minimumAccessRevision`은 정확히 20자리 decimal string이다. unknown key, 숫자형 revision,
  잘못된 길이는 `400 invalid_argument`다.
- source revision이 요청 revision보다 작으면 `409 realtime_grant_not_converged`다. 이때 listener나
  throwable write를 열지 않는다.
- 성공 응답은 `accessRevision`, `rooms`, `wireItems`, `rolloutLeaseExpiresAt`을 포함한다. Firebase custom
  token은 `sideyRolloutUntil` claim을 가지며 RTDB Rules와 callable chat은 만료된 lease를 거부한다.
  `refreshAfter`는 lease 만료 30초 전 epoch-ms다. client는 selector를 다시 호출한 뒤 bootstrap을
  재호출해 최대 300초 lease를 갱신한다.
- cohort OFF/non-selected/stale capability면 bootstrap은 `409 realtime_rollout_disabled`로 거부한다.
  cohort/session 제거는 기존 lease 만료 시점(최대 300초) 안에 Rules에서 반영된다.
- 전역 emergency kill은 `/v2/a/g/e`의 literal `true`만 허용한다. false/누락 시 Rules가 기존 listener를
  즉시 끊고 bootstrap과 callable chat도 매 요청 fail-close한다. disable은 Firebase false exact read-back
  후 Supabase OFF, enable은 Firebase false exact read-back을 먼저 강제한 뒤 Supabase ON exact read-back,
  Firebase true 순서다.
- Supabase logout, account/session switch에서는 Firebase listener와 Auth credential을 폐기하고 새
  Supabase session으로 재-bootstrap한다. permission denial을 legacy 자동 downgrade로 우회하지 않는다.
- 새 client는 `create_room_v2`, `join_room_v2`, `set_equipped_cosmetic_v2`가 반환한
  `accessRevision`을 barrier로 사용한다. 서버가 자동 처리한 purchase/equip 등은 commit 뒤
  `current_firebase_access_revision()`으로 exact revision을 얻는다. 기존 RPC와 response shape는 유지한다.

## 수신·재조정 계약

- 새 v2 client는 typing/pulse/throw를 Firebase t/c/x에 한 번만 발행하고 Firebase snapshot에서 수신한다.
  old client는 기존 authenticated Supabase RPC/private Broadcast를 그대로 사용한다. client가 두 transport에
  동시에 발행하지 않는다.
- Firebase→Supabase trigger는 CloudEvent ID에서 안정 UUID를 만들고 service RPC가 dedupe, 현재 session,
  membership, target, entitlement와 공유 rate ledger를 재검증한다. Admin SDK mirror write는 trigger에서
  제외하므로 loop가 없다.
- Supabase→Firebase는 transaction outbox와 exact claim/validate/ACK를 사용한다. compact slot transaction은
  timestamp high-water를 지켜 오래된 retry가 최신 animation을 덮지 못하게 한다.
- initial snapshot은 baseline일 뿐 animation을 재생하지 않는다. 이후 event도 timestamp가 5초보다 오래됐으면
  억제한다. t/c/x는 일시 상태이며 message history나 source of truth가 아니다.
- access/room revision은 20자리 string을 lexical compare한다. access hint는 bootstrap barrier 재수렴,
  room hint는 authoritative Supabase room snapshot reload, chat sequence gap은 Supabase 3일 history
  reload를 유발한다.
- Presence topic은 `presence:{roomId}:{realtimeEpoch}:{targetUserId}`다. viewer와 target 모두 현재 epoch
  room member여야 하고 writer는 자기 target UID만 쓸 수 있다. 기존 Supabase Realtime socket을
  재사용하며 application heartbeat를 만들지 않는다.
- throwable의 `k`는 JSON number가 아니라 decimal string이다. mapping은
  `get_store_state_v2.wireCode`가 authoritative하다. code `"0"`은 built-in
  `patch_soft_ball`이고 catalog ID 자체를 RTDB에 쓰지 않는다. ID→code mapping은
  `20260921110000_firebase_wire_code_contract.sql`에서 canonical catalog SHA에 고정했으며 production
  map은 M0 read-back 뒤 최종 확정한다.

## 혼합 버전 호환 기간

- `20260921132018_firebase_mixed_version_supabase_bridge.sql`은 Firebase-live room에서도
  `message_changed`, `messages_pruned`, `structure_changed`와 typing/pulse/throw의 기존 Supabase private
  Broadcast를 유지한다.
- forward migration `20260922192118_firebase_transient_bridge.sql`은 old Supabase RPC를 durable outbox로
  Firebase t/c/x에 mirror하고, Firebase client write를 private Supabase Broadcast에 mirror한다. 동일 source
  event UUID와 CloudEvent-derived UUID, monotonic slot write, Admin-trigger skip으로 retry dedupe와 loop 방지를
  강제한다. 이 migration/Functions/Rules는 현재 source candidate이며 deployed read-back이 아니다.
- `configure_firebase_transient_bridge_v2`는 두 transient bridge 방향을 함께 끄고 pending publication을
  안전하게 settle한다. Presence와 durable/structure routing은 이 switch의 영향을 받지 않는다.
- 아래 staging-only `/v2/rooms/.../events` outbox는 compact `/v2/l` client 계약이 아니며 native v2 호환
  증거로 계산하지 않는다.
- 이 bridge에는 날짜 기반 runtime cutoff가 없다. 7일은 최소 관찰 기간일 뿐 자동 종료 시점이 아니다.
  활성 client capability 측정 또는 최소 지원 버전 강제와 old↔new chat/typing/pulse/throw/Presence matrix
  PASS 뒤에만 별도 reviewed forward migration으로 제거할 수 있다.

## Chat commit semantics

validation/auth/membership/rate/conflict/sequence 오류는 transaction non-commit이다. `unavailable`,
transport, deadline, internal 오류는 commit 여부가 모호하므로 자동 재전송하지 않고 같은 client message
UUID로 Supabase history를 조회해 조정한다. RTDB event는 notification이며 원문 source of truth가 아니다.

## legacy 및 staging 실험 경로

2026-09-21 운영 Firebase에서 복구한 Rules/Functions는 위 compact 경로 외에 다음 레거시 경로도 허용했다.

- `/v2/rooms/{roomId}/presence|typing|throws`
- `/v2/chat/commands|acks|events`

Gate 1은 해당 Rules 허용과 `persistChatCommand` trigger 제거를 production에 배포했고 read-back했다.
current released client는 Firebase/RTDB를 사용하지 않아 이 제거의 영향을 받지 않는다.

Supabase staging에서 복구한 Edge Functions는 다음 별도 경로를 생성한다.

- `/v2/access/{roomId}`
- `/v2/rooms/{roomId}/epochs/{epoch}`
- 해당 epoch 아래 `events/{eventId}` 및 server hint/control 데이터
- `/v1/leases/{userId}/{sessionId}`

이 staging Edge 모델은 기능 flag가 꺼진 실험 경로이며 client contract에서 제외한다. M0 candidate는
publisher URL 기본값을 `NULL`로 두고 운영자가 환경별 URL을 명시하지 않으면 fail-closed한다. 10명
staging smoke/cleanup은 PASS했지만 Windows REST/SSE/307 fixture는 local test이며 실제 client smoke를
대신하지 않는다.

## 필수 오류 범주

외부 응답은 안정된 코드만 노출하고 upstream body, credential, 고객 식별자를 포함하지 않는다.

- `authentication_required` / `active_session_required` / `session_refresh_required`
- `membership_required` / `target_membership_required`
- `stale_realtime_epoch` / `stale_typing_sequence`
- `realtime_event_rate_limited`
- `invalid_realtime_event`
- `duplicate_event`
- 범주화할 수 없는 장애는 `*_unavailable`

HTTP status와 오류 코드 매핑은 client handoff 전에 fixture로 동결한다.

## client handoff 전 필수 fixture

- Windows `.json?auth=` URL, SSE `put`/`patch`, 307 redirect 거부/처리
- 같은 UID의 A/B session refresh
- account `active=false`, session revoke, kick/leave/refund 직후 listener/write 거부
- room tombstone 뒤 늦은 worker의 root 재생성 방지
- bounded typing slot과 fan-out abuse 거부
- 10명 smoke 및 temporary Auth/data cleanup
