# Firebase v2 운영 구조

상태: **production M0 배포됨 / transient bridge source candidate 검증 완료·미배포**
기준일: 2026-09-23

## 역할 분리

1. Supabase transaction이 room, membership, profile, commerce, message 원본을 갱신한다.
2. 같은 transaction이 private schema의 durable outbox를 기록한다.
3. Edge/Functions worker가 bounded claim, exact ACK, retry와 tombstone fence를 적용한다.
4. 새 client의 typing/pulse/throw는 Firebase compact t/c/x를 사용하고, server bridge가 old Supabase client와
   혼재 기간 양방향 호환을 제공한다. Presence는 Supabase에 남는다.
5. 클라이언트는 durable 데이터는 Supabase에서 재조회하며 RTDB transient를 source of truth로 사용하지 않는다.

## 복구 baseline과 현재 구성

- Gate 0에서 복구한 Firebase Functions v2는 10개였다. Gate 1에서 legacy
  `persistChatCommand`를 제거한 뒤 production read-back은 9개 ACTIVE다.
- 운영 RTDB Rules 한 벌
- Gate 0에서 복구한 Supabase staging Firebase migration은 19개였다. Gate 1 지원 migration 2개를
  적용해 현재 staging은 21개이며, production 호환 migration
  `20260921102516_firebase_production_compatibility.sql`과
  `20260921110000_firebase_wire_code_contract.sql`,
  `20260921132018_firebase_mixed_version_supabase_bridge.sql`,
  `20260921133000_firebase_client_rollout_selector.sql`,
  `20260921133500_legacy_send_message_response_contract.sql`까지 production에 배포됐다. 새 forward migration
  `20260922192118_firebase_transient_bridge.sql`은 source candidate다.
- Supabase Edge Functions 5개: `realtime-bootstrap`, `realtime-publish`, `realtime-publish-live`, `realtime-event`, `realtime-wake`
- Firebase unit/Rules tests, pgTAP, Edge protocol/load harness, DB concurrency tests

정확한 복구 hash와 한계는 `firebase/DEPLOYED_SOURCE_PROVENANCE.md`에 기록한다.

## 환경 상태

| 환경 | Firebase v2 상태 |
| --- | --- |
| Firebase `sidey-realtime` | Gate 1 Rules와 Functions 9개 ACTIVE, 배포 후 read-back 완료 |
| Supabase staging `fjglrvhvdthntkvrduyi` | Firebase migration 21개와 Edge Functions 5개 배포됨 |
| Supabase production `whtejsviizgejauasqqt` | M0 migration through `20260921142300`; selector OFF read-back |
| local production candidate | transient bridge migration `20260922192118`, Functions 5개 추가, t/c/x Rules; 미배포 |
| current released client | legacy Supabase 계약 사용. v2-capable release 없음 |

## 안전 불변식

- room 최대 12명, 사용자 최대 5개 room을 DB에서 강제
- access removal, revoke, suspend는 grant보다 우선하고 fail-closed
- outbox는 durable/idempotent이며 ACK는 exact claim에만 적용
- stale worker가 최신 revision/epoch/tombstone을 덮어쓰지 못함
- 외부 HTTP는 source transaction 안에서 호출하지 않음
- service-role 비밀과 upstream 오류 본문을 로그나 응답에 남기지 않음
- `realtime` schema를 Firebase 내부 큐로 사용하지 않음

## Gate 1에서 배포·검증한 항목

