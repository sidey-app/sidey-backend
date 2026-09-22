# Firebase v2 운영 구조

상태: **Gate 1 PASS / Supabase production M0 final safety review 대기**
기준일: 2026-09-22

## 역할 분리

1. Supabase transaction이 room, membership, profile, commerce, message 원본을 갱신한다.
2. 같은 transaction이 private schema의 durable outbox를 기록한다.
3. Edge/Functions worker가 bounded claim, exact ACK, retry와 tombstone fence를 적용한다.
4. 호환 기간의 Firebase RTDB는 server-only chat event와 access/room/chat hint만 전달한다.
5. 클라이언트는 Supabase에서 원본을 재조회하며 RTDB를 source of truth로 사용하지 않는다.

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
  `20260921133500_legacy_send_message_response_contract.sql`은 5개 local candidate다.
- Supabase Edge Functions 5개: `realtime-bootstrap`, `realtime-publish`, `realtime-publish-live`, `realtime-event`, `realtime-wake`
- Firebase unit/Rules tests, pgTAP, Edge protocol/load harness, DB concurrency tests

정확한 복구 hash와 한계는 `firebase/DEPLOYED_SOURCE_PROVENANCE.md`에 기록한다.

## 환경 상태

| 환경 | Firebase v2 상태 |
| --- | --- |
| Firebase `sidey-realtime` | Gate 1 Rules와 Functions 9개 ACTIVE, 배포 후 read-back 완료 |
| Supabase staging `fjglrvhvdthntkvrduyi` | Firebase migration 21개와 Edge Functions 5개 배포됨 |
| Supabase production `whtejsviizgejauasqqt` | Firebase migration/object/Edge Function 없음 |
| local production candidate | compatibility migration 5개와 변경된 bootstrap 계약, 아직 remote 미배포 |
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

## M0 local candidate에서 해결한 항목

- staging URL이 박힌 live publisher를 제거하고 환경별 `publisher_url` 미설정 시 fail-closed
- mixed legacy/Firebase room의 session revoke 때 legacy `structure_changed` Broadcast를 유지
- 기존 RPC shape를 보존한 `create_room_v2`, `join_room_v2`, `set_equipped_cosmetic_v2`와 exact
  `accessRevision` barrier 추가
- `current_firebase_access_revision` post-commit fallback과 `get_store_state_v2.wireCode` 추가
- `bootstrapRealtime.minimumAccessRevision` 수렴 장벽과 응답의 `accessRevision`, `wireItems` 추가
- Firebase-live room에서도 durable/structure invalidation과 typing/pulse/throw를 Supabase private Broadcast로
  계속 전달하는 강제 호환 계약 추가. 혼합 기간의 transient는 old/new 모두
  기존 authenticated Supabase RPC/Broadcast plane만 사용한다. compact `/v2/l/{room}/t|c|x` client write는
  Rules에서 거부하고 수신도 무시하며, staging-only `/v2/rooms/.../events` outbox는 compact 계약으로 취급하지
  않는다.

## 남은 차단 사항

- compatibility migration과 변경된 bootstrap Functions는 staging/production에 아직 미배포다.
- production M0용 fresh local atomic-runner rehearsal, object diff, bounded backfill, concurrent-index watchdog,
  ready/final schema hash와 legacy HTTP smoke는 PASS했다. production mutation과 remote read-back은 아직 없다.
- production active Supabase session 7,018건은 모두 `not_after`가 없어 장기 session 호환·revocation을
  production-shaped rehearsal에서 다시 검증해야 한다.
- Windows raw REST/SSE/307 fixture는 local PASS지만 실제 Windows client 연결 검증은 아직 없다.
- 10명 staging smoke와 cleanup은 PASS했다. 3,000 연결 600초 시험은 사용자 결정에 따라 M0 기능/호환
  gate에서 제외했다. 과거 2,400 연결 시험 실패는 성능 참고 기록으로만 유지한다.
- current macOS/Windows v2-capable release와 M0 이후 최종 client handoff가 없다.
- 7일은 최소 관찰 기간일 뿐 legacy 자동 종료 시점이 아니다. 활성 client capability 또는 최소 지원 버전
  강제 증거와 old↔new chat/typing/pulse/throw/Presence matrix PASS 전에는 bridge 제거 forward migration을
  만들 수 없다.

Gate 1의 `FIREBASE_READY` 판정은 유지된다. 그러나 위 M0 차단 항목을 해결하기 전에는 Supabase
production migration을 적용하거나 최종 `CLIENT_BACKEND_HANDOFF.md`를 발행하지 않는다.
