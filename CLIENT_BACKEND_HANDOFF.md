# Client/backend production handoff

상태: **TRANSIENT BRIDGE SOURCE CANDIDATE — production rollout OFF, 미배포**
기준일: 2026-09-23

이 문서는 Firebase v2가 포함된 native client의 production backend 계약과 다음 배포 후보를 분리해 기록한다.
기존 Supabase M0와 Firebase Functions 9개는 배포돼 있지만, typing/pulse/throw 양방향 호환 bridge migration,
Functions 5개 추가분과 새 Rules는 **source candidate일 뿐 아직 production에 배포되지 않았다**. 운영은
2026-09-23 old contract가 잠시 100% ON이었던 것을 확인한 뒤 Firebase gate false read-back → Supabase selector
OFF read-back 순서로 다시 차단했다. App Store 업로드·심사·배포와 rollout ON은 이 handoff 범위가 아니다.

## production 상태

| 구성 | read-back |
| --- | --- |
| Supabase project | `whtejsviizgejauasqqt` |
| migration history | `93`; first `20260829000000`, last `20260921142300` |
| final schema | private table `25`; canonical app+Realtime SHA-256 `6425dcd8ebeafdeb0890d34780355fe20de6903da891e34af3d19d635da28948` |
| deployed contract | protocol `2`; selector hash `3c836b40cfc44437e9d069b84787cd3d8793026ce40de46d82b9ece79127b7e5` |
| source candidate | `firebase/contract-v2.fixture.json` SHA-256 `0f2845d033df248b1745c6526c8c7100b8d8fa6839b45f28c73b1023053fce2e`; migration `20260922192118` |
| Firebase project / RTDB | `sidey-realtime` / regional `sidey` |
| database URL / region | `https://sidey.asia-southeast1.firebasedatabase.app` / `asia-southeast1` |
| App Store Firebase app | `1:985965733256:ios:62d9e218a8171e54b4063d`; bundle `app.sidey.desktop.appstore` |
| rollout singleton | `enabled=false`, `killSwitch=true`, `cohortBasisPoints=0`, TTL `300` |
| Firebase emergency gate | `/v2/a/g/e = false` |
| live/dispatch/cohorts | live/direct/dispatch OFF, publisher/wake URL `NULL`, enabled cohort `0` |
| T0 | **미시작**; 7일 관찰 시계도 시작하지 않음 |

fixture 안의 `status` object는 contract hash를 고정할 때의 candidate provenance이므로 live deployment 상태로
해석하지 않는다. 그 object만 갱신해도 contract hash가 바뀌므로 현재 remote 상태는 이 문서와 exact
read-back으로 판정한다.

`public.messages.sequence`는 `NOT NULL`, safe integer 범위이며 NULL/invalid row는 `0`이다.
`messages_room_sequence_unique`는 unique/valid/ready다. final read-back 당시 range는 `1..4032`였지만 live
traffic으로 행 수와 최대값은 계속 변하므로 client 상수로 사용하면 안 된다. commerce/auth critical identity와
ownership invariant는 M0 전후 exact preservation gate를 통과했다.

## client rollout selector

Supabase 로그인 뒤 현재 session JWT로 아래 RPC를 호출한다.

```text
register_realtime_capability_v2(
  p_platform text,          -- macos | windows
  p_app_version text,       -- 1..64, [0-9A-Za-z._+-]
  p_protocol_version int,   -- v2 client는 2
  p_contract_hash text      -- 위 64자 SHA-256
) -> jsonb
```

현재 production의 exact 응답은 다음과 같다.

```json
{
  "enabled": false,
  "protocolVersion": 2,
  "transport": "legacy_supabase",
  "contractHash": "3c836b40cfc44437e9d069b84787cd3d8793026ce40de46d82b9ece79127b7e5",
  "killSwitch": true,
  "cacheTtlSeconds": 300,
  "failureMode": "fail_closed_if_last_enabled"
}
```

