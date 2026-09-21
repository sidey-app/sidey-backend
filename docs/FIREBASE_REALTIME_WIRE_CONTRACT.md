# Firebase Realtime wire contract

상태: **Gate 1 local candidate — 배포 전 client handoff 및 production 사용 금지**
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
| `/v2/l/{roomId}` | room member read, 제한된 client write | active room의 compact typing `t`, pulse `c`, throw `x`, 최신 chat event `e` |
| `/v2/n/{userId}` | 해당 사용자 read, server write | access, room revision, chat sequence hint |

클라이언트 write는 유효한 Supabase session claim, active account, room membership, 최신 global access health를 모두 만족해야 한다. kick, leave, refund, session revoke, account suspend 후에는 같은 Firebase token으로도 즉시 거부돼야 한다.

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
| `/v2/l/{rid}/t/{uid}/{sideySessionId}` | epoch millisecond number | claim과 동일한 session slot 한 개만, 최소 1,500ms 간격 |
| `/v2/l/{rid}/c/{uid}` | epoch millisecond number | 본인 slot, 최소 1,000ms 간격 |
| `/v2/l/{rid}/x/{uid}` | `{u, k, t}` | target UID, entitlement wire code, timestamp; 최소 500ms 간격 |
| `/v2/l/{rid}/e` | `{i, s, b, t, n, k?}` | server-only latest chat event |
| `/v2/n/{uid}/a` | 20자리 decimal revision string | server-only access hint |
| `/v2/n/{uid}/r/{rid}/v` | 20자리 decimal revision string | server-only room hint |
| `/v2/n/{uid}/r/{rid}/n` | positive safe integer | server-only chat sequence hint |

정확한 endpoint, error map과 path fixture는 `firebase/contract-v2.fixture.json`에 둔다. 배포 검증 전 상태값은 `local-candidate-not-deployed`다.

## legacy 및 staging 실험 경로

2026-09-21 운영 Firebase에서 복구한 Rules/Functions는 위 compact 경로 외에 다음 레거시 경로도 허용했다.

- `/v2/rooms/{roomId}/presence|typing|throws`
- `/v2/chat/commands|acks|events`

Gate 1 local candidate는 해당 Rules 허용과 `persistChatCommand` trigger를 제거했다. current private client `main` `135a354f57908cc6efc54dec53094d1f6b24151d`에서 Firebase/RTDB 사용은 0건이다. 이 변경은 아직 배포되지 않았다.

Supabase staging에서 복구한 Edge Functions는 다음 별도 경로를 생성한다.

- `/v2/access/{roomId}`
- `/v2/rooms/{roomId}/epochs/{epoch}`
- 해당 epoch 아래 `events/{eventId}` 및 server hint/control 데이터
- `/v1/leases/{userId}/{sessionId}`

이 staging Edge 모델은 기능 flag가 꺼진 실험 경로이며 Gate 1 client contract에서 제외한다. 해당 Edge source와 production Supabase object 정리는 Gate 2 migration 검토에서 별도로 처리한다. production deploy와 10명 staging smoke 전에는 local candidate를 frozen/deployed contract로 부르지 않는다. Windows REST/SSE/307 fixture는 local test에서만 통과했으며 실제 client smoke를 대신하지 않는다.

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
