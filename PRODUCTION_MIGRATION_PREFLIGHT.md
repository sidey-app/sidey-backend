# Supabase production M0 preflight

상태: **COMPLETE — M0 적용·history/schema/read-back PASS, rollout OFF**
기준일: 2026-09-22
대상: Supabase production `whtejsviizgejauasqqt`

## 결과

독립 safety review를 통과한 production 전용 atomic runner로 phase 26개, historical history repair 21개,
compatibility candidate 5개를 완료했다. historical SQL은 production에 재생하지 않았다. 최종 migration
history는 `93`개(`20260829000000`..`20260921142300`), private table은 `25`개, canonical app+Realtime
fingerprint는 `6425dcd8ebeafdeb0890d34780355fe20de6903da891e34af3d19d635da28948`다.
`messages.sequence` NULL/invalid는 `0`, unique index는 valid/ready/unique다.

두 lock deadlock과 backfill/index 응답 유실은 아래에 보존된 exact checkpoint 설계로 분석·수정·재개했다.
commerce/auth critical identity와 ownership invariant는 JIT backup→partial states→final replay와 production
read-back에서 보존됐다. M0 뒤 Firebase Functions 9개도 production Supabase secret version 3을 참조하도록
발행했다. selector는 `enabled=false`, `kill_switch=true`, cohort `0`; Firebase global gate는 false다.
따라서 이 M0 완료 시점은 client rollout `T0`가 아니다.

아래 상세 내용은 적용 전 위험 분석과 실제 resume 설계의 provenance다. 새 production에 그대로 실행하는
일반 runbook으로 재사용하면 안 된다. staging historical migration 21개를 표준
`db push --include-all`로 재생하는 방식도 계속 금지한다.

## pre-M0 read-only inventory

- production은 ACTIVE/healthy이며 기존 commerce/admin migration이 Firebase migration timestamp 사이에
  별도로 존재한다.
- Firebase private table/routine은 0개다.
- active Auth session은 7,018건이며 7,018건 모두 `not_after`가 없다.
- `public.messages`는 read-only snapshot에서 exact 183,881행이었고 별도 snapshot에서는 183,820행이었다.
  조회 사이에도 쓰기가 계속되고 있으므로 고정값으로 취급하지 않는다. 현재 heap 55.61 MiB, index
  60.92 MiB, total 116.58 MiB이며 statistics estimate는 약 229k~231k행이다. exact count와 estimate
  차이가 있어 rehearsal은 현재 물리 크기와 보수적인 estimate를 둘 다 사용한다.
- message가 있는 room은 1,308개이며 room별 최대 2,949행, p95 약 656행, p99 약 1,405행이다.
- `public.rooms`는 exact 3,113행이다.
- 기존 SIDEY Realtime RLS policy는 2개다.
- default RTDB는 대상이 아니며 Firebase regional instance `sidey`만 사용한다.

고객 row나 secret은 보고서에 저장하지 않았다.

## 그대로 적용할 수 없는 이유

1. `20260920104030_firebase_v2_compact_throw_chat_publish.sql`
   - `public.messages`에 `SHARE ROW EXCLUSIVE` lock을 잡는다.
   - 전체 message를 window function으로 backfill한다.
   - 같은 transaction에서 `NOT NULL`, constraint와 non-concurrent unique index를 만든다.
   - row count/heap size별 실제 lock 시간을 아직 측정하지 않았다.
2. `20260920085650_firebase_presence_inbox_delivery.sql`
   - 기존 `realtime.messages` select/insert policy를 drop/recreate한다.
   - current client Presence/Broadcast를 동시에 검증하지 않은 채 실행하면 기존 사용자 연결을 끊을 수 있다.
3. `20260919050000_firebase_edge_region.sql`
   - historical source에 staging project URL이 박혀 있다.
   - feature default는 OFF지만 production migration history에 staging-only implementation을 재생하면 안 된다.
4. staging은 Firebase migration 21개를 이미 적용했으므로 그 파일을 수정할 수 없다.

## 필요한 production 전용 적용 경로

1. 기존 21개 파일과 local candidate migration `20260921102516`, `20260921110000`,
   `20260921132018`, `20260921133000`, `20260921133500`은 수정하지 않는다.
2. 새 production phase migration은 Firebase object가 완전히 없는 `EMPTY` 또는 이미 최종 contract인
   `READY` 상태만 허용한다. `EMPTY`에서는 post-21/pre-102516 baseline을 만들고, `READY`에서는 exact
   fingerprint를 검증한 뒤 no-op한다. 부분 적용 상태는 아래처럼 exact history+schema checkpoint가 별도로
   pin된 경우에만 재개하며, 그 외에는 즉시 실패한다. 광범위한 `IF NOT EXISTS`로 drift를 숨기지 않는다.
