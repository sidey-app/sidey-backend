# Firebase 3,000 연결 실제 행동 부하 시험

판정: **NOT RUN — Gate 차단**

2026-09-21 현재 3,000 연결, 600초, chat/typing/throw/Supabase Presence를 모두 포함한 승인 가능한 실행 기록이 없다.

가장 가까운 증거는 2026-09-19 staging 2,400 SSE 연결 시험이다. 해당 시험은 39.735초에 가장 오래된 publisher backlog가 16,364.639ms로 15초 중단 기준을 넘겨 종료됐다. 계획한 600초의 6.62%만 실행했으며 채팅 수신 p95 14,251ms, 공 이벤트 p95 7,833ms였다. 정상 drain, 장시간 lease renewal, Presence 검증 단계에 도달하지 못했다.

따라서:

- 2,400명 안정성 PASS 아님
- 3,000명 capacity 근거 아님
- 비용 외삽 근거 아님
- production migration/cutover 승인 근거 아님

원본 실패 보고서 SHA-256: `bbc1074d8d23bdcff0387c1d6761fc1e54a2b7c6612c15efd9ecdb5127190eea`

재시험은 canonical wire contract와 P0 hardening이 완료된 exact commit에서만 수행한다. 사전에 success threshold, cleanup 확인, provider metric 보존 범위를 고정해야 한다.
