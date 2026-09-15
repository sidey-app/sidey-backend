# 콘텐츠·가격 변경 출시 인계

이 문서는 사용자가 이후 Google Cloud Console과 App Store Connect에서 실행할
작업을 정리한다. 이번 구현 작업에서는 운영 DB·Cloud Run·OAuth 설정·Apple 상품을
변경하거나 심사에 제출하지 않았다. 로컬 StoreKit 가격과 서버 카탈로그 갱신은
App Store Connect 가격을 자동 변경하지 않는다.

## 적용할 상태

- 현재 상품 33개: 유료 캐릭터 12·말풍선 3·투척물 18개.
- Apple 검증 ID 43개: 현재 판매용 33개와 과거 복원용 10개. 과거 ID는 보존한다.
- 별빛 우파루파·말풍선 3종·두쫀쿠·왁뿌볼은 2,200원, 미니 대포는 3,300원,
  나무·신규 9개를 포함한 나머지는 1,100원이다. 별빛 구슬도 1,100원이다.
- 우파루파의 현재 Apple ID는 `character_starlight_upalupa_solo`다.
  `character_starlight_upalupa`는 과거 포함 구매 복원용 ID이며 새로 만들거나 삭제하지 않는다.
- 신규 캐릭터 구매에 애착 물건을 자동 지급하지 않는다. 오리는 기존
  `throwable_squeaky_duck`를 재사용한다. 별도 삑삑 오리 상품을 만들지 않는다.

## 1. 검증된 backend 소스 준비

Backend CI와 Database CI가 통과한 private main 커밋을 사용한다. 배포 직전
`SOURCE.json`의 공개 원본 SHA와 두 snapshot 해시도 확인한다. 다음 명령은
private 저장소 접근 권한이 있는 Cloud Shell 또는 관리 환경에서 실행한다.

```sh
set -eu
: "${SIDEY_BACKEND_COMMIT:?검토와 CI가 끝난 private main 커밋 SHA를 설정하세요}"
SIDEY_DEPLOY_DIR=$(mktemp -d)
gh repo clone sidey-app/sidey-backend "$SIDEY_DEPLOY_DIR" -- --branch main
cd "$SIDEY_DEPLOY_DIR"
git merge-base --is-ancestor "$SIDEY_BACKEND_COMMIT" origin/main
git checkout --detach "$SIDEY_BACKEND_COMMIT"
git rev-parse HEAD
python3 scripts/commerce_catalog.py --target shared --check
```

## 2. Supabase migration 적용

운영 프로젝트 ref는 사용자가 기존 배포 대상과 대조하여 지정한다. 로컬
`config.toml`의 `SIDEY_backend`는 운영 프로젝트 ref가 아니다. Supabase CLI
2.116.0의 `migration list`, `db push --dry-run`, `--project-ref`, `--skip-vault`
옵션을 로컬 도움말로 확인했다. 원격 명령은 이번 작업에서 실행하지 않았다.

```sh
: "${SIDEY_SUPABASE_PROJECT_REF:?적용할 Supabase 프로젝트 ref를 설정하세요}"
supabase migration list --project-ref "$SIDEY_SUPABASE_PROJECT_REF"
supabase db push --project-ref "$SIDEY_SUPABASE_PROJECT_REF" --dry-run --skip-vault
```

목록에서 기존 이력과 새 migration 순서를 확인한 뒤 적용한다. `--include-all`로
이력 차이를 강제로 우회하지 않는다. 콘텐츠 migration은 신규 상품·검증 매핑을,
마지막 우파루파 migration은 새 주문 가격만 바꾼다. 기존 주문·거래 금액은 보존한다.

```sh
supabase db push --project-ref "$SIDEY_SUPABASE_PROJECT_REF" --skip-vault
```

적용 후 SQL Editor에서 다음 읽기 전용 쿼리로 상태를 확인한다.

```sql
select count(*) as active_products from public.commerce_products where active; -- 33
select count(*) as apple_ids, count(*) filter (where current_offer) as current_ids
from private.app_store_product_offers; -- 43 / 33
select product_id, amount_krw from public.commerce_prices
where active and product_id in ('character_starlight_upalupa','character_tree','throwable_starlight_orb')
order by product_id; -- 우파루파 2200 / 나무·별빛 구슬 1100
select amount_krw, count(*) from public.commerce_prices where active group by amount_krw order by amount_krw;
-- 1100: 26개 / 2200: 6개 / 3300: 1개
```