위 JSON은 현재 deployed old contract read-back이다. candidate migration 적용 뒤에는 contract hash가
`0f2845d033df248b1745c6526c8c7100b8d8fa6839b45f28c73b1023053fce2e`로 바뀌어야 하며, 그 전후 값을
섞어서 capability를 등록하면 안 된다.

RPC는 `authenticated`만 실행 가능하며 `auth.sessions.session_id`가 현재 user/session과 일치하는지 확인한 뒤
capability와 `last_seen_at`을 기록한다. row는 session revoke/delete에 cascade된다. 메시지 본문이나 다른
개인정보는 기록하지 않는다.

- 명시적 `enabled=false` 응답은 legacy 선택이다.
- 마지막 응답이 enabled였는데 refresh/bootstrap/permission이 실패하면 legacy로 조용히 downgrade하지 않고
  fail-closed한다.
- selector/cohort 제거는 최장 300초 lease 안에 반영한다. 앱 실행 중에도 `cacheTtlSeconds` 이내에 갱신한다.
- 전역 emergency kill은 lease와 별개다. `/v2/a/g/e` false/누락 시 Rules가 열린 listener를 즉시 취소하고
  bootstrap/chat server도 매 요청 거부한다.

## Firebase bootstrap과 listener

- HTTPS function: `bootstrapRealtime`
- authorization: current Supabase access token의 `Bearer` header
- method/body: `POST`; `{}` 또는 `{"minimumAccessRevision":"20-digit-decimal"}`
- OFF 상태: HTTP `409`, `{"error":"realtime_rollout_disabled"}`
- ON 성공: fixture의 `bootstrap.responseKeys` exact contract를 사용한다.
- Firebase custom token 교환과 ID-token refresh는 Firebase Auth SDK가 소유한다.
- `refreshAfter` 전에 selector를 갱신하고 다시 bootstrap한다.
- Supabase logout/account/session switch에서는 listener, Firebase Auth, pending generation을 전부 폐기한다.

listener는 active room `/v2/l/{roomId}` 한 개와 user inbox `/v2/n/{uid}` 한 개다. access/room revision은
20자리 decimal string이며 lexical compare한다. permission denial은 fail-closed다.

Presence는 계속 Supabase private Realtime만 쓴다. 새 v2 client의 typing/pulse/throw는 Firebase compact
`/v2/l/{room}/t|c|x`에 **한 번만 발행하고 Firebase에서 수신**한다. 구버전 client는 기존 authenticated
Supabase RPC/private Broadcast를 유지한다. 혼재 기간의 서버 bridge가 Firebase→Supabase와
Supabase→Firebase를 각각 한 번 전달하므로 old↔new 양방향 통신이 된다. Firebase-origin Admin mirror는
RTDB trigger에서 제외하고, CloudEvent 기반 UUID dedupe와 durable outbox/high-water transaction으로 retry와
loop를 막는다. receiver는 initial snapshot을 baseline으로만 쓰고 5초가 지난 animation은 재생하지 않는다.
Postgres는 durable message source of truth이며 t/c/x는 일시 이벤트일 뿐 history가 아니다.

이 계약은 source candidate다. 현재 production Rules에서는 t/c/x를 사용하지 않으며, migration/Functions/Rules
배포 및 새 hash read-back 전에는 새 client selector를 ON으로 바꾸면 안 된다. bridge runtime switch
`configure_firebase_transient_bridge_v2`는 양방향 transient bridge만 끄며 Presence에는 영향을 주지 않는다.

chat의 deadline/internal/unavailable/transport 오류는 commit-ambiguous다. 동일 UUID를 자동 재전송하지 말고
Supabase 3일 history에서 client message UUID를 조정한다.

## wire-code contract

`get_store_state_v2.wireCode`만 wire code source다. catalog sort order나 catalog item ID로 다시 계산하면 안 된다.
default throwable code `"0"`은 `patch_soft_ball`이며 unknown incoming code는 drop한다.

