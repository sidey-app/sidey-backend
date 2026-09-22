# Firebase v2 + Supabase 운영 전환 기준선

- 조사 시각: 2026-09-21T13:23:55+09:00
- Firebase CLI 재검증 시각: 2026-09-21T13:38:29+09:00
- 작업 브랜치: `shared/firebase-v2-production-rollout`
- 기준 commit: `d459dc4c50faa26caa5a56d78f18334b3752bc72`
- 기준 remote: 위 commit이 조사 시점 `origin/main` 및 merge base와 동일
- 조사 범위: remote read-only inventory, 배포 artifact 로컬 복구, 격리된 local validation
- Gate 판정: **BLOCKED — 단계 1로 진행 금지**

## 상태 용어

| 상태 | 의미 |
| --- | --- |
| `confirmed deployed` | 지정한 원격 환경에서 read-only 조회로 존재를 확인함 |
| `confirmed absent` | 지정한 원격 환경에서 read-only 조회로 부재를 확인함 |
| `local only` | 로컬 branch/worktree에는 있으나 현재 `origin/main` 또는 원격 배포와 연결되지 않음 |
| `documented target only` | rollout prompt에는 있으나 source 또는 배포 증거가 없음 |
| `unknown — verification required` | 권한·source·증거 부족으로 확정할 수 없음 |

## 즉시 중단 사유

1. Firebase 운영 프로젝트에는 `/v2` Rules와 Functions v2 10개가, Supabase staging에는 Firebase migration 19개와 Edge Functions 5개가 배포돼 있다. 배포 artifact는 이 task branch에 로컬 복구했다.
2. 운영 Firebase Rules/Functions는 `/v2/l·n`과 legacy `/v2/rooms`, `/v2/chat` 경로를 사용하지만 staging Edge Functions는 `/v2/rooms/{room}/epochs/{epoch}`와 `/v2/access/{room}`을 사용한다. 하나의 frozen contract라는 증거가 없다.
3. 운영 Rules는 목표에서 금지한 RTDB Presence와 legacy chat command 쓰기를 허용한다. compact typing connection key도 개수 상한이 없다.
4. 3,000 연결 성공 보고서는 없고, 실제 2,400 연결 시험은 39.735초에 backlog 상한을 넘겨 실패했다.
5. current private client main에는 Firebase adapter가 없다. Windows REST/SSE/redirect와 두 플랫폼 frozen contract fixture도 없다.
6. migration 19개 중 4개는 원격 history가 statement를 보존하지 않아 local deployment manifest까지만 provenance를 증명할 수 있다. 현재 복구 branch는 아직 review/commit되지 않았다.

## 필수 입력 자료

`origin/main` 조사 뒤 배포 artifact와 로컬 deployment manifest를 파일별로 복구한 결과다.

| 자료 | 상태 | 근거 |
| --- | --- | --- |
| `docs/FIREBASE_V2_COST_PRESENCE_DECISION.md` | `local only` | 배포 조사와 rollout 목표를 구분해 새로 작성. 승인된 과거 원본 아님 |
| `docs/FIREBASE_REALTIME_WIRE_CONTRACT.md` | `local only` | 충돌하는 두 path 세대를 기록한 초안. frozen client contract 아님 |
| `docs/FIREBASE_V2.md` | `local only` | 복구 상태와 Gate blocker를 새로 작성 |
| `docs/FIREBASE_REALTIME_HARDENING_PLAN.md` | `local only` | review finding 기반의 실행 대기 계획 |
| `firebase/database.rules.json` | `local only` | 운영 `sidey` Rules raw export와 byte-identical, raw SHA-256 `8d12452a...` |
| `firebase/functions/index.js`, `firebase/functions/lib/**` | `local only` | 10개 배포 archive가 byte-identical. 대표 archive에서 debug log 제외 후 복구 |
| `supabase/migrations/*firebase*` | `local only` | 15개 remote statement sequence + 4개 local deployment manifest로 복구 |
| `supabase/tests/firebase_*.test.sql` | `local only` | staging source snapshot에서 9개 복구, local pgTAP 통과 |
| `firebase/load-test/results/REAL_USE_3000_REPORT.md` | `local only` | NOT RUN blocker 문서. 2,400 연결 실패를 3,000 성공으로 승격하지 않음 |
| 사용자 제공 rollout prompt | `documented target only` | `/Users/aryu/Downloads/01_FIREBASE_AND_DATABASE_ROLLOUT_PROMPT.md`에만 있고 backend 저장소에는 없음 |

