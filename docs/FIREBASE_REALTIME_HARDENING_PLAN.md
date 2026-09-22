# Firebase Realtime hardening plan

상태: **Gate 1/M0 완료 — transient bridge source candidate 미배포**

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
- 새 client의 t/c/x와 old Supabase client를 server bridge로 양방향 연결한다. CloudEvent/source event UUID
  dedupe, Admin loop skip, current session/membership/entitlement/rate 재검증, 5초 freshness를 적용한다.
  **local Functions/Rules/pgTAP 완료 / remote 미배포**

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

## transient bridge 배포 전 차단 조건

- old Firebase gate false와 Supabase selector OFF를 exact read-back한 상태에서만 forward migration을 적용한다.
- migration `20260922192118`, Functions 예상 14개와 새 Rules를 배포한 뒤 새 contract hash, function inventory,
  Rules와 wake URL을 exact read-back한다.
- selector ON 뒤 Firebase gate true 순서를 지키고, old↔new chat/typing/pulse/throw/Presence matrix를 확인한다.
- 7일은 최소 관찰 기간이며 날짜만으로 bridge를 끄지 않는다. capability/최소 지원 버전 증거가 있어야 별도
  forward migration으로 legacy transient bridge를 제거할 수 있다.