- canonical namespace를 `/v2/a`, `/v2/l`, `/v2/n`으로 제한
- RTDB Presence와 legacy `/v2/chat` Rules/trigger 제거
- typing key를 임의 CID가 아닌 `sideySessionId` claim의 session별 고정 slot으로 변경
- Functions access snapshot에 expiry 우선의 결정적 active session 16개 projection을 추가해 17번째 session이 사용자 전체를 quarantine하지 않도록 변경
- session revoke 시 모든 기존 room의 해당 typing slot을 지우는 durable `cleanup_sessions` marker 추가
- server-only room deletion tombstone `/v2/a/d/{roomId}`와 90초 claim을 한 번 넘긴 뒤 두 번째 cleanup에서만 ACK하는 late-worker fence 추가
- `sidey` database target과 `sidey-v2` codebase를 명시한 deploy config 추가
- Functions package에서 test, log, environment, cache와 `node_modules` 제외
- 식별자를 포함한 immediate chat 지연 로그 제거
- account 비활성화 시 bootstrap limiter cleanup 추가
- staging smoke가 exact outbox ACK를 확인하고 삭제된 test-owned queue tombstone을 transactionally 제거할 service-role 전용 forward migration 추가

## production M0에서 해결한 항목

- staging URL이 박힌 live publisher를 제거하고 환경별 `publisher_url` 미설정 시 fail-closed
- mixed legacy/Firebase room의 session revoke 때 legacy `structure_changed` Broadcast를 유지
- 기존 RPC shape를 보존한 `create_room_v2`, `join_room_v2`, `set_equipped_cosmetic_v2`와 exact
  `accessRevision` barrier 추가
- `current_firebase_access_revision` post-commit fallback과 `get_store_state_v2.wireCode` 추가
- `bootstrapRealtime.minimumAccessRevision` 수렴 장벽과 응답의 `accessRevision`, `wireItems` 추가
- Firebase-live room에서도 durable/structure invalidation과 기존 Supabase private Broadcast를 유지하는
  호환 기반을 production에 배포했다.

## transient bridge source candidate에서 해결한 항목

- 새 client는 typing/pulse/throw를 Firebase compact t/c/x에 한 번만 발행·수신하고, old client는 기존
  Supabase RPC/Broadcast를 유지한다.
- Firebase→Supabase는 RTDB trigger + service RPC, Supabase→Firebase는 transaction outbox + bounded worker로
  연결한다. CloudEvent-derived UUID/source UUID dedupe, Admin trigger skip, monotonic timestamp transaction으로
  retry와 mirror loop를 막는다.
- current session, membership, target membership, throwable wire entitlement, shared rate ledger를 server에서
  다시 검증한다. initial snapshot은 baseline이며 5초가 지난 animation은 억제한다.
- `configure_firebase_transient_bridge_v2`가 양방향 transient bridge만 runtime disable한다. Presence는 계속
  Supabase private Realtime이다. 날짜 기반 자동 cutoff는 없다.
- candidate fixture hash는
  `0f2845d033df248b1745c6526c8c7100b8d8fa6839b45f28c73b1023053fce2e`이며 아직 remote read-back 값이 아니다.

## 남은 차단 사항

- transient bridge migration/Functions/Rules는 staging/production에 아직 미배포다. deployed function inventory는
  9개이고 candidate 예상 inventory는 14개다.
- production old rollout은 2026-09-23 Firebase gate false → Supabase selector OFF 순서로 read-back됐다.
  migration의 fail-closed OFF precondition을 유지한 상태에서만 배포할 수 있다.
- Windows raw REST/SSE/307 fixture는 local PASS지만 실제 Windows client 연결 검증은 아직 없다.
- 10명 staging smoke와 cleanup은 PASS했다. 3,000 연결 600초 시험은 사용자 결정에 따라 M0 기능/호환
  gate에서 제외했다. 과거 2,400 연결 시험 실패는 성능 참고 기록으로만 유지한다.
- current macOS/Windows v2-capable release와 M0 이후 최종 client handoff가 없다.
- 7일은 최소 관찰 기간일 뿐 legacy 자동 종료 시점이 아니다. 활성 client capability 또는 최소 지원 버전
  강제 증거와 old↔new chat/typing/pulse/throw/Presence matrix PASS 전에는 bridge 제거 forward migration을
  만들 수 없다.

배포 순서는 old gate/selector OFF 유지 → forward migration → Functions/Rules → 새 hash/function/rules/wake
exact read-back → selector ON → Firebase gate true다. source candidate와 deployed 상태를 섞어 기록하지 않는다.