3. production에 이미 기록된 41개 migration과 새 phase 26개의 SHA를 pin한다. 표준 `db push`는 사용하지
   않는다. `scripts/supabase/firebase_m0_apply.py`는 history가 approved prefix인지 먼저 확인한 직후, 어떤
   helper cleanup/install/DDL보다 먼저 그 prefix의 pinned app+Realtime fingerprint, live config
   `enabled=false`/`direct_events_enabled=false`, dispatch singleton과 empty cohort를
   검증한다. 현재 허용된 partial resume는 base 0, prefix 13, prefix 16, prefix 17이며 다른 partial phase
   prefix는 새 checkpoint review 없이는 fail-closed한다. prefix 13은 clean schema SHA `6bca8bf8...` 또는
   crash 뒤 남은 exact atomic helper SHA `6953e8c9...`만 허용한다. prefix 16은 index 생성 전
   `d0e32cda...`/helper `2ff6af42...`와 index 생성 성공·history 미기록 상태
   `17448179...`/helper `0881177a...`를 서로 다른 exact checkpoint로 허용한다. prefix 17은 index history까지
   commit됐지만 client 응답이 유실된 clean `17448179...`만 허용하며 helper variant는 거부한다. 현재
   production read-back은 prefix 16 object 22, Realtime `b2ea5e5b...`, index absent, nullable sequence다.
   그 뒤 단일문장 atomic runner가 DDL과 migration history를 같은 server transaction에 기록하고, 각 phase 뒤
   exact-prefix history를 다시 읽는다.
4. phase 적용 뒤 ready schema는 Firebase private table 23개와 pinned dump SHA를 모두 만족해야 한다. 그
   다음에만 historical Firebase 21개를 history repair로 기록하며 historical SQL은 재생하지 않는다.
5. compatibility candidate 5개는 같은 atomic runner로 순서대로 적용한다. 최종 schema는 Firebase private
   table 25개와 별도 pinned final dump SHA를 만족해야 한다. ready 23과 final 25는 혼용하지 않는다.
   schema fingerprint는 canonicalizer v2를 고정한다. app-owned `public,private,auth` dump와 별도
   single-statement `realtime` catalog contract를 결합해 hash한다. app dump canonicalizer는 restore 과정에서
   표기만 달라지는
   `app_store_transactions_id_length`, `commerce_payments_portone_fields` CHECK의 승인된 두 full-line variant를
   각각 정확히 한 번만 sentinel 처리하고 SQL lexical top-level blank separator/EOF만 정규화한다. 그 외
   function/string/comment/CRLF, ACL, policy, enum, object DDL은 바이트 그대로 hash에 남긴다. 두 CHECK catalog
   metadata/definition과 `auth.factor_type` enum 순서는 base/ready/final마다 별도 exact read-back한다.
   Supabase가 매일 교체하는 7개 Realtime partition 이름은 stable hash에서 제외하되, 같은 snapshot query에서
   연속 bounds, today/tomorrow coverage, attachment, owner/columns, PK/partial-index, ACL을 모두 fail-closed 검증한다.
   base Realtime contract `620204f5...`와 policy 확장 뒤 ready/final `b2ea5e5b...`는 state별로 따로 pin한다.
6. `messages.sequence`는 nullable additive column → bounded room batch backfill → pg_cron 단일문장 concurrent
   unique index → `ADD ... NOT VALID` → 별도 `VALIDATE` transaction → validated proof 기반의 짧은
   `SET NOT NULL`/finalize 순서다. concurrent index는 5초 lock-wait/600초 total watchdog이 서버에서
   `pg_cancel_backend`하고, crash 뒤 남은 exact cron job도 resume 진입에서 먼저 제거한다.
7. Realtime policy는 current policy를 canonical diff로 확인하고 같은 transaction에서 additive predicate로
   교체한 뒤 legacy and v2 authorization smoke를 즉시 실행한다.
8. live publisher URL은 `NULL`로 시작하고 explicit canary 때만 production ref URL을 넣는다.
9. legacy transport는 기본값으로 유지하고 v2 worker/flag는 OFF 또는 dark 상태로 시작한다.
10. bridge에는 runtime cutoff를 두지 않는다. 이 기간에는 `message_changed`/`messages_pruned`/
    `structure_changed`와 typing/pulse/throw를 Supabase private Broadcast로 계속 전달하고 compact
    `/v2/l/{room}/t|c|x` client write는 Firebase Rules에서 거부한다. 7일은 최소 관찰 기간일 뿐 자동 종료
    시점이 아니다. 활성 client capability 또는 최소 지원 버전 강제 증거와 old↔new matrix PASS 뒤에만
    별도 reviewed forward migration으로 bridge를 제거한다.

