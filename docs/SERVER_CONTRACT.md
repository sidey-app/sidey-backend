# SIDEY 서버 계약

- 이관 기준: [sidey-app/SIDEY](https://github.com/sidey-app/SIDEY)의 `0cfe9af6ad546d529a3495eff692f1d2c5e0a074`.
- 원문: 해당 커밋의 `docs/PRODUCT_SPEC.md`.
- 이관일: 2026-09-15.

아래 내용은 이관 시점의 서버·운영 계약을 보존한 것이다. 이후 변경은 이 비공개 저장소의 코드·migration·검증과 함께 갱신한다. 이 문서의 이관이 운영 DB나 배포 서비스를 변경했다는 의미는 아니다.

## 서버 구현과 변경 이력

`20260831030000_expand_room_capacity_and_reduce_message_retention.sql`은 방 정원 12명과 당시 메시지 7일 보관을 적용했다. `20260901000000_security_hardening.sql`은 적용된 migration을 수정하지 않는 forward-only 보정이며 다음 계약을 추가했다.

- 사용자당 최대 5개 방
- private invite HMAC 비교, 128-bit 코드와 사용자 단위 직렬 rate limit
- 방 및 사용자 단위 transaction advisory lock
- RLS와 함수 실행 권한
- 중복 닉네임과 중복 캐릭터 선택 허용
- 닉네임 2~8자 제한과 기존 9~12자 닉네임의 앞 8자 migration
- membership 변경 시 증가하는 `realtime_epoch`, 서버 전용 DB event와 RPC 검증 transient event
- 메시지 UUID 멱등성과 서버 rate limit, 보관 정리 시 방별 단일 invalidation event
- 7일 초과·프로필 없음·방 없음인 미완성 익명 가입만 삭제
- `rename_room(uuid,text)`, `remove_room_member(uuid,uuid)`, 방장 전용 `delete_room(uuid) returns void`; 삭제는 기존 FK cascade로 방 멤버십과 메시지를 함께 제거

commerce는 다음 현행 계약을 유지한다. 적용된 migration과 과거 결제·가격·정책 동의 원문은 감사 이력으로 보존하고 변경은 forward-only로 적용한다.

- production은 `sales_enabled=false`와 PortOne 시크릿 미설정에서 실패 폐쇄한다. 판매 잠금은 이미 보유한 상품의 선택·장착을 막지 않는다.
- 주문 가격은 서버의 활성 catalog 가격을 사용한다. `upsert_profile`과 꾸미기 장착 RPC는 현재 계정의 활성 entitlement를 검사한다.
- PortOne·App Store·complimentary 지급은 출처별 원장에 기록하고, 클라이언트는 RLS가 적용된 유효 소유권 projection을 읽는다. 주문 없는 지급도 출처와 지급 근거를 보존하며 한 출처의 환불이 다른 활성 지급을 회수하지 않는다.
- PortOne V2 결제 상태에는 payment ID, Store ID, Channel Key, V2, TEST/LIVE, 상태, KRW, 서버 주문 금액, `EASY_PAY` 일치를 요구한다. event ID와 payload hash를 함께 저장해 중복 웹훅과 상충 payload를 분리한다.
- 새 checkout은 현행 정책 버전과 제공 시작·환불 조건에 대한 동의를 기록하며 기존 주문에 저장된 결제 당시 동의 원문은 바꾸지 않는다.

forward-only `20260903010000_character_throw.sql`은 `broadcast_character_throw(p_room_id, p_realtime_epoch, p_event_id, p_target_user_id)` 전용 RPC를 추가한다. 서버는 인증, 최신 room epoch, 송신자·대상 멤버십, 자기 자신 대상 금지와 필수 UUID를 검증하고 송신자 프로필에서 `source_character_id`를 읽는다. 송신자당 10초 20회 제한을 적용한 뒤 schema version, room/event/actor/target UUID와 source character ID만 현재 private ephemeral topic의 `character_throw`로 발행한다. 이벤트는 Postgres 메시지나 기록에 저장하지 않고 재접속 뒤 재생하지 않는다.

forward-only `20260904000000_app_store_foundation.sql`은 다음 계약을 추가한다.

- `private.commerce_grants`가 PortOne·App Store·complimentary 지급을 출처별로 보존하고 `public.commerce_entitlements`는 활성 grant 존재 여부를 보여주는 RLS projection으로 바뀐다.
- `private.app_store_transactions`와 `private.app_store_notification_events`가 transaction·notification 멱등성, 환불, 삭제 후 unbind와 복원을 기록한다. 일반 사용자는 이 원장을 읽거나 변경할 수 없다.
- service role 전용 `admin_apply_app_store_transaction`은 검증 서비스가 전달한 bundle 고정 상품, environment, transaction ID, app account token과 서명 시각을 적용한다. 신규 구매의 app account token은 현재 Supabase UUID와 일치해야 하며 활성 계정에 묶인 transaction은 다른 계정에 지급하지 않는다.
- 유료 계정을 삭제할 수 있도록 order 감사 기록은 사용자 연결을 끊어 보존하고, auth 사용자 삭제 trigger가 모든 방의 소유권 이전·빈 방 삭제와 App Store transaction unbind를 같은 DB 삭제 흐름에서 수행한다.

forward-only `20260905000000_cosmetics_catalog_and_equipment.sql`은 상품을 `character / bubble / throwable`, `catalog_item_id`, `sort_order`의 범용 catalog로 확장하고 말풍선 3종·투척물 3종과 활성 가격을 추가한다. 신규 주문의 정책 버전은 `2026-09-05-cosmetics-v1`이며 기존 주문 고지는 보존하고 `디지털 꾸미기 사용권`으로 일반화한다. `get_store_state()`는 한 번에 전체 catalog·소유·장착 상태를 반환한다. 프로필에는 nullable `equipped_bubble_style_id`와 `equipped_throwable_id`, 메시지에는 발송 당시 nullable `bubble_style_id`를 저장한다. `set_equipped_cosmetic`은 활성 entitlement를 서버에서 검사하며 환불·회수된 장착 상품은 즉시 null로 되돌린다. PortOne 승인 상품은 즉시 자동 장착한다.

forward-only `20260905010000_settings_retention_contract.sql`은 미니 대포의 기존 3,900원 가격 이력을 보존·비활성화하고 2,900원 활성 가격을 추가한다. `set_equipped_cosmetic(text, text default null)`로 기본 꾸미기 복귀의 생략·명시적 null 호출을 함께 지원하고 PostgREST schema cache를 갱신한다. 메시지 보관 함수는 3일 기준으로 교체하며 적용 즉시 기존 3일 초과 메시지를 영구 삭제한다. 변경된 방마다 기존 `messages_pruned` invalidation event 하나만 발행하는 계약은 유지한다.

기존 `send_message(p_id,p_room_id,p_body)`와 `broadcast_character_throw(p_room_id,p_realtime_epoch,p_event_id,p_target_user_id)` 인자는 바꾸지 않는다. `send_message`는 최초 insert에서 서버가 확인한 말풍선 스타일을 snapshot하고 같은 UUID 재시도는 저장된 행을 그대로 반환한다. throw RPC는 기존 인증·membership·epoch·rate limit 검증 뒤 서버가 확인한 장착 투척물만 optional `throwable_id`로 추가한다. 현행 `20260912000000_character_keepsakes.sql` 이후 미장착·미소유·알 수 없는 값은 모든 캐릭터에서 `patch_soft_ball`로 fallback한다. App Store transaction 원장은 상품 원본에서 생성한 현재 판매 및 과거 복원용 Apple ID만 받는다.

`services/app-store-verifier`는 Apple 공식 Node App Store Server Library로 기기 JWS와 Server Notifications V2를 검증하고 App Store Server API에서 transaction을 다시 조회한다. Production과 Sandbox 서비스·키를 분리하며 bundle ID, app Apple ID, product ID, environment와 서명을 모두 확인한다. 계정 삭제 endpoint는 새 Sign in with Apple token의 subject를 현재 Supabase Apple identity와 비교하고 Apple token 철회 뒤 Auth 사용자를 삭제한다.

Edge Functions는 책임을 다음처럼 분리한다.

- `commerce-order`: 인증·Google 연결·상품·소유 여부를 확인하고 서버 가격의 PortOne `paymentId`와 256-bit checkout token hash를 생성한다.
- `commerce-checkout`: token과 정책 동의를 확인한 뒤 `store_id`, `channel_key`, `payment_id`, 서버 가격, `CURRENCY_KRW`, `EASY_PAY`, redirect URL을 반환한다.
- `commerce-complete`: PortOne API에서 결제를 재조회하고 모든 결제 사실이 일치할 때만 entitlement를 지급한다.
- `commerce-webhook`: `jsr:@portone/server-sdk@0.19.0`으로 raw body 서명을 검증한 뒤 PortOne API를 다시 조회한다.
- `commerce-refund`: 별도 운영 키와 멱등키를 요구하고 PortOne 전액 취소·재조회가 확인된 뒤 purchase entitlement만 회수한다.
- `download-metrics-ingest`: GitHub Actions 전용 ingest key를 검사한 뒤 service role로 누적 asset snapshot을 기록한다. 15분 수집 실패는 GitHub 설치 자산 제공과 완전히 분리한다.

`20260903010000_admin_observability.sql`은 private download snapshot과 service role 전용 `admin_overview`, `admin_rooms`, `admin_room_members`, `admin_users`, `admin_downloads`, `admin_payments`, `admin_ingest_download_metrics`를 추가한다. `anon`과 일반 `authenticated`에는 모든 함수 실행 권한을 명시적으로 회수한다. 검색·상태·기간·정렬·page size는 Node API와 SQL 양쪽에서 allowlist 검증한다.

GitHub download collector는 정식 Release만 읽고 `SIDEY-macOS-arm64-v<version>.dmg`, `SIDEY-macOS-arm64-v<version>-homebrew.dmg`, `SIDEY-Windows-x64-v<version>.msi`, `SIDEY-Windows-x64-v<version>-Setup.exe`만 집계한다. Windows MSI와 Setup EXE는 기존 `windows_msi` 지표 키 아래 하나의 Windows 설치 채널로 연속 집계한다. 같은 macOS Release에 Homebrew 전용 자산이 없으면 해당 DMG의 기존 누적 수는 직접·Homebrew가 섞인 `legacy_unclassified`로 보존한다. 자산별 최초 snapshot은 누적 총계 baseline으로만 사용하고 관측 전 다운로드를 수집 당일 증가량으로 재분류하지 않는다. 이후 일별·오늘 수치는 Asia/Seoul 자정 전후 snapshot 차이이며 최대 약 15분의 경계 오차와 마지막 수집 시각을 함께 보여준다. 현재 `sidey-app/tap`은 third-party tap이므로 `homebrew/homebrew-cask` 공식 30/90/365일 익명 통계를 제공받지 못하며, 공식 Cask 편입 전에는 교차 확인 수치를 비워 둔다.

## 서버 검증 기준

- 서버: 실제 anon/authenticated role의 RLS, 12번째 성공·13번째 거부와 여섯 번째 방 경합, 병렬 초대 제한, invite hash API 비노출, current epoch topic 권한, client Broadcast INSERT 봉쇄, transient event whitelist·rate, `broadcast_character_throw`의 인증·epoch·양쪽 membership·자기 대상·필수 UUID·20회/10초 제한과 서버 source character, 메시지 멱등성·rate, 3일 retention, 비방장 관리 거부와 cascade를 SQL 테스트한다.

서버 자동 검증은 이 저장소의 Supabase reset·pgTAP·동시 트랜잭션 테스트가 담당한다. 클라이언트 재접속·렌더링 검증은 공개 SIDEY 저장소에서 계속 수행한다.

## 나무 이동 상태 공유

`profiles.tree_movement_paused`는 계정 단위 boolean(기본 false),
`tree_movement_revision`은 bigint(기본 0)다. revision 0은 기존 로컬 설정의
서버 이관이 아직 이뤄지지 않았음을 뜻한다. macOS·Windows는 본인과 방 멤버의
기존 profiles snapshot 조회에 두 필드를 포함하고, 더 낮은 revision의 응답은 무시한다.

`set_tree_movement_paused(p_paused boolean, p_expected_revision bigint)`는 로그인한
본인 profile을 `FOR UPDATE`로 잠근 뒤 `SETOF profiles`로 정확히 한 행을 반환한다.
PostgREST 응답은 profile 객체 하나를 담은 배열이다. 기대 revision이
현재값과 다르면 현재 행을 변경 없이 반환한다. 최초 초기화는 false를 저장해도
0 → 1로 진행한다. 이후 같은 상태는 revision을 유지하고, 다른 상태는 1 증가한다.
이 계약으로 응답을 잃은 재시도와 동시 기기의 설정 이관이 최신 설정을 덮어쓰지 않는다.
클라이언트는 저장 중 중복 요청을 막고, 오류에는 기존 상태를 유지하며, 충돌 응답에는
서버 확정값을 적용한다. 재실행·방 이동·다중 기기에서 초기화 후 로컬 설정을 재이관하지 않는다.

RPC는 캐릭터 선택과 별개인 계정 설정이며 다른 캐릭터를 선택해도 상태를 보존한다.
미인증은 `authentication_required`, profile 부재는 `profile_required`, null 상태·null 또는
음수 revision은 `invalid_tree_movement_state`로 실패한다. 기존 profiles SELECT RLS가
본인과 방 멤버에게만 상태를 공개하며 직접 INSERT/UPDATE는 허용하지 않는다.
기존 `profiles_broadcast_change`의 방별 `structure_changed` 알림과 snapshot 재조회를
재사용한다. 미리보기 정지는 로컬 상태로 유지한다. migration 파일 추가만으로 운영에
반영되지 않으며 사용자 간 공유는 후속 backend 배포와 클라이언트 업데이트 뒤 제공된다.

## 콘텐츠·가격 통일 준비

공개 main에 통합된 원본은 `96f62abc0b350791de8e0d7c3b3af33f4e73dae6`이며
`SOURCE.json`의 `catalogSourceCommit`과 `catalogSnapshotSha256`에 고정한다.
우파루파 2,200원 정정이 통합된 이 커밋에서 두 snapshot을 가져와 바이트·SHA-256을 기록했다.
공개 main 통합은 운영 backend 배포를 실행하지 않는다.

`20260915200000_content_catalog_and_prices.sql`은 시바견·오리·똥·떡볶이·쿼카와
테니스공·휴지 뭉치·어묵꼬치·잎사귀를 독립 상품으로 추가한다. 삑삑 오리는 기존
`throwable_squeaky_duck` 상품·소유권을 재사용하며 오리 캐릭터 구매로 자동 지급하지 않는다.
기존 Apple 판매·복원 offer 34개는 기존 포함 물건 의미를 보존하고 신규 offer 9개는
`includes_related_throwable=false`다. 상품 33개·Apple ID 43개가 된다.

2026-09-16 정정 후 새 주문 가격은 별빛 우파루파·말풍선 3종·두쫀쿠·왁뿌볼 2,200원,
미니 대포 3,300원, 나무·신규 9개를 포함한 나머지 상품 1,100원이다. 기존 price 행은
비활성화하고 새 행을 추가한다. 기존 주문의 가격 참조·금액·정책, 결제·Apple 거래
금액·지급·복원 이력은 변경하지 않는다. Apple 화면 가격은 Apple의 현지 가격이므로
운영 가격 조정과 App Store 상품 등록·공개는 별도 출시 작업이다.
이 migration과 verifier mirror 반영은 운영 DB 적용이나 서비스 배포가 아니다.

`20260916000000_starlight_upalupa_price.sql`은 우파루파의 활성 1,100원 가격을
퇴역시키고 2,200원 가격을 추가한다. 기존 migration은 수정하지 않으며 대기 중인
1,100원 주문과 더 오래된 1,900원 주문도 원래 금액으로 처리한다. 별빛 구슬은 별도
1,100원 상품이다. [Cloud Console·App Store 등록 인계](CONTENT_RELEASE_HANDOFF.md)를 따른다.


## Windows PortOne 후보

`get_windows_store_state()`는 인증된 사용자의 기존 `get_store_state()` 형식을 유지하되
`commerce_products.portone_sale_enabled`가 켜진 상품만 반환한다. `create_commerce_order`
역시 같은 플래그를 서버에서 확인한다. 초기 허용 범위는 공개 catalog commit
`43c489ff2da69745c8bc7122795019f77ade6239`의 Windows mirror 24개다. 신규 9개와 이후
추가 상품은 기본 비활성이며, Apple offer·기존 권리와 장착에는 영향을 주지 않는다.

checkout/redirect URL은 API query override 없이 token을 fragment로 전달한다. 공개 웹은
SIDEY 운영 origin으로만 API 요청한다. 기존 판매 잠금, 정책 동의, LIVE/TEST 검증,
webhook 서명, entitlement·환불 멱등성은 유지한다. 이 migration은 판매를 활성화하지 않는다.