```text
bubble: bubble_bunny_pink=1, bubble_butter_chick=2, bubble_starry_cat=3
throwable: throwable_bouncy_heart=1, throwable_toy_cannon=2,
  throwable_squeaky_duck=3, throwable_snowflake=4, throwable_baseball=5,
  throwable_wakkuball=6, throwable_dujjonku=7, throwable_mini_paprika=8,
  throwable_banana=9, throwable_dust_bath_pouch=10, throwable_starlight_orb=11,
  throwable_clam=12, throwable_pork=13, throwable_timber=14,
  throwable_tennis_ball=15, throwable_tissue_ball=16,
  throwable_fish_cake_skewer=17, throwable_leaf=18
```

## deployed Firebase inventory

모든 function은 `ACTIVE`, `asia-southeast1`, Node.js 22, 256 MiB, `minInstances=0`이다.
`SIDEY_SUPABASE_CONFIG`는 production opaque `sb_secret_`를 담은 Secret Manager version `3`을 참조한다.
secret 값은 source, handoff, log 어디에도 저장하지 않았다. wake endpoint 세 개만
`SIDEY_ACCESS_WAKE_TOKEN@1`을 추가로 참조한다.

| function | Cloud Run revision | source generation | Firebase hash |
| --- | --- | ---: | --- |
| `bootstrapRealtime` | `bootstraprealtime-00017-nem` | `1790072535168150` | `3a29adc21673b8184d6fca8f55fde47940e7ce04` |
| `reconcileRealtimeAccess` | `reconcilerealtimeaccess-00015-naq` | `1790072586915505` | `3a29adc21673b8184d6fca8f55fde47940e7ce04` |
| `retryRealtimeAccess` | `retryrealtimeaccess-00015-fiv` | `1790072586847443` | `3a29adc21673b8184d6fca8f55fde47940e7ce04` |
| `retryRealtimeChat` | `retryrealtimechat-00008-taj` | `1790072586614534` | `3a29adc21673b8184d6fca8f55fde47940e7ce04` |
| `retryRealtimeRoomRevisions` | `retryrealtimeroomrevisions-00014-cal` | `1790072586741969` | `3a29adc21673b8184d6fca8f55fde47940e7ce04` |
| `sendRealtimeChat` | `sendrealtimechat-00008-map` | `1790072586622968` | `3a29adc21673b8184d6fca8f55fde47940e7ce04` |
| `syncRealtimeAccess` | `syncrealtimeaccess-00015-kux` | `1790072586564247` | `50e9b0292f098de6b4826c389891c5ee5d46f529` |
| `syncRealtimeChat` | `syncrealtimechat-00008-yih` | `1790072587028880` | `50e9b0292f098de6b4826c389891c5ee5d46f529` |
| `syncRealtimeRoomRevisions` | `syncrealtimeroomrevisions-00014-xux` | `1790072586639148` | `50e9b0292f098de6b4826c389891c5ee5d46f529` |

RTDB Rules source raw SHA-256은
`90c9b8f28ff3806e32326f50b4c18dac963d36c0c3031ffa48b00a1b2671a5d5`, remote canonical SHA-256은
`145ab22b402de1445759c858a6fa3ab4bd6f3cb9599a7108ed53c8b3cd94f406`이며 source와 remote가 exact
canonical match다. disabled default RTDB는 source에서 참조하지 않는다.

## source candidate expected inventory

배포 전 예상 inventory는 기존 9개에 아래 5개를 더한 **14개**다. revision/generation/hash는 배포 후 read-back
전에는 알 수 없으므로 추정값을 적지 않는다.

- `syncRealtimeTransients`, `retryRealtimeTransients`
- `bridgeRealtimeTyping`, `bridgeRealtimePulse`, `bridgeRealtimeThrow`

새 Rules는 선택된 current session의 자기 t/c/x slot만 쓰게 하고, room membership, target membership,
throwable wire entitlement, gate/lease/access health와 1500/1000/500ms cooldown을 모두 확인한다. source
candidate와 deployed read-back을 혼동하지 않는다.

## verification evidence

