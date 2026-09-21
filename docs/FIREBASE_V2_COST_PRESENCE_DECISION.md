# Firebase v2 비용·Presence 결정

상태: **목표 결정 고정 / 배포 계약 미동결**
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

2026-09-21에 내려받은 운영 Rules는 `/v2/rooms/{room}/presence` 쓰기를 허용한다. 이는 위 결정과 충돌한다. 같은 Rules에는 레거시 `/v2/rooms/{room}/typing|throws`와 `/v2/chat/*`도 남아 있다.

현재 private client main은 Firebase v2를 사용하지 않고 기존 Supabase RPC/Broadcast/Presence 계약을 사용한다. 따라서 레거시 RTDB 경로를 제거하기 전에 공개 클라이언트 미사용 증거와 staging 회귀 검증을 다시 고정해야 한다.

## 비용 검증 기준

- 10명 기능 smoke와 정리 확인
- 3,000 연결에서 chat, typing, throw, Presence를 포함한 600초 실제 행동 부하
- p95/p99, backlog age, 실패율, RTDB 연결·다운로드, Edge/Functions 호출량을 함께 기록
- 테스트 사용자·방·outbox·lease·RTDB 잔여 데이터가 0인지 사후 확인

2,400 연결 시험은 39.735초에 backlog 상한을 넘겨 중단됐다. 이 실패를 3,000 연결 승인이나 비용 근거로 사용할 수 없다.