`supabase migration squash` 출력은 apply artifact로 사용하지 않는다. DML이 누락될 수 있어 config singleton,
wire-code seed, initial room revision, sequence 초기화가 사라질 수 있다. schema diff 참고 자료로만 사용한다.

### production phase 구성

1. foundation: Firebase private object와 config를 OFF/`publisher_url = NULL`로 생성한다. 7,018 users 전체를
   access outbox에 미리 넣지 않는다. room seed가 필요하면 현재 room을 bounded batch로 처리한다.
2. sequence prepare: nullable column과 신규 legacy insert용 임시 sequence trigger, 안정적인
   `(room_id, created_at, id)` target map을 만든다.
3. resumable backfill: room 또는 bounded room batch 단위로 진행하고 timeout, progress, read-back을 기록한다.
   일반 read-only query는 90초 제한을 유지하되 이 bounded backfill RPC만 client timeout을 660초로 둔다.
   응답 유실 전에 server commit이 끝난 경우에도 다음 호출은 NULL sequence가 남은 room만 처리한다.
4. concurrent index: transaction 밖 pg_cron 단일문장과 watchdog으로 만들고 invalid index/history-loss/
   stale-job resume를 검증한다. CREATE 성공 뒤 응답 유실은 valid/ready/definition exact read-back 후 동일
   index OID를 유지한 채 history만 기록하고, history INSERT commit 뒤 응답 유실은 prefix 17 checkpoint에서
   index/backfill 단계를 건너뛴다.
5. constraint add: body/sequence proof를 `NOT VALID`로 추가한 뒤 commit한다.
6. constraint validate: write-compatible validation을 별도 history boundary에서 끝낸다.
7. sequence finalize: validated proof를 사용해 짧은 lock 안에서 `SET NOT NULL`, old constraint/proof drop,
   high-water와 dual-write trigger를 고정한다.
8. contract/trigger/policy를 작은 transaction으로 나눠 설치하고 legacy authorization predicate를 보존한다.

historical repair 대상은 아래 21개로 고정한다.

```text
20260918000000 20260918010000 20260919000000 20260919010000
20260919020000 20260919030000 20260919040000 20260919050000
20260919060000 20260919135013 20260919165358 20260919224714
20260920060949 20260920085650 20260920095057 20260920104030
20260920110649 20260920111743 20260921020848 20260921070000
20260921070944
```

## candidate object diff

- `private`: access/room/chat outbox, exact ACK/delivery/finalizer, revision/tombstone/session cleanup,
  staging live experiment tables/functions(OFF), retention helpers
- `public`: service-role worker RPC, v2 bootstrap snapshot, chat persistence, additive v2 room/equip/store RPC
- `public.rooms`: `realtime_epoch` 기반 room fencing
- `public.messages`: safe integer room sequence와 idempotent client UUID 계약
- `public.commerce_products`: permanent per-kind `wire_code`
- `realtime.messages`: legacy topic 보존 + per-user epoch Presence topic authorization
- triggers: membership/profile/entitlement/session/account/message/room mutation에서 durable outbox enqueue

production schema-only snapshot과 candidate 전 ready schema의 `public,private` review diff를 생성했다. 현재 diff는
4,344줄이며 Firebase private table 23개, 이름에 Firebase가 포함된 public/private routine 72개,
관련 trigger 22개, 관련 index 12개를 포함한다. 이 23-table artifact는 final 25-table fingerprint가 아니다.
review artifact SHA-256은
`7cb070480c396336dc37ff24753f8df8ac4c13fca03700396814482cb355931c`다. 이 artifact는 `/private/tmp`의
비커밋 산출물이며 CLI가 명시하듯 portable apply script가 아니다. default privilege와 Firebase와 무관한
grant/revoke 차이도 섞여 있으므로 그대로 실행하지 않는다. curated production baseline과 exact object
count는 production-shaped rehearsal에서 다시 고정한다.

## rollback 원칙

- 첫 대응은 protocol/canary/live dispatch flag OFF다. legacy transport는 계속 기본값이다.
- 이미 적용된 migration을 down migration으로 되돌리거나 table/column을 drop하지 않는다.
- worker 오류는 outbox에 남기고 forward fix한다. 권한 이상은 fail-closed한다.
- publisher URL을 `NULL`로 되돌리고 Firebase listener rollout을 중단할 수 있어야 한다.
- schema/history repair 자체의 rollback은 임의 delete가 아니라 M0 전 database backup/PITR과 Supabase 지원
  절차를 사용한다.

