# SIDEY App Store verifier

서명된 StoreKit 2 transaction과 App Store Server Notifications V2를 Apple 공식 라이브러리로 검증한 뒤 Supabase의 비공개 commerce 원장에 반영하는 Node 22 서비스다. App Store용 키와 Supabase secret key는 저장소에 두지 않는다.

## Endpoints

- `POST /v1/app-store/transactions`: Supabase Bearer token과 `signedTransactionInfo` 필요
- `POST /v1/app-store/notifications`: Apple의 `signedPayload` 필요
- `POST /v1/accounts/delete`: Supabase Bearer token, fresh Apple `identityToken`, `authorizationCode`, raw `nonce` 필요
- `GET /health`: 프로세스 상태만 반환

Production과 Sandbox는 서로 다른 Cloud Run 서비스와 Secret Manager secret을 사용한다. App Store Connect의 Production/Sandbox 알림 URL은 각각 해당 서비스의 `/v1/app-store/notifications`로 지정한다.


## Google Cloud Shell에서 최신 main 배포

Google Cloud Console에서 Cloud Shell을 연 뒤 아래 명령을 실행한다. 현재 Sandbox URL의 프로젝트 번호 `802687666602`를 실제 프로젝트 ID로 조회하고, 두 기존 서비스가 있는지 확인한 후 각각 소스를 배포한다. 환경변수·Secret Manager 연결·서비스 계정·IAM 설정은 변경하지 않는다. 기존 설정이 없는 새 서비스를 만드는 용도로 사용하지 않는다.

```sh
set -eu
SIDEY_GCP_PROJECT=$(gcloud projects describe 802687666602 --format='value(projectId)')
SIDEY_GCP_REGION=asia-northeast3

gcloud run services describe sidey-app-store-verifier-sandbox \
  --project="$SIDEY_GCP_PROJECT" --region="$SIDEY_GCP_REGION" --format='value(status.url)'
gcloud run services describe sidey-app-store-verifier-production \
  --project="$SIDEY_GCP_PROJECT" --region="$SIDEY_GCP_REGION" --format='value(status.url)'

SIDEY_DEPLOY_DIR=$(mktemp -d)
gh repo clone sidey-app/sidey-backend "$SIDEY_DEPLOY_DIR" -- --depth 1 --branch main
cd "$SIDEY_DEPLOY_DIR"
git rev-parse HEAD

gcloud run deploy sidey-app-store-verifier-sandbox \
  --project="$SIDEY_GCP_PROJECT" --region="$SIDEY_GCP_REGION" \
  --source=services/app-store-verifier --quiet

gcloud run deploy sidey-app-store-verifier-production \
  --project="$SIDEY_GCP_PROJECT" --region="$SIDEY_GCP_REGION" \
  --source=services/app-store-verifier --quiet

for SIDEY_SERVICE in sidey-app-store-verifier-sandbox sidey-app-store-verifier-production; do
  SIDEY_SERVICE_URL=$(gcloud run services describe "$SIDEY_SERVICE" \
    --project="$SIDEY_GCP_PROJECT" --region="$SIDEY_GCP_REGION" --format='value(status.url)')
  curl --fail --silent --show-error "$SIDEY_SERVICE_URL/health"
  printf '\n'
done
```

배포할 소스는 `character_monkey_solo_4`를 포함한 현재·과거 Apple 상품 ID 43개를 검증한다. DB에는 `20260916000000_starlight_upalupa_price.sql`까지 필요한 migration이 적용되어 있어야 한다. 현재 상품은 33개이며 별빛 우파루파 기준 가격은 2,200원이다. 신규 9개 등록과 적용 순서는 [콘텐츠 출시 인계](../../docs/CONTENT_RELEASE_HANDOFF.md)를 따른다. Cloud Run 배포는 Supabase migration을 실행하지 않는다. `/health` 성공은 프로세스 생존 확인이며 실제 구매·복원·환불 검증을 대신하지 않는다.

비공개 소스를 clone하기 전에 해당 조직 저장소에 접근 가능한 `gh` 인증이 필요하다. 배포 환경의 기존 시크릿과 설정을 보존한다.

## 어드민 App Store 결제 금액

검증을 통과한 Apple transaction JWS의 `price`와 `currency`를 기존 거래 반영 RPC에 함께 저장한다. `price`는 통화 기본 단위의 1/1000(milliunits)이며, 예를 들어 `1100000`과 `KRW`는 1,100원이다. 이미 거래 총액이므로 `quantity`를 다시 곱하지 않는다. 0은 확인된 무료 거래로 보존하고, 누락·음수·비정수·안전 정수 범위 초과 금액 또는 대문자 3자리 통화 코드와 짝을 이루지 못한 값은 금액 미확인으로 남긴다. 현재 상품 가격으로 과거 결제 금액을 추정하지 않는다.

