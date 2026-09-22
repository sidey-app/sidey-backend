# Firebase Realtime hardening plan

상태: **Gate 1 PASS — Supabase production M0 차단 중**

## P0 — 배포 차단

1. canonical wire 모델 선택 — **production 배포/read-back 완료**
   - 운영 `/v2/l·n`과 staging `/v2/rooms/{room}/epochs/{epoch}`를 혼용하지 않는다.
   - 선택한 모델로 Rules, Functions, Edge, 두 플랫폼 fixture를 동시에 맞춘다.
2. RTDB Presence 제거 — **production 배포/read-back 완료**
   - Supabase private Realtime Presence만 사용한다.
   - 공개 클라이언트 미사용 증거를 고정한 뒤 `/v2/rooms/*/presence` client write를 deny한다.
3. legacy RTDB chat 처리 결정 — **production 배포 완료: Rules와 trigger 제거**
   - 미사용이면 Rules와 trigger를 닫는다.
   - 유지하면 transient Supabase 오류에서 command를 삭제하지 않는 durable retry를 구현한다.
4. 재현 가능한 Firebase 배포 구성 — **production 배포/read-back 완료**
   - `sidey` database target과 `sidey-v2` codebase를 명시한다.
   - default RTDB를 가리키는 target 없는 deploy를 금지한다.
   - Rules emulator는 `demo-*` project만 사용한다.

## P1 — 보안·정합성

- typing connection key를 `sideySessionId` claim과 동일한 session별 고정 slot으로 바꾼다. **local 완료**
- 한 사용자당 mirror session 수는 16개로 정한다. Functions의 결정적 16개 projection과 revoked typing slot durable cleanup은 **local 완료**, DB source lifecycle/상한은 Gate 2 forward-only migration 대상이다.
- staging smoke에 정확한 staging project hostname과 mutation opt-in을 강제한다.
- Auth 사용자 생성 요청 전에 generated email을 cleanup journal에 기록하고, Firebase Admin UID cleanup과 Supabase/Firebase Auth·room·exact RTDB path read-back을 수행한다. service-role 전용 status/finalizer가 test-owned access/room/chat outbox exact ACK와 source 삭제를 같은 transaction에서 확인한 뒤 queue tombstone을 제거하므로 daily reconcile 재생성도 차단한다. **local migration/script 완료 / remote 미실행**
- account suspension, A/B session, tombstone/late worker 회귀 테스트를 추가한다. **local 완료**
- Windows REST/SSE/redirect 회귀 테스트는 **local 완료**다.
- 10명 smoke 후 임시 Auth/Firebase/Supabase 잔여 데이터 0을 확인한다. **완료**

## P2 — 운영 위생

- Functions package에서 `test/**`, `*.log`, `.env*`, cache, `node_modules`를 명시적으로 제외한다. **local 완료**
- room/user/message 식별자를 immediate publication 로그에서 제거한다. **local 완료**
- bootstrap limiter를 `/v2/a/b/{uid}`로 이동하고 계정 비활성화 cleanup을 추가한다. **local 완료**
- room별 claim 직렬화와 worker timeout 관계를 회귀 테스트로 고정한다.

## 완료 조건

- Functions unit/syntax, Rules emulator, Edge type check, pgTAP, DB concurrency 모두 PASS
- current client legacy fixture가 migration 전후 동일
- 10명 staging smoke와 cleanup PASS
- 3,000 연결 실제 행동 부하 600초 완료 및 사전에 정한 성능/적체 기준 PASS
- 배포 대상, Rules hash, function revision, rollback 명령을 `FIREBASE_READY_HANDOFF.md`에 기록

## M0 전 차단 조건

- local 22번째 compatibility migration을 production-shaped snapshot에서 rehearsal하고 기존 client 계약을
  다시 실행한다.
- 변경된 `bootstrapRealtime` grant barrier를 staging에 배포·read-back하고 v2 smoke를 반복한다.
- migration SQL, object diff, `messages` backfill/index와 trigger 설치의 lock/예상 시간을 측정한다.
- 3,000 연결, 600초 실제 행동 부하를 PASS해야 한다. 2,400 연결 시험은 39.735초에 oldest backlog가
  15초 상한을 넘어 실패했으므로 대체 증거가 아니다.
- 위 조건과 명시적 production 승인 전에는 M0를 적용하지 않는다. 최종
  `CLIENT_BACKEND_HANDOFF.md`는 M0 적용 및 remote read-back 뒤에만 발행한다.
