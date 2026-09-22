# Firebase v2 비용·Presence 결정

상태: **Gate 1 계약 배포 완료 / production rollout·비용 승인 미완료**
기준일: 2026-09-21

## 결정

- Supabase는 Auth, session, room, membership, profile, commerce와 3일 채팅 원문의 source of truth다.
- Firebase RTDB는 compact transient 전달 계층으로만 사용한다. 채팅 원문 history를 누적하지 않는다.
- 사용자 online/offline Presence는 Supabase private Realtime Presence로 제공한다.
- RTDB Presence heartbeat는 만들지 않는다.
- RTDB Functions는 `minInstances=0`을 유지한다. 사용자별 주기 작업이나 상시 warm instance는 승인 없이 추가하지 않는다.
- 최대 규모는 방당 12명, 사용자당 5개 방이다. 서버가 이 제한을 강제한다.
- 비용 판단은 실제 연결·다운로드·함수 호출량으로 한다. 짧은 부하 결과를 월간 비용으로 외삽하지 않는다.

## 현재 배포와의 차이

Gate 0에서 내려받은 운영 Rules는 `/v2/rooms/{room}/presence`, legacy typing/throws와 `/v2/chat/*`를
허용했다. Gate 1은 이를 제거하고 canonical `/v2/a`, `/v2/l`, `/v2/n` Rules를 production에 배포한 뒤
canonical hash를 read-back했다.

현재 released client는 Firebase v2를 사용하지 않고 기존 Supabase RPC/Broadcast/Presence 계약을
사용한다. Supabase production compatibility migration과 v2-capable client release는 아직 없다.

## 비용 검증 기준

- 10명 기능 smoke와 정리 확인
- 3,000 연결에서 chat, typing, throw, Presence를 포함한 600초 실제 행동 부하
- p95/p99, backlog age, 실패율, RTDB 연결·다운로드, Edge/Functions 호출량을 함께 기록
- 테스트 사용자·방·outbox·lease·RTDB 잔여 데이터가 0인지 사후 확인

10명 staging 기능 smoke와 cleanup은 PASS했다. 2,400 연결 시험은 39.735초에 backlog 상한을 넘겨
중단됐다. 3,000 연결 600초 시험은 실행되지 않았으므로 production M0나 비용 승인 근거가 없다.