금액은 운영용 거래 조회에 사용하며 Apple 수수료·세금 공제 후 정산액이나 회계 대사 자료를 뜻하지 않는다. 통화별로 구분하고 Sandbox는 실제 결제와 합산하지 않는다. [Apple transaction payload 문서](https://developer.apple.com/documentation/appstoreservernotifications/jwstransactiondecodedpayload)

배포 순서는 **금액 열과 13개 인자 거래 반영 RPC 및 backfill RPC를 추가하는 App Store 결제 금액 migration → verifier Sandbox 검증·배포 → verifier Production 배포 → 어드민 배포**다. 이전 11개 인자 RPC는 기존 verifier와의 호환을 위해 유지한다. Cloud Run 소스 배포만으로 DB가 변경되지는 않는다. migration 적용 전 새 verifier를 배포하면 구매 반영 RPC가 실패할 수 있다. 운영 migration·배포·backfill 실행은 별도 승인 작업이다.

### 기존 거래 금액 채우기

과거 원장에는 원본 JWS를 저장하지 않았으므로 Apple Server API로 거래를 다시 조회하고 서명·환경·상품·transaction ID를 검증해야 한다. 아래 CLI는 verifier와 동일한 환경변수/Secret Manager 설정을 사용하는 승인된 관리 환경에서만 실행한다. 서비스 키나 JWS를 터미널에 출력하거나 파일로 저장하지 않는다.

```sh
cd services/app-store-verifier
npm ci
npm run build

# 기본은 Production 25건 dry-run. Apple 조회·서명 검증은 수행하지만 DB를 쓰지 않는다.
node dist/src/backfill-prices.js --environment Production --limit 25

# dry-run 결과 확인과 운영 실행 승인 후에만 금액을 기록한다.
node dist/src/backfill-prices.js --environment Production --limit 25 --apply

# Sandbox 확인은 환경을 명시해 분리한다.
node dist/src/backfill-prices.js --environment Sandbox --limit 25
```

한 번에 최대 100건만 선택하며 Apple 요청을 순차 실행하고 거래 사이에 300ms를 쉰다. backfill의 Apple Server API 요청은 15초 뒤 실제 전송을 중단하며, 응답 본문이 멈춘 경우에도 적용된다. Apple 라이브러리의 서명 인증서 OCSP 확인은 자체 30초 제한을 사용한다. 자동 반복·재시도는 하지 않는다. 출력은 선택·확인 가능·기록·미확인·실패 건수와 다음 페이지 위치인 `nextCursor`를 담고, 실패가 있으면 종료 코드 1을 반환한다. `recorded`는 실제로 새 금액을 채운 건수이며 동시 처리로 이미 채워진 거래는 포함하지 않는다. dry-run은 Apple API 네트워크 조회를 수행한다.

`admin_list_app_store_unpriced`와 `admin_record_app_store_price`는 service role 전용이다. 금액 backfill은 기존 거래의 비어 있는 금액만 채우며 구매 상태·환불·소유권을 재적용하지 않는다. Apple이 금액을 주지 않는 거래는 계속 미확인으로 남는다. 금액을 받지 못한 거래도 지나가려면 출력의 `nextCursor`를 다음 실행의 `--before`에 그대로 전달한다. 커서는 구매 시각(마이크로초 보존)과 transaction ID의 SHA-256으로 구성되어 원본 거래 ID를 출력하지 않는다. 조회 순서가 같고 구매 시각이 같은 거래도 빠짐없이 다음 페이지로 진행한다. `nextCursor: null`이면 해당 탐색이 끝난 것이다. 커서를 생략하면 최근 미확인 거래부터 다시 확인한다. `failed` 거래를 다음 페이지로 넘겼다면 해당 배치의 입력 커서를 보관하고 나중에 재확인한다.

```sh
# CURSOR는 직전 출력의 nextCursor 전체 문자열로 교체한다(파이프 포함이므로 따옴표 유지).
node dist/src/backfill-prices.js --environment Production --limit 25 --before 'CURSOR'
# 같은 배치 적용 시에도 해당 dry-run에 넣은 입력 커서를 사용한다.
node dist/src/backfill-prices.js --environment Production --limit 25 --before 'CURSOR' --apply
```

`--before`는 동일한 환경에서 사용하고, 다음 배치로 넘어가기 전에 필요한 dry-run·apply를 마친다. 알려진 가격을 수정하거나 가격 없는 거래를 0원으로 바꾸는 도구가 아니다.
