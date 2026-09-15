# SIDEY Backend

SIDEY의 Supabase 및 서버 구현을 관리하는 **조직 비공개 저장소**다.

- Backend: https://github.com/sidey-app/sidey-backend
- 공개 앱·웹·공용 상품 원본: https://github.com/sidey-app/SIDEY
- 로컬 어드민 UI는 별도 로컬 저장소에서 관리한다.

## 구성

| 경로 | 소유 범위 |
| --- | --- |
| `supabase/` | migration, RLS, Edge Functions, pgTAP, staging SQL |
| `services/app-store-verifier/` | Apple 거래·알림 검증, 금액 보완 도구 |
| `scripts/supabase/` | 동시 거래 검사 |
| `scripts/download-metrics/` | 공개 SIDEY Release 다운로드 집계 |
| `scripts/configure_supabase_staging.sh` | staging 전용 설정 |
| `assets/v1/` | 공개 상품·manifest의 검증된 입력 스냅샷 |
| `docs/` | 이전한 서버·운영 계약과 이전 기록 |

`SOURCE.json`에 이전 원본 commit과 경로를 기록했다. migration과 거래 검증 로직은
기존 내용으로 이전했으며 App Store 금액 기능도 포함한다. 저장소 이전 자체는
운영 DB 변경이나 Cloud Run·Edge Function 배포를 실행하지 않는다.

## 로컬 준비와 검증

```sh
gh repo clone sidey-app/sidey-backend
cd sidey-backend
python3 scripts/commerce_catalog.py --target shared --check
python3 -m unittest discover -s scripts/tests
node --test scripts/download-metrics/*.test.mjs
cd services/app-store-verifier
npm ci
npm test
```

Database CI는 격리된 runner에서 Supabase 시작 → 전체 migration 초기화 → pgTAP →
동시 거래 검사를 실행한다. 로컬 CLI ID는 `SIDEY_backend`이며 원격 프로젝트 ID가
아니다. 로컬 포트는 Supabase 기본값이므로 다른 로컬 Supabase와 동시에 실행하지 않는다.
기존 `.temp` 연결 상태·환경파일·키는 이전하지 않는다.

## 상품 원본 동기화

상품 원본은 공개 앱 저장소의 `assets/v1/commerce-catalog.json`과 `manifest.json`이다.
상품 변경 시 검토한 공개 commit에서 두 파일을 함께 가져오고 `SOURCE.json`의
`catalogSourceCommit`을 갱신한다. 이 저장소에서 아래 명령으로 backend mirror를
생성하고 테스트한 뒤 PR에 반영한다. 공개 저장소 생성기는 웹·앱 파일만 관리한다.

```sh
python3 scripts/commerce_catalog.py --target shared --write
python3 scripts/commerce_catalog.py --target shared --check
```

## 다운로드 집계 운영

수집 대상은 공개 `sidey-app/SIDEY` Release로 고정한다. 새 저장소 이름을 수집 대상으로
사용하지 않는다. `DOWNLOAD_METRICS_INGEST_URL`, `DOWNLOAD_METRICS_INGEST_KEY` 두 Actions
시크릿을 준비하고 기존 공개 collector를 중지한 뒤 `DOWNLOAD_METRICS_ENABLED=true`
Actions 변수를 설정한다. 변수 활성화 전에는 수집하지 않는다. 수집 주기는 15분이다.

## 배포와 공개 이력

검증 서버 배포·금액 보완 절차는 [verifier README](services/app-store-verifier/README.md)를
따른다. private 저장소 checkout에는 GitHub 권한이 필요하며 공개 URL clone을 전제로 하지 않는다.

이전 전 SIDEY에 게시된 커밋·태그·PR·포크·기존 clone은 이 분리만으로 삭제되지 않는다.
이 저장소와 앞으로 추가하는 backend 소스는 비공개로 관리한다. 과거 이력 재작성은
기존 release·활성 브랜치·외부 복사본에 대한 영향과 별도로 다룬다.
