# 배포 소스 복구 provenance

기준일: 2026-09-21
복구는 read-only remote inventory와 배포 artifact download로 수행했다. secret 값과 고객 데이터는 읽거나 보존하지 않았다.

## Firebase

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

## Supabase staging

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

## Edge Functions

| function | deployed version | tree SHA-256 |
| --- | ---: | --- |
| `realtime-bootstrap` | 139 | `167fa9cb72325993312d98923c3ff5cf6a190e3a25f0a713788cf2150d996ac1` |
| `realtime-publish` | 133 | `d9829590cf2ea683761e73ed8f9e520df6646d8a89fd0c1db4d4b6814bfe5d21` |
| `realtime-publish-live` | 121 | `7d9af666351876963b56a7dcf900b2a49e6af873b1cdeef222886d881b1038d2` |
| `realtime-event` | 111 | `ec30c44c5bb141631f96193eba4c350ba805c8923cd98c03f3db8550acd82dde` |
| `realtime-wake` | 81 | `4c46acfad739ab73f3629ff5b3e1555d7d065d80cdec0951156decf8d5981f3e` |

각 bundle에서 겹치는 `_shared` 파일은 byte-identical한 것만 통합했다. 이 문서는 source provenance를 기록할 뿐 배포 승인이나 architecture 적합성을 뜻하지 않는다.