과거 local branch `shared/firebase-realtime-backend`의 commit `2e9d18eaa4c11a9188908af8331f980ffcd78c5e`에는 shadow/live 초안과 migration 2개가 있으나 `origin/main`보다 4 commit 뒤처지고 2 commit 앞선 미병합 이력이다. 이 branch의 Rules SHA-256은 다음과 같으며 운영 Rules와 일치하지 않는다.

| local-only 파일 | SHA-256 |
| --- | --- |
| `supabase/firebase/database.rules.json` | `baafba819b7e9cd03209b6e9968d641a58e91e20dfc2d9290a21d92d350cd3a5` |
| `supabase/firebase/database.live.rules.json` | `c576b9f92e835125d647b5a68b8a07857285e42c80d2ace6c9d9bf58b4f3782e` |
| `supabase/firebase/database.shadow.rules.json` | `b4e08b4b85b940faa5a229cf0fb32ba03548eff0937ee13a553053cefe6ee6ab` |

이 자료는 `local only` 참고자료이며 운영 source로 간주하지 않는다. dirty reference worktree의 미추적 파일도 복사하지 않았다.

## Firebase inventory

### 프로젝트와 RTDB instance

| 항목 | 상태 | 결과 |
| --- | --- | --- |
| Firebase project `sidey-realtime` | `confirmed deployed` | Firebase CLI와 기존 Console session으로 ACTIVE 확인 |
| RTDB `sidey` | `confirmed deployed` | Singapore `asia-southeast1`, URL은 `https://sidey.asia-southeast1.firebasedatabase.app` |
| `sidey-realtime-default-rtdb` | `confirmed absent` (활성 DB 기준) | CLI state `DISABLED`. 기본 instance 이름은 존재하지만 활성 데이터베이스가 아님. 읽기·쓰기·설정 변경 없음 |
| App Check | `confirmed absent` | App Check 화면이 미구성 `시작하기` 상태. RTDB/Functions enforcement는 켜져 있지 않음 |

최초 조사에서는 Firebase CLI 15.30.2의 cached OAuth credential이 만료돼 HTTP 401이 발생했다. 사용자가 직접 재로그인한 뒤 account 1개, `sidey-realtime` ACTIVE와 아래 metadata를 CLI로 재검증했다. agent는 로그인 UI나 credential 값을 다루지 않았다.

### 배포 Functions

Functions v2 10개가 모두 `sidey-v2` codebase, `asia-southeast1`, `nodejs22`, `256Mi`, 1 vCPU, `minInstances=0`, state `ACTIVE`로 배포돼 있다. CLI metadata와 Console을 대조한 결과다.

| Function | trigger | concurrency | min/max | timeout | source hash | source generation |
| --- | --- | ---: | --- | ---: | --- | --- |
| `bootstrapRealtime` | HTTP | 20 | `0 / 10` | 30초 | `6afb2dfc4b9933dc49361429ce83f232575f9a44` | `1789902690949869` |
| `persistChatCommand` | `google.firebase.database.ref.v1.created` | 20 | `0 / 10` | 30초 | `6afb2dfc4b9933dc49361429ce83f232575f9a44` | `1789902755166101` |
| `reconcileRealtimeAccess` | schedule | 1 | `0 / 1` | 240초 | `6afb2dfc4b9933dc49361429ce83f232575f9a44` | `1789902754943961` |
| `retryRealtimeAccess` | schedule | 1 | `0 / 1` | 240초 | `6afb2dfc4b9933dc49361429ce83f232575f9a44` | `1789902754815977` |
| `sendRealtimeChat` | callable | 20 | `0 / 10` | 30초 | `6afb2dfc4b9933dc49361429ce83f232575f9a44` | `1789902755138024` |
| `retryRealtimeChat` | schedule | 1 | `0 / 1` | 60초 | `6afb2dfc4b9933dc49361429ce83f232575f9a44` | `1789902754956089` |
| `syncRealtimeAccess` | HTTP | 1 | `0 / 1` | 240초 | `dc0c632d183dbdc28ac245d3f5d891555eb3d7a7` | `1789902754552506` |
| `syncRealtimeChat` | HTTP | 1 | `0 / 1` | 60초 | `dc0c632d183dbdc28ac245d3f5d891555eb3d7a7` | `1789902754902047` |
| `syncRealtimeRoomRevisions` | HTTP | 1 | `0 / 1` | 60초 | `dc0c632d183dbdc28ac245d3f5d891555eb3d7a7` | `1789902754617831` |
| `retryRealtimeRoomRevisions` | schedule | 1 | `0 / 1` | 60초 | `6afb2dfc4b9933dc49361429ce83f232575f9a44` | `1789902755163723` |

