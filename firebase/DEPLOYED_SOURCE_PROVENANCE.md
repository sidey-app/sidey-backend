# 배포 소스 복구 provenance

기준일: 2026-09-21
복구는 read-only remote inventory와 배포 artifact download로 수행했다. secret 값과 고객 데이터는 읽거나 보존하지 않았다.

## Gate 0 Firebase 복구 baseline

- 프로젝트: `sidey-realtime`
- Functions archive 10개는 byte-identical
- archive 크기: 76,985 bytes
- archive SHA-256: `2247f646061a5322652433caef152dcb62037430efd376e2215133613df06178`
- normalized source tree SHA-256: `a8d882023fff3b1a78f5e2e4fc5ddeee652d30e3fd50da10e2df50ee5eacef28`
- 대표 원본: 배포된 `bootstrapRealtime` archive
- 제외한 artifact: `database-debug.log`
- RTDB Rules raw SHA-256: `8d12452a40e47ee3f11dda4525439540b0dc86df78165369e5ba941a5c7de8c8`
- RTDB Rules canonical JSON SHA-256: `ed94e215cf305a0bbbfd6b9801b2c04ec7c20d6a8e529aa9bada2c3edccbe4e8`

배포 archive에는 `index.js`, `lib/**`, package lock, test 9개와 함께 debug log가 들어 있었다. Gate 0에서 저장소로 옮긴 복구본은 실행 source와 tests만 보존하고 debug log를 제외했다. 이후 Gate 1 local candidate가 해당 source를 수정했으므로 현재 `firebase/functions/**`를 위 deployed hash와 동일한 복구본으로 취급하면 안 된다. exact baseline archive는 별도 rollback artifact로 보존해야 한다.

## Gate 0 Supabase staging 복구 baseline

- 프로젝트: `fjglrvhvdthntkvrduyi`
- migration history: 19개
- 15개는 원격 DB가 보존한 executed statement sequence와 hash가 일치한다. 주석/공백까지 포함한 원본 byte 동일성은 증명하지 않는다.
- 아래 4개는 원격 migration row에 statement가 0개라 DB만으로 원본 byte를 복구할 수 없다. 로컬 배포 manifest와 frozen source manifest가 가리키는 파일을 보존했다.

| migration | 보존 파일 SHA-256 | provenance 한계 |
| --- | --- | --- |
| `20260919020000_firebase_direct_events.sql` | `de121619dd9fffd3ce4a681140b5e210844b9e90819015c7d83d9fee5716d6d5` | local deployment manifest |
| `20260919030000_firebase_publisher_pipeline.sql` | `de0cff86ed56a2035a1bfd9687f5a3596d18c7aa2d080a4c4a8f7ef388524392` | local deployment manifest |
| `20260919040000_firebase_publish_wake.sql` | `51fbae1f6c607f47b0f04ebc95db0751e75ed98f0db119d3b67908345b9ef881` | local deployment manifest |
| `20260919050000_firebase_edge_region.sql` | `1c3e0faa6449206efecaa09c47826c3a832cd8dbcb782967e732313c62360a1f` | local deployment manifest |

## Gate 0 Edge Functions 복구 baseline

| function | deployed version | tree SHA-256 |
| --- | ---: | --- |
| `realtime-bootstrap` | 139 | `167fa9cb72325993312d98923c3ff5cf6a190e3a25f0a713788cf2150d996ac1` |
| `realtime-publish` | 133 | `d9829590cf2ea683761e73ed8f9e520df6646d8a89fd0c1db4d4b6814bfe5d21` |
| `realtime-publish-live` | 121 | `7d9af666351876963b56a7dcf900b2a49e6af873b1cdeef222886d881b1038d2` |
| `realtime-event` | 111 | `ec30c44c5bb141631f96193eba4c350ba805c8923cd98c03f3db8550acd82dde` |
| `realtime-wake` | 81 | `4c46acfad739ab73f3629ff5b3e1555d7d065d80cdec0951156decf8d5981f3e` |

각 bundle에서 겹치는 `_shared` 파일은 byte-identical한 것만 통합했다. 이 문서는 source provenance를 기록할 뿐 배포 승인이나 architecture 적합성을 뜻하지 않는다.

## 현재 Gate 1 deployed 상태

- Firebase production은 Functions `9 ACTIVE`이며 legacy `persistChatCommand`는 0개다.
- Gate 1 runtime 배포 source commit은 `223b8c4`, 최종 smoke source commit은 `8633621`이다.
- deployed contract fixture는 `firebase/contract-v2.gate1-deployed.fixture.json`, SHA-256은
  `4785705721e971ae463a5692bc80cadc7ff49ed0e20aab495dc1b0d6be0619d0`이다.
- Supabase staging은 복구 baseline 19개 뒤 아래 migration 2개가 추가돼 Firebase migration 21개다.