| 검증 | 결과 |
| --- | --- |
| local reset / canonical schema / history | PASS; final history `93`, private table `25`, fingerprint `6425dcd8...` |
| pgTAP | PASS `703/703` (`26` files) |
| Functions syntax/unit/contract | PASS `79/79` |
| Rules emulator | PASS `12/12`; emergency listener cancellation 포함 |
| Python apply/rehearsal/history/legacy suites | PASS |
| lock/backfill/index interruption resume | PASS; production-shaped exact prefix/checkpoint replay |
| commerce/auth preservation | PASS; critical identity missing `0`, ownership invalid `0` |
| legacy PostgREST | PASS; `send_message` single object, exact 6 keys |
| staging mixed-version smoke | PASS; 10-user function matrix와 cleanup residual `0` |
| production authenticated OFF smoke | PASS; user 1, room 1, message 1; selector OFF, bootstrap `409`, legacy scalar object |
| production smoke cleanup | PASS; Supabase Auth/source/outbox, Firebase Auth/RTDB test scope residual `0` |
| 3,000 × 600s load | 사용자 결정으로 NOT RUN; 기능/호환 gate에 포함하지 않음 |
| transient bridge Functions unit/contract | PASS `87/87` 전체 suite |
| transient bridge Rules emulator | PASS `12/12` |
| transient bridge isolated pgTAP | PASS `37/37`; migration 전체 적용 뒤 전용 test |

production smoke cleanup은 기존 room-revision backlog 뒤에 test tombstone이 있어 최초 240초 deadline을 넘겼다.
global worker를 추가로 반복 호출하지 않고 정상 scheduler delivery를 기다린 뒤 exact test scope만 finalize했다.
최종 gate와 selector는 계속 OFF다.

## rollback과 T0

첫 대응은 schema down/drop이 아니라 rollout disable이다. disable은 **Firebase global gate false read-back →
Supabase selector OFF read-back** 순서다. enable은 **Firebase false read-back → Supabase ON read-back → Firebase true
read-back** 순서이며 `firebase/functions/scripts/configure-rollout.js`만 사용한다. project/ref/credential target이
다르면 mutation 전에 중단한다. 어떤 경우에도 historical migration을 replay하거나 applied migration을 수정하지
않는다.

현재 이미 OFF이므로 candidate 배포 순서는 고정한다: **old gate/selector OFF exact read-back 유지 → forward
migration `20260922192118` → Functions 14개와 Rules 배포 → migration/hash/function/rules/wake read-back → 새
contract capability 등록 → selector ON read-back → Firebase gate true read-back**. 중간 단계가 하나라도 실패하면
OFF를 유지한다. historical migration을 수정하거나 재실행하지 않는다.

T0는 reviewed client가 production에 배포된 뒤 별도 승인으로
cohort를 1 이상 설정하고 global gate true를 exact read-back한 시각이다. 7일은 그 뒤의 최소 관찰 기간이지
자동 legacy cutoff가 아니다. active capability 또는 최소 버전 강제 증거와 old↔new
chat/typing/pulse/throw/Presence matrix PASS 전에는 legacy bridge 제거 migration을 만들지 않는다.

JIT logical backup은 다음 physical backup이 `COMPLETED`가 될 때까지 삭제 금지다.

```text
/private/tmp/sidey-prod-jit-vY54jE/database.dump
mode 0600, size 122842146 bytes
SHA-256 573e5d229805bf5077a6285f624b3b86e34f3ab5acfe647b7bb56b106e63bbbf
```

이 파일에는 production auth/message/commerce 데이터가 있으므로 복사·커밋·업로드·내용 출력 금지다.

physical backup 상태는 CLI `2.116.0`에서 다음 read-only 명령으로 확인한다.

```sh
supabase backups list --project-ref whtejsviizgejauasqqt --output json
```

2026-09-22 최종 조회의 최신 physical backup은 `2026-09-21T19:05:19.690Z`, status `COMPLETED`로 M0보다
이전이다. `pitr_enabled=false`, `walg_enabled=true`다. 따라서 logical backup 삭제 조건은 아직 충족되지
않았다. M0보다 늦은 `inserted_at`의 `is_physical_backup=true`, `status=COMPLETED` row를 확인한 뒤에만 별도
승인된 정리 작업에서 삭제한다.
