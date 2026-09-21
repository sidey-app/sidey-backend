# Firebase v2 운영 구조

상태: **Gate 1 local implementation 진행 중 / remote 미배포**
기준일: 2026-09-21

## 역할 분리

1. Supabase transaction이 room, membership, profile, commerce, message 원본을 갱신한다.
2. 같은 transaction이 private schema의 durable outbox를 기록한다.
3. Edge/Functions worker가 bounded claim, exact ACK, retry와 tombstone fence를 적용한다.
4. Firebase RTDB는 compact event와 access hint만 전달한다.
5. 클라이언트는 Supabase에서 원본을 재조회하며 RTDB를 source of truth로 사용하지 않는다.

## 복구된 구성

- Firebase Functions v2 10개, Node.js 22, `asia-southeast1`, codebase `sidey-v2`
- 운영 RTDB Rules 한 벌
- Supabase staging migration 19개
- Supabase Edge Functions 5개: `realtime-bootstrap`, `realtime-publish`, `realtime-publish-live`, `realtime-event`, `realtime-wake`
- Firebase unit/Rules tests, pgTAP, Edge protocol/load harness, DB concurrency tests

정확한 복구 hash와 한계는 `firebase/DEPLOYED_SOURCE_PROVENANCE.md`에 기록한다.

## 환경 상태

| 환경 | Firebase v2 상태 |
| --- | --- |
| Firebase `sidey-realtime` | Rules와 Functions 10개가 이미 배포됨 |
| Supabase staging `fjglrvhvdthntkvrduyi` | migration 19개와 Edge Functions 5개 배포됨 |
| Supabase production `whtejsviizgejauasqqt` | Firebase migration/object/Edge Function 없음 |
| current private client main | Firebase adapter 없음. legacy Supabase 계약만 사용 |

## 안전 불변식

- room 최대 12명, 사용자 최대 5개 room을 DB에서 강제
- access removal, revoke, suspend는 grant보다 우선하고 fail-closed
- outbox는 durable/idempotent이며 ACK는 exact claim에만 적용
- stale worker가 최신 revision/epoch/tombstone을 덮어쓰지 못함
- 외부 HTTP는 source transaction 안에서 호출하지 않음
- service-role 비밀과 upstream 오류 본문을 로그나 응답에 남기지 않음
- `realtime` schema를 Firebase 내부 큐로 사용하지 않음

## Gate 1 local candidate에서 해결한 항목

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
- staging smoke가 exact outbox ACK를 확인하고 삭제된 test-owned queue tombstone을 transactionally 제거할 service-role 전용 forward migration 추가(운영 Supabase 미적용)

## 남은 차단 사항

- local candidate가 Firebase production에 배포·재조회 검증되지 않음
- staging Edge Functions의 비활성 실험 path는 Gate 2 정리/호환 검토 대상임
- DB snapshot source의 session lifecycle/16개 상한은 production Supabase를 수정하지 않는 Gate 1에서는 아직 미적용이다. Functions는 최대 128개 source session을 검증한 뒤 expiry 우선으로 16개만 mirror하며, 이를 넘는 비정상 payload만 deny-all quarantine한다.
- Windows raw REST/SSE/307 fixture는 local PASS지만 실제 Windows client 연결 검증은 아직 없음
- 10명 staging smoke와 temporary account/data cleanup 증거가 없음
- 3,000 연결 성공 보고서가 없음
- current macOS/Windows Firebase adapter와 frozen cross-platform fixture가 없음

이 항목을 해결하기 전에는 `FIREBASE_READY`가 아니며 production migration으로 넘어가지 않는다.