source archive는 bucket `gcf-v2-sources-985965733256-asia-southeast1`, object `<Function>/function-source.zip`에 위 generation으로 남아 있다. 7개 함수는 source hash `6afb2d...`, 3개 sync 함수는 `dc0c63...`으로 나뉜다. generation-pinned archive 10개를 회수했고 모두 SHA-256 `2247f646...`로 byte-identical했다. 대표 tree를 `firebase/functions`에 복구했다.

배포된 `index.js` 전체를 read-only로 확인한 결과 10개 export가 모두 한 번의 Admin SDK 초기화를 공유하고, 명시적 `https://sidey.asia-southeast1.firebasedatabase.app`이 2회 존재하며 default RTDB hostname은 존재하지 않았다. 생성된 `FIREBASE_CONFIG` 환경 변수는 default instance hostname을 포함하지만 application 초기화가 명시적 `databaseURL`을 덮어쓴다. archive의 test는 검증용으로 보존했고 `database-debug.log`는 제외했다. 향후 deploy package에서 test/log/env/cache를 명시적으로 제외하는 설정은 아직 필요하다.

### Rules와 `/v2` 상태

| 항목 | 상태 | 결과 |
| --- | --- | --- |
| 배포 Rules | `confirmed deployed` | CLI export 13,071 bytes SHA-256 `8d12452a40e47ee3f11dda4525439540b0dc86df78165369e5ba941a5c7de8c8`; 마지막 newline 제외 시 Console hash `3b37817171d80a65d8ce042a049d696b9e28a63241f18fc2c0bb20bad6fd2ea1`; canonical JSON hash `ed94e215cf305a0bbbfd6b9801b2c04ec7c20d6a8e529aa9bada2c3edccbe4e8` |
| Rules top-level `/v2` keys | `confirmed deployed` | `access`, `l`, `n`, `rooms`, `chat`, `$other` |
| current-main Rules와 diff | `unknown — verification required` | current main에 local Rules 파일이 없음. 과거 local-only live Rules canonical hash `ec7b88f79b74c936e0c6d33f59c10463b78e62337b5974e31139f919b2657591`과는 불일치 |
| `/v2` current roots | `confirmed deployed` | `access`, `internal`, `n`만 존재. `l`, `rooms`, `chat`은 0개 |
| `/v2/access` | `confirmed deployed` | `sync`, `users`. global `valid_until`은 조회 시 유효했음 |
| `/v2/access/users` | `confirmed deployed` | 72개 모두 `active=false`; room/session reference는 모두 0 |
| `/v2/n` | `confirmed deployed` | 72개, 각 entry는 compact string field `a`만 보유 |
| `/v2/internal/bootstrap_limits` | `confirmed deployed` | 72개, 모두 attempts 1이며 window가 조사 시점 10분보다 오래됨 |
| retry node | `confirmed absent` (RTDB 기준) | `/v2/internal`의 immediate key는 `bootstrap_limits` 하나뿐이고 live/chat/room node도 없음 |
| stale mirror / test residue | `confirmed deployed` | inactive access 72개와 오래된 bootstrap-limit 72개가 남아 있음. synthetic test account인지 실제 과거 계정인지는 식별자를 출력하지 않아 미확정 |

### Secret Manager와 platform fixture

| 항목 | 상태 | 결과 |
| --- | --- | --- |
| `SIDEY_SUPABASE_CONFIG` | `confirmed deployed` | version `1` 하나, state `ENABLED`. 10개 함수가 참조 |
| `SIDEY_ACCESS_WAKE_TOKEN` | `confirmed deployed` | version `1` 하나, state `ENABLED`. sync 함수 3개가 참조 |
| 전체 참조 secret 수 | `confirmed deployed` | 이름 2개, 활성 version 총 2개. secret 값은 접근하지 않음 |
| Windows canonical `.json?auth=`, SSE `put`/`patch`, 307 fixture | `confirmed absent` (current main) | current main에 fixture/docs/source가 없음. 실제 과거 실행 여부는 미확정 |

## Supabase inventory

### 환경과 migration history

두 프로젝트 모두 조사 시점 `ACTIVE_HEALTHY`였고 CLI/MCP 인증이 유효했다. 모든 SQL은 `BEGIN TRANSACTION READ ONLY`와 `transaction_read_only=on`을 확인한 뒤 catalog metadata만 조회하고 `ROLLBACK`했다.