## 3. Google Cloud Console·Edge Functions

Google Cloud Console의 Cloud Shell에서 **같은 검증된 checkout**을 사용하여
[verifier 배포 명령](../services/app-store-verifier/README.md#google-cloud-shell에서-최신-main-배포)의
기존 Sandbox 서비스, 이어서 Production 서비스에 소스를 배포한다. 그 문서의 clone
단계는 반복하지 않는다. DB 적용이 먼저다. 서비스 URL과 기존 환경변수·Secret Manager·IAM
연결을 유지하며, Sandbox와 Production 시크릿을 교환하지 않는다.
`gcloud run deploy --source`는 새 서비스 revision을 만드는 명령이다.
[Google 공식 명령 설명](https://docs.cloud.google.com/sdk/gcloud/reference/run/deploy)

이번 상품·가격 수정에는 Google OAuth 클라이언트, 동의 화면, 승인 redirect URI의
변경이 필요하지 않다. 기존 Google 로그인 설정을 유지한다. App Store판 Apple 로그인과
Cloud Run Apple 거래 검증도 별개다. Console의 현재 설정은 이번 작업에서 조회하지 않았다.

신규 9개를 direct 개발·staging 결제 경로에도 반영할 때에는 같은 프로젝트에
commerce Edge Functions를 갱신한다. `config.toml`의 기존 함수별 JWT 설정을 사용하며
판매 잠금은 해제하지 않는다. 사용 중인 staging/운영 ref를 구분해 각각 실행한다.

```sh
supabase functions deploy commerce-order commerce-checkout commerce-complete commerce-webhook commerce-refund \
  --project-ref "$SIDEY_SUPABASE_PROJECT_REF"
```

`/health` 성공 뒤 Sandbox 구매·재실행 복원·환불 회수를 확인한다. `/health`는
상품 allowlist·DB 권한·Apple 구매 경로의 통합 성공을 증명하지 않는다.

## 4. App Store Connect

앱 `app.sidey.desktop.appstore`의 In-App Purchases에 다음 **비소모성** 상품을
등록한다. 각 상품의 한국 가격은 1,100원이며, 이름·설명은 고정된 공개 카탈로그와
번역 파일을 사용한다. 판매 국가·지역, 심사용 스크린샷·메모와 공개 시점을 확인한 뒤
사용자가 등록·제출한다. [Apple 상품 생성 안내](https://developer.apple.com/help/app-store-connect/manage-in-app-purchases/create-consumable-or-non-consumable-in-app-purchases)

| 상품 | 현재 판매 Product ID |
| --- | --- |
| 시바견 | `character_shiba` |
| 오리 | `character_duck` |
| 똥 | `character_poop` |
| 떡볶이 | `character_tteokbokki` |
| 쿼카 | `character_quokka` |
| 테니스공 | `throwable_tennis_ball` |
| 휴지 뭉치 | `throwable_tissue_ball` |
| 어묵꼬치 | `throwable_fish_cake_skewer` |
| 잎사귀 | `throwable_leaf` |

기존 `character_starlight_upalupa_solo`는 Product ID를 유지하고 Price Schedule에서
한국 판매 가격을 2,200원으로 정정한다. 적용 시작일과 다른 국가에 미치는 가격 변경
범위를 확인한다. 현재 운영 가격을 조회하지 않았으므로 이미 2,200원이면 중복 변경하지
않는다. [Apple 가격 변경 안내](https://developer.apple.com/help/app-store-connect/manage-in-app-purchases/schedule-price-changes-for-in-app-purchases)

앱은 StoreKit이 반환하는 현지 가격을 표시한다. 콘솔 등록 후 앱 업데이트까지 완료한
Sandbox 환경에서 신규 9개 조회·독립 구매·복원·환불과 기존 우파루파 권리 복원을 확인한다.
운영 배포와 App Store 공개 완료 여부는 사용자가 실행한 결과로 별도 기록한다.
