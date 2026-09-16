# Implementation handoff and validation

Validated locally on 2026-09-17. Runtime references are SIDEY f939a9a and
sidey-backend 6c31ef4. Client worktrees use current SIDEY origin/main base 0f59ade.
Original reference checkouts were not changed; their existing untracked exporter
files were preserved. No production data or provider charges were touched.

## Committed implementation

| Repository/branch | Work completed | Main commits |
| --- | --- | --- |
| sidey-server, shared/backend-migration | Phases 1–13: schema, identity/session, profile, rooms, realtime, messages, recovery, presence, migration, PortOne, Apple | 1b1aefa through 168b139; details in PROGRESS.md |
| sidey-server | Contract fixes during client work | 74fdeea, 2f4f654, 6677e72 |
| SIDEY, macos/spring-backend-macos | Phase 14 migration, Phase 17 cleanup/deletion/recovery checks | 42e652e, 0334fb3 |
| SIDEY, windows/spring-backend-windows | Phase 15 migration, Phase 17 cleanup/catalog ownership checks | 7403392, 6056ce0 |
| SIDEY, shared/spring-backend-web | Phase 16 checkout, Phase 17 ownership/architecture documentation | d4c7252, 76d6ecf |
| sidey-server | Phase 18 deployment/admission/monitoring | d757e20 |
| sidey-server | Phase 19 full network journey and final verification | Commit containing this file |

The new backend is a Java 21/Spring Boot 4.1 modular monolith, PostgreSQL/Flyway/
jOOQ/HikariCP/Spring Security, REST plus authenticated raw WS, with a local
RoomEventPublisher and bounded reconstructible JVM realtime state. The initial
deployment permits one active application. Redis and external brokers were not
introduced. CONTRACT.md, MIGRATION.md, COMMERCE.md, APPLE.md and DEPLOYMENT.md are
the implemented contracts/runbooks, not alternative architecture proposals.

Task-owned client worktrees are sibling paths under `../.worktrees/`:
`macos-spring-backend`, `windows-spring-backend`, `shared-spring-backend`.
They are deliberately separate platform branches under SIDEY's repository rules.
They are not merged into main: required native checks are unavailable here, and
SIDEY AGENTS.md forbids integration with unavailable required checks.

## Commands actually executed

Backend (Java 21, actual local PostgreSQL 17.11 on loopback port 55432):

```sh
./mvnw -q clean verify
./mvnw -q -Dtest=EndToEndTest test
./mvnw -q -Dtest=DeploymentTest,HttpContractTest,WebSocketContractTest test
python3 scripts/check-source.py
python3 -m unittest discover -s deploy -p 'test_*.py'
python3 deploy/test_nginx.py .runtime/nginx/sbin/nginx
sh -n deploy/build-image.sh
git --no-pager diff --check
```

Final clean Maven run: **73 tests, zero failures, errors or skips**. Flyway and
jOOQ generation ran; the executable jar was built. This includes real PostgreSQL
locking/concurrency and atomic importer fixture/rerun/rollback validation, not H2.
The full network journey uses actual HTTP/JWT/WS/DB and test-only external provider
boundaries. Seven blue/green operator tests pass. Real task-local Nginx 1.31.6
syntax, REST, raw WS upgrade, internal route isolation and sanitized access-log
checks pass. Nginx was built in .runtime from verified official source; no existing
system service/configuration was changed.

macOS, from its worktree (both distribution variants):

```sh
rg --files -0 macos/SIDEY -g '*.swift' |
  xargs -0 xcrun swiftc -typecheck -parse-as-library \
    -swift-version 6 -strict-concurrency=complete -D APP_STORE -module-name SIDEYAppStore
# Direct: replace -D APP_STORE/-module-name with:
# -F /Users/jungjiyu/backend/sidey/sidey-server/.runtime/sparkle/Sparkle.xcframework/macos-arm64_x86_64 -module-name SIDEY
plutil -lint macos/SIDEY.xcodeproj/project.pbxproj
./scripts/macos/tests/test_native.sh
```

