# SIDEY 운영 어드민과 결제 조회

- 이관 기준: [sidey-app/SIDEY](https://github.com/sidey-app/SIDEY)의 `0cfe9af6ad546d529a3495eff692f1d2c5e0a074`.
- 원문: 해당 커밋의 `docs/PRODUCT_SPEC.md`.
- 이관일: 2026-09-15.

아래 내용은 이관 시점의 서버·운영 계약을 보존한 것이다. 이후 변경은 이 비공개 저장소의 코드·migration·검증과 함께 갱신한다. 이 문서의 이관이 운영 DB나 배포 서비스를 변경했다는 의미는 아니다.

## 운영 어드민 계약

- `/Users/aryu/Documents/sidey-admin`은 배포 제품이나 웹 클라이언트가 아닌 독립 로컬 운영 도구다. 운영 Supabase 하나만 조회하며 `개요 / 채팅방 / 사용자 / 다운로드 / 결제` 메뉴를 제공한다.
- Vite·React·TypeScript와 React Query를 사용하고 route는 주소 연결만 담당한다. 메뉴별 feature가 API query, loading·empty·error·background refresh 상태와 화면 구성을 소유한다.
- Node API만 `SUPABASE_SECRET_KEY`를 읽고 브라우저 번들에는 Supabase URL·Secret Key를 포함하지 않는다. 서버는 production project ref `whtejsviizgejauasqqt`를 고정 검증하며 `127.0.0.1`에만 bind하고 Host·Origin·production CSP를 강제한다.
- 이메일은 운영 식별을 위해 전체 표시하되 값이 없는 익명 계정은 `이메일 없음`으로 표시한다. UUID는 축약 표시하고 복사할 때 전체 값을 사용한다.
- 메시지 본문, 초대 코드·hash, checkout token, 카드 정보, PortOne Store·Channel·payment 식별자는 RPC가 반환하지 않는다. 어드민에는 mutation endpoint나 삭제·환불·지급 action을 두지 않는다.
- 라이트·다크 테마를 지원하고 SIDEY 앱 아이콘과 기존 24×24 캐릭터 sprite의 첫 frame을 정수 nearest-neighbor로 사용한다.

- App Store 결제는 개요의 별도 금액 요약과 결제 메뉴의 App Store 경로에서 조회한다. 기본 환경은 Production이며 Sandbox는 명시적으로 선택한다. 구매일 KST 기간·상태·사용자/상품 검색과 25건 페이지를 제공하고 통화별 구매액·환불/회수 대상 원구매액·유효 거래 금액을 집계한다. 금액 미확인은 0원과 구분하여 합계에서 제외한다. 실제 정산·회계는 App Store Connect 보고서를 기준으로 한다.
- 검증 서버는 서명 검증한 Apple `price`(통화 단위 × 1000)·`currency`를 기존 거래 적용과 한 RPC 트랜잭션으로 저장한다. 구형 11인자 RPC 호환을 유지하고 과거 미확인 금액 보완은 service role 전용 제한 조회·금액 갱신과 순차 CLI를 사용한다. 원본 Apple transaction ID·account token·서명 본문은 브라우저 조회에 포함하지 않는다.
- 새 App Store 목록 조회는 자동 폴링·자동 재시도 없이 동작하며 같은 요청을 서버에서 합치고 30초/최대32개 결과 캐시·동시2개·8초 upstream 제한을 둔다. 개요의 App Store 요약은 기존 RPC 응답에 포함해 브라우저 요청 수를 늘리지 않는다.

## 검증 책임

- 운영 어드민: 모든 `admin_*` 조회·수집 RPC의 anon·authenticated 거부와 service role 허용, 다운로드 baseline·분리 경로·KST 경계·카운터 증가·정체·역행 거부·수집 지연을 SQL 테스트한다. 로컬 API는 환경변수 누락·잘못된 production ref·LAN Host·외부 Origin·잘못된 query와 upstream 응답을 거부해야 하며 lint·typecheck·unit·production build·Secret 번들 scan과 1280×800·1440×900의 두 테마 Playwright 검증을 통과해야 한다.

DB 권한·집계·검증 서버 테스트는 이 저장소에서 실행한다. 어드민 브라우저와 로컬 API 검사는 독립 `sidey-admin` 저장소에서 수행한다. App Store 금액 저장·과거 거래 보완·배포 순서는 [verifier 운영 문서](../services/app-store-verifier/README.md)를 따른다.

## 결제 요약 RPC 적용 순서

- `20260915000000_admin_app_store_revenue.sql`이 먼저 적용되어 App Store Production 거래의 금액 필드와 환경·구매일 인덱스가 존재해야 한다.
- 그 다음 저장소 migration 순서대로 PortOne `CARD` 지원을 포함한 `20260919151111_support_portone_card.sql`까지 적용한 뒤, `20260920125342_admin_payments_summary.sql`, `20260921024931_admin_payment_summary_concurrent_indexes.sql`, `20260921025140_admin_payment_summary_web_index.sql`을 순서대로 적용한다.
- 새 migration은 공개 카탈로그 커밋 `96f62abc0b350791de8e0d7c3b3af33f4e73dae6`의 2026-09-16 02:20:05 KST App Store 정가를 private 스냅샷으로 고정한다. 추정액은 이 가격만 사용하며 Apple이 서명한 실제 금액과 PortOne LIVE 잔액은 별도 항목으로 반환한다.
- 합산 운영 요약은 App Store Production 거래와 검증된 PortOne LIVE 주문만 사용한다. 무료·포함 지급을 포함한 `complimentary` grant와 보유권 projection은 집계하지 않는다. 유효 구매액은 App Store 유효 거래 수에 고정 정가를 적용한 금액과 PortOne 유효 잔액을 더하며, 상품별 유효 판매 수는 두 채널의 유효 거래 수를 더한다.
- PortOne 유효 건수는 현재 유효 잔액이 0원보다 큰 거래, 환불 건수는 전액·부분 환불로 잔액이 최초 결제액보다 작은 거래로 정의한다. 따라서 부분 환불 거래는 두 건수에 모두 포함될 수 있다.
- 결제 원장용 신규 index는 원장별 non-transactional migration에서 `CREATE INDEX CONCURRENTLY`로 생성한다. 각 migration은 재시도할 때 이전 실패가 남긴 invalid index를 `DROP INDEX CONCURRENTLY IF EXISTS`로 먼저 정리한다. 이 migration에 `BEGIN`·`COMMIT`을 추가하거나 일반 `DROP INDEX`·`CREATE INDEX`로 대체하면 안 된다. 적용 후에는 `pg_index.indisvalid`·`indisready`가 모두 true인지 확인한다.
- 이 변경은 검토 가능한 SQL과 로컬 검증만 준비한다. 운영 project는 미적용 상태이며, `supabase db push`나 production SQL 실행은 별도 승인 없이 하지 않는다.

격리 로컬 DB에서 합성 거래 10만 건의 실행 계획·버퍼 사용량을 재현하려면 로컬 migration을 적용한 뒤 다음을 실행한다. 스크립트는 트랜잭션 끝에서 rollback하므로 합성 거래를 남기지 않는다.

```sh
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  -v ON_ERROR_STOP=1 \
  -f scripts/supabase/admin_payments_summary_explain.sql
```