| 환경 | 상태 | Firebase v2 migration |
| --- | --- | --- |
| staging `fjglrvhvdthntkvrduyi` | `confirmed deployed` | 19개 |
| production `whtejsviizgejauasqqt` | `confirmed absent` | 0개 |

공통 migration은 `20260829000000`부터 `20260916000000`까지 37개다.

staging-only Firebase migration 19개:

1. `20260918000000 firebase_shadow_foundation`
2. `20260918010000 firebase_live_transport`
3. `20260919000000 firebase_live_edge_dispatch`
4. `20260919010000 firebase_live_fast_dispatch`
5. `20260919020000` (remote history에 이름 없음)
6. `20260919030000` (remote history에 이름 없음)
7. `20260919040000 firebase_publish_wake`
8. `20260919050000 firebase_edge_region`
9. `20260919060000 firebase_publisher_ack_claim`
10. `20260919135013 firebase_chat_bridge`
11. `20260919165358 firebase_event_driven_access`
12. `20260919224714 firebase_access_failure_isolation`
13. `20260920060949 firebase_room_revision_outbox`
14. `20260920085650 firebase_presence_inbox_delivery`
15. `20260920095057 firebase_presence_revocation_and_revision_fence`
16. `20260920104030 firebase_v2_compact_throw_chat_publish`
17. `20260920110649 firebase_wake_header`
18. `20260920111743 firebase_chat_outbox_compaction`
19. `20260921020848 firebase_live_lease_one_hour`

production-only migration 4개는 Firebase와 무관하며 current main에는 존재한다.

- `20260919151111 support_portone_card`
- `20260920125342 admin_payments_summary`
- `20260921024931 admin_payment_summary_concurrent_indexes`
- `20260921025140 admin_payment_summary_web_index`

staging Firebase migration 19개는 task branch에 복구했다. 15개는 원격 executed statement sequence와 일치하고, 4개는 원격 history가 statement를 보존하지 않아 local deployment manifest와 frozen source hash까지만 증명된다. 이름으로 재작성하거나 이 상태로 production에 적용하면 안 된다.

### staging v2 object

| object | 상태 | 결과 |
| --- | --- | --- |
| private Firebase table | `confirmed deployed` | 23개 |
| outbox table | `confirmed deployed` | 6개: access, chat cleanup/publish, hint, live, room revision |
| Firebase 관련 function | `confirmed deployed` | public 39개 + private 28개, 66개 `SECURITY DEFINER`, 모두 빈 `search_path` 확인 |
| authenticated Firebase RPC | `confirmed deployed` | `authorize_firebase_direct_event`, `authorize_firebase_publish_wake`, `firebase_realtime_changes`, `prepare_firebase_live_lease`, `prepare_firebase_shadow_lease` |
| service-role worker RPC | `confirmed deployed` | 34개 |
| anon Firebase RPC | `confirmed absent` | 0개 |
| trigger | `confirmed deployed` | 28개 중 enabled 25, shadow trigger 3개 disabled |
| auth revoke/presence trigger | `confirmed deployed` | `auth.sessions`/`auth.users` 관련 7개 |
| Firebase cron | `confirmed absent` | extension은 있으나 name/command가 Firebase 또는 outbox인 job 0개 |
| realtime schema Firebase/v2 object | `confirmed absent` | 0개. `realtime.messages`의 기존 policy 2개만 존재 |

private Firebase table 23개 중 6개는 RLS enabled/no policy, 17개는 RLS disabled다. 다만 `anon`/`authenticated`는 private schema `USAGE`와 해당 table direct DML 권한이 없어 Data API 직접 노출 증거는 없다. 복구 migration을 빈 local DB에 재적용했고 pgTAP 641개와 동시성 검증이 통과했다. production 적용 전에는 advisor와 grant diff를 다시 검토해야 한다.

staging Edge Functions 5개는 모두 `ACTIVE`다.

| Edge Function | version | JWT 설정 |
| --- | ---: | --- |
| `realtime-bootstrap` | 139 | `verify_jwt=true` |
| `realtime-publish` | 133 | `verify_jwt=false` |
| `realtime-publish-live` | 121 | `verify_jwt=false` |
| `realtime-event` | 111 | `verify_jwt=false` |
| `realtime-wake` | 81 | `verify_jwt=false` |