| migration | SHA-256 | 상태 |
| --- | --- | --- |
| `20260921070000_firebase_delivery_status.sql` | `0f9b2a925cfe9c05c4b53dfbbabf09178f95eac639f27c9ab637b3efe7f04372` | staging deployed |
| `20260921070944_firebase_access_delivery_snapshot.sql` | `21efb70e01e60de88c20758b51f8f2ca83172875dd2209718efd549eff57bb28` | staging deployed |

현재 working source의 `bootstrapRealtime` grant barrier와
`20260921102516_firebase_production_compatibility.sql`은 Gate 1 배포 뒤 생긴 local candidate다. 따라서
현재 `firebase/functions/**` 또는 움직이는 `firebase/contract-v2.fixture.json`을 Gate 1 deployed source로
간주하면 안 된다.

## 현재 production M0 publication

기준일: 2026-09-22

Gate 1 뒤 candidate는 독립 review를 거쳐 production에 발행됐다. 이 절의 read-back이 위 Gate 0/1 historical
revision보다 우선한다.

- reviewed source manifest: `79` files, SHA-256
  `9c2bc27d7d7225cd24555dae66887bacd1013d080cd650241b50a4c89d86e419`
- deployed contract fixture: `firebase/contract-v2.fixture.json`, SHA-256
  `3c836b40cfc44437e9d069b84787cd3d8793026ce40de46d82b9ece79127b7e5`
- Supabase production: `whtejsviizgejauasqqt`, history `93`, final schema fingerprint
  `6425dcd8ebeafdeb0890d34780355fe20de6903da891e34af3d19d635da28948`
- Firebase project/region/runtime: `sidey-realtime` / `asia-southeast1` / Node.js 22
- Functions inventory: `9 ACTIVE`; legacy function `0`
- Functions secret binding: `SIDEY_SUPABASE_CONFIG@3`; wake endpoints만
  `SIDEY_ACCESS_WAKE_TOKEN@1` 추가. 값은 읽기 결과나 repository에 보존하지 않았다.
- RTDB Rules raw source SHA-256:
  `90c9b8f28ff3806e32326f50b4c18dac963d36c0c3031ffa48b00a1b2671a5d5`
- RTDB Rules remote canonical SHA-256:
  `145ab22b402de1445759c858a6fa3ab4bd6f3cb9599a7108ed53c8b3cd94f406`
- rollout read-back: Supabase OFF/kill/cohort 0, Firebase `/v2/a/g/e=false`; client `T0` 미시작

| function | revision | Firebase source hash |
| --- | --- | --- |
| `bootstrapRealtime` | `bootstraprealtime-00017-nem` | `3a29adc21673b8184d6fca8f55fde47940e7ce04` |
| `reconcileRealtimeAccess` | `reconcilerealtimeaccess-00015-naq` | `3a29adc21673b8184d6fca8f55fde47940e7ce04` |
| `retryRealtimeAccess` | `retryrealtimeaccess-00015-fiv` | `3a29adc21673b8184d6fca8f55fde47940e7ce04` |
| `retryRealtimeChat` | `retryrealtimechat-00008-taj` | `3a29adc21673b8184d6fca8f55fde47940e7ce04` |
| `retryRealtimeRoomRevisions` | `retryrealtimeroomrevisions-00014-cal` | `3a29adc21673b8184d6fca8f55fde47940e7ce04` |
| `sendRealtimeChat` | `sendrealtimechat-00008-map` | `3a29adc21673b8184d6fca8f55fde47940e7ce04` |
| `syncRealtimeAccess` | `syncrealtimeaccess-00015-kux` | `50e9b0292f098de6b4826c389891c5ee5d46f529` |
| `syncRealtimeChat` | `syncrealtimechat-00008-yih` | `50e9b0292f098de6b4826c389891c5ee5d46f529` |
| `syncRealtimeRoomRevisions` | `syncrealtimeroomrevisions-00014-xux` | `50e9b0292f098de6b4826c389891c5ee5d46f529` |

production authenticated OFF smoke는 selector legacy, bootstrap HTTP 409, legacy `send_message` exact scalar object를
확인했다. 임시 Supabase/Firebase Auth, source rows/outbox와 RTDB test path는 모두 residual `0`이다. raw test
identifier나 credential은 보존하지 않았다.

JIT logical backup `/private/tmp/sidey-prod-jit-vY54jE/database.dump`는 mode `0600`, 122,842,146 bytes,
SHA-256 `573e5d229805bf5077a6285f624b3b86e34f3ab5acfe647b7bb56b106e63bbbf`다. 다음 physical backup이
`COMPLETED`로 확인될 때까지 삭제·이동·업로드하지 않는다. read-only
`supabase backups list --project-ref whtejsviizgejauasqqt --output json` 최종 조회에서 최신 physical backup은
`2026-09-21T19:05:19.690Z`/`COMPLETED`로 M0보다 이전이며, PITR은 disabled다. 따라서 현재 보존 조건은
계속 유효하다.