Full runtime source typechecks pass. Standalone executables compiled from actual
production/test bodies passed transport 14, gateway/recovery 10, modified
domain/history/catalog/commerce/throw 98, and App Store HTTP 8 checks. Earlier
auth/config checks also passed. App Store target now includes the eight relevant
auth/transport/recovery/history/HTTP test files; those actual test sources typecheck
against the emitted App Store module using a minimal XCTest API shim. This is
**not a native XCTest run or a signed application build**. Native wrapper passes
57 asset comparisons and 11 Python tests, then fails because xcodebuild requires
Xcode.app while only Command Line Tools are installed.

Windows, from its worktree with task-local .NET SDK 10.0.100 on PATH:

```sh
dotnet test windows/tests/Sidey.Core.Tests/Sidey.Core.Tests.csproj -c Release
dotnet test windows/tests/Sidey.Presentation.Tests/Sidey.Presentation.Tests.csproj -c Release
dotnet test windows/tests/Sidey.Infrastructure.ContractTests/Sidey.Infrastructure.ContractTests.csproj -c Release -p:EnableWindowsTargeting=true
EnableWindowsTargeting=true dotnet format windows/SIDEY.Windows.slnx --no-restore --verify-no-changes --verbosity minimal
dotnet build windows/src/Sidey.Infrastructure/Sidey.Infrastructure.csproj -c Release -f net10.0-windows10.0.26100.0 -p:EnableWindowsTargeting=true
dotnet build windows/src/Sidey.Platform.Windows/Sidey.Platform.Windows.csproj -c Release -p:EnableWindowsTargeting=true
dotnet build windows/SIDEY.Windows.slnx -c Release -p:EnableWindowsTargeting=true
```

Core **201**, Presentation **150**, actual portable Infrastructure contracts **58**
pass. Actual installer/language source tests **62** pass in a temporary net10
harness. Both Windows-target libraries and the real AppCoordinator plus existing
tree mutation test sources compile with zero warnings/errors in a managed harness.
Full solution formatting passes. Full native solution build fails at Windows
MakePri.exe (and mt.exe in a diagnostic cross-build) on macOS. No WinUI/Win32
executable, installer, OS credential UI or native GUI runtime was claimed tested.

Website/shared, Node 24.21.0 and pnpm 11.24.0 on PATH:

```sh
pnpm --dir website test
node /tmp/sidey-web-browser-check.mjs website/dist
```

Website build/test: **27 passing tests** with default and explicit loopback API
configurations; malformed credential-bearing API origin rejected as expected.
Actual Chrome desktop/mobile checkout, verified-result and three privacy locales
passed with deterministic API/PortOne interception. Ten screenshots were captured,
no horizontal overflow found, and token fragments were scrubbed. No real charge.

SIDEY workflow checks were run serially in each owned worktree with Python 3.13:

```sh
python3 scripts/skills/workflow.py check spring-backend-macos
python3 scripts/skills/workflow.py check spring-backend-windows
python3 scripts/skills/workflow.py check spring-backend-web
```

Each workflow executes 153 script tests and five release-note checks. These checks
do not substitute for unavailable native platform builds. Commits preserve the
human author and include the Codex co-author trailer. No hooks were bypassed.

## Remaining external verification

- Install/use full Xcode to run both native macOS targets and XCTest suites; run
  Windows solution/build/runtime/installer checks on Windows. Smoke-test real OS
  login, credential storage, idle/lock presence and reconnect UX on both platforms.
- Register/configure actual Google/Apple audiences and native OAuth clients. Test
  production Google/Apple proof verification, Apple certificate/OCSP/API purchase
  and authorization revocation, and PortOne webhook/API/refund integration using
  the intended provider environments. Implementations fail closed without config.
- Build/run the pinned image using the target's nerdctl/containerd, validate the
  installed Nginx/tunnel/Prometheus/Alloy wiring and resource budget, and exercise
  blue/green reconnect/drain on that host. Local Nginx verification already passes.
- Run the importer against the frozen production snapshot with original invitation
  pepper and validate its complete report. The local source-shaped fixture passes;
  production source counts/credentials and provider bindings have not been read.
- Merge/release the validated client branches and perform the one-shot production
  cutover only after these environment-dependent checks. No production cutover,
  remote push/merge or app-store release was executed in this session.

No known local test failure remains. This statement does not convert the native,
provider or production-environment verification gaps above into passing results.