`verify_jwt=false` 4개의 source를 exact deployed bundle에서 복구했다. publish 계열은 scheduler/wake secret과 staging binding을, event/wake는 user JWT를 PostgREST authorization RPC로 검증한다. Node protocol tests 401개와 Deno entrypoint check는 통과했지만 production binding과 staging smoke는 수행하지 않았다.

### production v2 object

Firebase migration, Firebase/private v2 table, function, trigger, presence helper, outbox cron 및 `realtime-*` Edge Function은 모두 `confirmed absent`다. production Edge Functions에는 commerce 5개와 `download-metrics-ingest`만 존재한다.

### Auth session 설정

| 설정 | staging | production |
| --- | --- | --- |
| single-session | OFF | OFF |
| time-box | 0 / never | 0 / never |
| inactivity timeout | 0 / never | 0 / never |
| JWT expiry | 3600초 | 3600초 |
| compromised refresh-token detection | ON | ON |
| refresh-token reuse interval | 10초 | 10초 |
| `auth.sessions.not_after` | nullable, session row 0 | nullable, 현재 row는 모두 `NULL` |

현재 production session은 현 설정과 호환된다. 개별 session/user 행은 출력하거나 보존하지 않았다. [Supabase 공식 session 문서](https://supabase.com/docs/guides/auth/sessions)상 time-box/inactivity/single-session 변경은 즉시 모든 session을 지우는 방식이 아니라 refresh 시 적용되며 JWT expiry만큼 체감 지연될 수 있다.

### Advisor 기준선

| 환경 | security | performance |
| --- | --- | --- |
| staging | INFO `rls_enabled_no_policy` 8(그중 Firebase 6), WARN authenticated `SECURITY DEFINER` executable 22(그중 Firebase 5) | INFO unindexed FK 13(그중 v2 1), unused index 4, auth DB absolute connections 1 |
| production | INFO `rls_enabled_no_policy` 3, WARN authenticated `SECURITY DEFINER` executable 17, WARN anonymous-access-policy 11 entity, leaked-password protection disabled 1, MFA options insufficient 1 | INFO unindexed FK 11, unused index 4, auth DB absolute connections 1 |

Advisor는 위험 신호이지 단독 취약점 판정이 아니다. exact migration source와 intended grant/RLS model을 복원한 뒤 항목별로 검토한다.

## 현행 client compatibility 기준선

공개 SIDEY의 현재 `origin/main`은 배포·지원 저장소로 축소돼 앱 source와 `docs/`가 없다. current private client source는 `/Users/aryu/Documents/SIDEY/_workspace/sidey-source`의 clean main `135a354f57908cc6efc54dec53094d1f6b24151d`에서 확인했다. 이 source는 Firebase adapter 없이 아래 legacy Supabase 계약만 사용한다. 공개 corresponding-source tag `windows-v2.0.0` (`92088b671cebd073623701d15442b1ba3c8638e8`)은 보조 비교 근거다.

### legacy RPC

- `broadcast_room_event`
- `broadcast_character_throw`
- `set_tree_movement_paused`
- `get_store_state`
- `set_equipped_cosmetic`
- `upsert_profile`
- `create_room`
- `join_room`
- `rotate_invite_code`
- `leave_room`
- `rename_room`
- `remove_room_member`
- `delete_room`
- `send_message`
- `delete_own_account` (Windows runtime, macOS DEBUG test path)

직접 조회 table은 `profiles`, `rooms`, `room_members`, `commerce_entitlements`, `messages`다. write는 RPC를 사용한다.

호환성상 특히 고정해야 할 response shape:

- `leave_room`: macOS는 nullable UUID body를 decode하고 Windows는 body를 무시한다.
- `set_tree_movement_paused`: macOS는 row array 첫 항목을 요구하고 Windows는 object/array 첫 항목을 허용한다.
- `get_store_state`: macOS가 Windows보다 많은 필드를 non-optional로 decode하고 known metadata도 더 엄격히 확인한다.
- `profiles`, `rooms`, `room_members`의 `select=*`: macOS는 `created_at`, `joined_at` 등 Windows보다 많은 필드를 요구한다.
- `send_message`: `{id, room_id, sender_id, body, created_at, bubble_style_id?}`를 유지한다.

### legacy Realtime

- private DB topic: `room:<room_uuid>:<realtime_epoch>:db`
- private ephemeral topic: `room:<room_uuid>:<realtime_epoch>:ephemeral`
- raw Phoenix topic에는 `realtime:` prefix가 붙는다.
- DB Broadcast: `message_changed`, `structure_changed`, `messages_pruned`
- Ephemeral Broadcast: `typing_start`, `typing_stop`, `character_pulse`, `character_throw`
- Presence key: authenticated user UUID
- Presence payload: `{user_id, state, online_at}`
- client는 Broadcast에 직접 쓰지 않고 인증 RPC를 호출한다.

Windows는 raw REST/Phoenix transport이고 macOS는 typed Supabase client이므로 더 엄격한 macOS decode를 compatibility floor로 사용해야 한다.

## 최신 platform 변경 확인

- [2026-07-14 Realtime schema 잠금 변경](https://supabase.com/changelog/realtime-schema-locked-down-against-modification)에 따라 Supabase `realtime` schema object 변경은 차단되고 `realtime.messages` RLS policy 변경만 허용된다. v2 private object를 `realtime` schema에 만들지 않는다.
- [Data API 자동 노출 변경](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)은 2026-10-30 기존 프로젝트에도 적용될 예정이다. production migration은 필요한 `GRANT`와 RLS를 명시해야 한다.
- session 제한은 refresh 때 적용되므로 cutover/revocation 설계가 Dashboard toggle의 즉시성에 의존하면 안 된다.

## 단계 0 완료 표

| 항목 | 결과 |
| --- | --- |
| 대상 환경 | Firebase production `sidey-realtime`; Supabase staging/production |
| 변경 파일·migration | 배포 Functions/Rules, staging migrations/Edge/tests를 task branch에 로컬 복구. 설계/계약/hardening/provenance 문서를 새로 작성. remote 적용 없음 |
| remote mutation | 없음. deploy, migration apply, flag 변경, data write 0. Firebase 재로그인은 사용자가 직접 수행했으며 project 설정은 바뀌지 않음 |
| test | Functions 51 PASS, Rules emulator 13 PASS, Edge protocol/load harness 402 PASS, Deno check 5 PASS, pgTAP 641 PASS, DB concurrency PASS. 기존 commerce/catalog/metrics/verifier 회귀도 PASS. `scripts/workflow.py --repo . doctor`는 private backend checkout에서 내부 `git diff`가 repo context를 잃어 BLOCKED |
| compatibility | current private client main `135a354f...` 확인. Firebase adapter 없이 legacy Supabase RPC/Broadcast/Presence만 사용 |
| security | App Check 미구성 확인. staging RLS/grant/advisor 및 Auth 설정 확인. Secret 이름/version 상태만 조회하고 값은 접근하지 않음. Rules 감사 score 4/10; legacy path와 unbounded typing fan-out 발견 |
| cost | Functions minInstances=0 확인. 3,000 시험 없음. 2,400 연결은 backlog로 FAIL하여 run-rate/비용 승인 근거 없음 |
| cleanup | task-owned local Supabase stack 중지. synthetic remote account/data 생성 없음. Firebase emulator debug log는 저장소에서 제외됨 |
| rollback | remote mutation이 없어 불필요. 복구 source는 rollback 재료지만 배포 가능한 reviewed commit은 아직 없음 |
| 다음 gate | **진입 금지.** canonical path 선택, legacy RTDB Presence/chat 처리, abuse/session 상한, 필수 cross-platform fixture와 3,000 성공 증거가 필요 |

## Gate 1 전에 필요한 조치

1. `/v2/l·n`과 `/v2/rooms/{room}/epochs/{epoch}` 중 canonical contract를 선택하고 Rules/Functions/Edge를 같은 모델로 맞춘다.
2. 공개 클라이언트 미사용 증거를 고정한 뒤 RTDB Presence와 legacy chat/room write를 제거하거나 durable compatibility 경로로 격리한다.
3. typing connection fan-out과 session mirror 개수에 서버 강제 상한을 추가한다.
4. account suspension, A/B session, tombstone/late worker, Windows REST/SSE/307 fixture를 추가한다.
5. current macOS/Windows legacy fixture와 새 v2 fixture를 같은 exact source snapshot에서 실행한다.
6. inactive access/notification/bootstrap-limit 72개가 synthetic residue인지 확인하고 별도 승인된 cleanup/rollback 계획을 만든다.
7. 10명 smoke/cleanup을 통과한 뒤 3,000 연결 600초 시험을 수행한다. 2,400 실패 결과를 재사용하지 않는다.
8. full diff review와 exact-head validation 뒤 별도 승인을 받아서만 Gate 1 deploy를 진행한다.