## 현재 검증 증거

| 검증 | 결과 |
| --- | --- |
| clean local reset | PASS |
| pgTAP | PASS `703/703` (`26` files) |
| DB lint error | `0` |
| Functions syntax/unit/contract | PASS `79/79` |
| RTDB Rules emulator (`demo-sidey`) | PASS `12/12`; emergency global kill listener cancellation 포함 |
| DB concurrency | PASS; 20k bounded fixture backfill 20,000/remaining 0, historical broadcast 0, 신규 insert broadcast 1, blocked-index cancel 5.063s/5.048s |
| exact schema/history | PASS; canonicalizer v2 app+Realtime fingerprint base 0/`75146abb...`, ready 23/`5de13823...`, final 25/`6425dcd8...`; base→ready Realtime 변경은 Sidey policy 2필드뿐, history 93, stale cron 0 |
| released legacy PostgREST | PASS; `send_message` single object, exact 6 keys |
| 10-user staging smoke/cleanup | Gate 1 PASS |
| `141300` lock-order/resume | PASS; auth→rooms/rooms→auth 및 rooms→Realtime/Realtime→rooms `40P01` 재현, Realtime→rooms→auth 각 path·동시 overlap no-deadlock, 첫 락 5초 timeout catalog byte-identical 후 exact resume |
| prefix13 pre-mutation checkpoint | PASS; JIT clean replay object 20/`6bca8bf8...`, current production exact-helper `6953e8c9...`, Realtime `620204f5...`; schema/live-config/dispatch/cohort drift 시 cleanup/helper/DDL 0 |
| prefix16 pre-mutation checkpoint | PASS; clean replay object 22/`d0e32cda...`, 당시 production exact-helper `2ff6af42...`, Realtime `b2ea5e5b...`; history 57, index absent, sequence nullable, NULL messages 14,403, remaining rooms 93; 독립 review 뒤 resume 완료 |
| concurrent index crash checkpoints | PASS locally; prefix16 index-present clean/helper `17448179...`/`0881177a...`, prefix17 clean `17448179...`; prefix17 resume는 `NULL sequence=0`, invalid sequence=0, remaining rooms=0도 mutation 전에 확인; full apply reentry CREATE/DROP 0, JIT index OID `59551` unchanged in both paths |
| production prefix13 replay | PASS; prefix13 history에서 remaining 13 phases + repair21 + candidate5, sequence/index/final fingerprint exact |
| production prefix16 partial replay | PASS; 25 rooms/7,648 messages commit 뒤 응답 유실을 재현하고 45 batches/144,296 messages를 재개해 remaining 0, phases 16..25 + candidate 5 완료 |
| commerce/auth preservation | PASS; JIT backup→live prefix13 existing critical identity missing `0`, first13 replay delta `0`, prefix16 partial/index-gap/history-gap→final critical set delta `0`, equipped ownership invalid `0` |
| JIT logical backup | PASS; `/private/tmp/sidey-prod-jit-vY54jE/database.dump`, 122,842,146 bytes, mode `0600`, SHA-256 `573e5d229805bf5077a6285f624b3b86e34f3ab5acfe647b7bb56b106e63bbbf` |
| 3,000 × 600s behavior load | NOT RUN |
| closest 2,400 run | FAIL at 39.735s, backlog 16,364.639ms > 15s limit |

3,000×600 검증의 canonical topology, workload counts, RTDB paths/payload, source/deployment hash 및
quota/cost/read-back gate, 95초 이상 cleanup convergence, fail-closed verdict core는 unit test `16/16`을
통과했다. 이는 network runner나 실제 부하 PASS를 뜻하지 않는다.

## M0 완료 gate

- production history `93`, final fingerprint `6425dcd8...`, private table `25` exact read-back PASS
- sequence NULL/invalid `0`, unique index valid/ready/unique PASS
- commerce/auth critical identity와 ownership preservation PASS
- rollout `enabled=false`/`kill_switch=true`/cohort `0`, live/dispatch OFF, Firebase global gate false PASS
- production authenticated OFF/bootstrap409/legacy scalar-object smoke와 test-scope residual `0` PASS
- Functions 9 ACTIVE, production Supabase secret version `3`, Rules source/remote canonical match PASS

JIT logical backup은 M0 이후 physical backup `COMPLETED` 확인 전까지 삭제하지 않는다. M0는 7일 유예의
`T0`가 아니다. client rollout과 production cutover는 각각 별도 승인 단계이며 current contract는
`CLIENT_BACKEND_HANDOFF.md`를 따른다.
