# Credential-free environment validation, 2026-09-17

This continues the already committed Phases 1–19. It does not certify production
cutover. No production import, write freeze, traffic switch, paid charge, external
provider transaction, remote push/merge or unrelated service change was performed.

## Native platform gates

macOS branch `macos/spring-backend-macos`, commit `0334fb3e30e57f94b634f42b5cb815714d6a1d67`:
clean, unchanged. Executed the maintained `scripts/macos/tests/test_native.sh`,
then explicit Debug `xcodebuild build` and `xcodebuild test` for **both** SIDEY and
SIDEYAppStore, arm64, `CODE_SIGNING_ALLOWED=NO`. All native commands stop because
only `/Library/Developer/CommandLineTools` exists. Source/asset/script checks do
not count as native compilation or XCTest. No migrated Debug app was launched.

Searched installed apps, Spotlight and local installer archives; no full Xcode.
Installed `mas` 7.0.0 and attempted the official Xcode App Store install
(`mas install 497799835`); it requires unavailable interactive sudo authentication.
The official Apple download requires authenticated download access. No unofficial
Xcode distribution or privilege workaround was used. **BLOCKED_BY_XCODE**:
the machine owner must install official full Xcode, complete its first launch and
rerun the wrapper with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.
Evidence: `/tmp/sidey-native-validation-20260917/commands.json` and target logs.

Windows branch `windows/spring-backend-windows`, commit
`6056ce0e8f2bcb21180208f997a82b60271720fe`: clean, unchanged.
No accessible Windows machine, VM or authenticated Windows runner was found.
No Parallels/VMware/VirtualBox/UTM installation or VM inventory, nor Windows
SSH/WinRM target. Read-only GitHub inspection found zero workflow runs for this
exact branch head. A successful unrelated main-branch Windows run is not evidence
for this change. **BLOCKED_BY_WINDOWS_ENVIRONMENT**: provision a Windows runner
for this exact head, then run restore, solution/WinUI build, platform tests,
startup/auth/REST/WS/recovery and installer install/uninstall. No new cross-build
was represented as native validation. Neither client branch was merged or pushed.

## Target host and safe Linux environment

Read-only SSH through the existing `queuing` alias reached hostname `msi-server`:
x86_64, 8 CPUs, 7243 MiB RAM, approximately 5542 MiB available and 75 GiB disk free.
containerd, nerdctl and BuildKit exist. The current user cannot access the root-owned
containerd socket; `sudo -n` requires a password. Rootless setup's actual check
fails at `/proc/self/exe` with AppArmor user-namespace restriction. No root policy,
container, Redis, MariaDB, monitoring or production routing was changed.
**BLOCKED_BY_TARGET_CONTAINERD_PERMISSION** remains for deployment on that host.

Installed Lima 2.2.0 and created the task-owned `sidey-validation` VM: Ubuntu 24.04,
ARM64, 4 CPUs/4 GiB/24 GiB disk, no host mounts, system containerd 2.3.3 and
BuildKit. Docker daemon was neither installed nor started. Built the actual JAR,
saved/imported its OCI image and ran both slots using the real deployment operator.
Base: Temurin 21 JRE Jammy digest
`sha256:bce52ea7da1f72e6bf5bec505e63b6eb55ba79ad1226903579f77eab1a80139a`.
Validated optimized image manifest:
`sha256:7172675e185d2f57682c6473378f4687da7d145c08d71ccbe4103a1b831b6040`.
An additional `--platform linux/amd64` build/import succeeded and inspection
confirmed `amd64 linux`, manifest
`sha256:fa4cfd4a11703966fc0457c805f8dbe4c8525bda58af080cd1e5d8483f497a79`.
It was not represented as a native execution on the inaccessible x86_64 target.

Actual checks: UID/GID 10001, root filesystem write rejected, `/tmp` write succeeds,
tmpfs 64 MiB, `NoNewPrivs=1`, PID limit 512, container memory 1280 MiB and Java
`-Xms256m -Xmx768m`. PostgreSQL 17.11 connectivity, Flyway V1–V6, readiness UP,
Prometheus metrics and structured JSON logs succeeded. `nginx -t`, authenticated
REST and raw WebSocket succeeded. `/internal/**` and `/actuator/prometheus` return
404 through Nginx. Container inspection/reporting excludes environment secrets.

An independent temporary **trycloudflare.com** Tunnel validated HTTPS REST,
authenticated WSS subscribe/heartbeat, and private-route 404. It was then stopped.
No existing production domain or named Tunnel configuration was touched.
**BLOCKED_BY_TARGET_ROUTE_ACCESS** remains for the installed production route.

## Real blue/green rehearsal

`scripts/validation/linux_rehearsal.py` uses real containers, DB, Nginx and sockets;
fault injection changes only the operator's response observation in the test.
It passed again with the optimized image in both slots:

- Old admission closes before candidate activation; assertions after each control
  action prove at most one accepting instance. Existing WS closes with 1012.
- Response lost **after actual activation**: candidate is drained before restoring
  the old route. If candidate drain is unreachable, the old process remains
  disabled and its routed REST returns 503. No guessing or dual writer fallback.
- Both inactive for 65 seconds: expired session and four-day-old message remain
  unchanged across the real scheduled maintenance boundary.
- A real PostgreSQL membership lock delays an admitted message. Drain waits for
  the transaction, which commits after the sender's socket closes. The new JVM
  subscribes first and retrieves that message after the last confirmed REST cursor.
- Same UUID retry returns the original canonical row, count remains one, presence
  and membership reconstruct, Nginx switches, old container stops.

## Migration rehearsal

**BLOCKED_BY_PRODUCTION_SNAPSHOT**: no accessible read-only production snapshot,
sanitized clone or staging clone was provided/found. No production DB was queried
or imported. Repeated real PostgreSQL synthetic final-shape migration instead.

The test covers UUID preservation, Google identity and legacy-unclaimed mapping,
profiles, owner/member, invites, three-day retention, prices/orders/provider state,
refunds, grants/projection, historical included grant parent/provenance, Apple
binding/signed money and now nonempty App Store notification audit preservation.
An invalid entitlement projection rolls back all target rows and preserves the
seed catalog. Same run UUID returns the exact persisted report; a different run
against the populated target fails. `target/migration-validation-report.json`
contains the executed fixture report; a non-secret copy accompanies this report.

The report initially lacked explicit active-user identity and aggregate FK results.
A failing assertion reproduced that gap. It now reports the identity check and
32 validated FKs after `SET CONSTRAINTS ALL IMMEDIATE`, including the deferred
composite owner/member FK. Orphan FK, owner missing/not-member, duplicate identity,
invalid ACTIVE identity, grant projection and Apple binding mismatch are all zero.

## Capacity and slow consumers

See [PERFORMANCE.md](PERFORMANCE.md) for controlled before/after workload, JFR
evidence and the measured limiter fix. Proxy and test-tool setup failures are
explicitly excluded from successful results. Global cap 3000, per-user cap 16,
64 outbound workers and bounded queues remain unchanged.

The final 1,200-client mixed rerun accepted/subscribed every connection, with zero
command errors/rejections/unexpected closes, ACK p95 5.52 ms and 697,997 delivered
frames. It ran after the cap/recovery scenarios, also checking capacity reuse.

At 2,500 mixed clients, the optimized process's sampled peak heap was 434 MiB;
container memory was about 827 MiB at the recorded plateau snapshot, within the
1280 MiB limit. CPU averaged 0.200 of the VM's four CPUs at the plateau versus
0.253 before. Hikari had one pending borrower at one sample, zero connection
timeouts. Aggregate outbound queued bytes peaked at 96,969. A live thread dump
showed 62 of 64 outbound workers waiting for work; two runnable. This evidence
did not justify changing the 64-worker model. Sampled maxima are not hard maxima.

3,200 simultaneous attempts accepted/subscribed exactly 3,000 and rejected 200
with policy close 1008; no accepted connection dropped unexpectedly. Presence,
connections, subscriptions and queued bytes returned to zero. A distinct-session
test accepted 16 user connections and rejected the seventeenth, aggregated
ONLINE/AWAY/OFFLINE and expired the stale session after 60.196 seconds.

The initial stalled-reader test through Nginx did not exhaust its additional TCP
buffers within 90 seconds. To isolate the application's queue, the stalled socket
then connected directly to the active upstream with compression disabled; 55
healthy senders still used Nginx. The stalled connection closed (client saw 1006),
while healthy peers received 11,715 ACKs, zero errors, p95 37.28 ms, max 52.57 ms.
Subsequent subscribe-first REST recovery fetched all 5,104 retained room messages
over 26 cursor pages, no duplicate UUIDs, equal to the DB count. Deterministic
`OutboundConnectionTest` separately verifies durable queue overflow closure and
ephemeral drop behavior; a specific network close code 1013 was not claimed for
the stalled native TCP test.

Final capacity and slow-consumer measurements are recorded in
`validation/2026-09-17/results.json`. This is short local stress/rehearsal evidence,
not a sustained production soak test or a Windows/macOS GUI test.

## Provider configuration gates

The production JAR with no provider credentials was exercised over real HTTP:
Google/Apple login fail with 401 `identity_provider_unavailable`, App Store submit
with 503 `apple_not_configured`, PortOne webhook with 503 `commerce_not_configured`.
User/session/grant counts remain unchanged. No verifier bypass/test double was
added to production code. Official verifier tampering/signature/freshness tests
and deterministic provider boundary tests pass locally.

| Gate | Required environment values / format |
| --- | --- |
| BLOCKED_BY_GOOGLE_CREDENTIAL | `SIDEY_GOOGLE_AUDIENCES`: comma-separated exact OAuth client IDs; native OAuth client setup and a fresh Google credential bound to the server challenge nonce |
| BLOCKED_BY_APPLE_SIGNIN_CREDENTIAL | `SIDEY_APPLE_AUDIENCES`: comma-separated exact client identifiers; `APPLE_SIGN_IN_CLIENT_ID`, `APPLE_SIGN_IN_KEY_ID`, `APPLE_SIGN_IN_TEAM_ID`, `APPLE_SIGN_IN_PRIVATE_KEY_FILE` (readable EC PKCS#8 PEM `.p8`) for authorization exchange/revocation |
| BLOCKED_BY_APPSTORE_CREDENTIAL | `APPLE_BUNDLE_ID` exact bundle identifier, `APPLE_APP_ID` positive integer, `APPLE_ROOT_CERTIFICATES` comma-separated Apple root certificate paths, `APPLE_IAP_PRIVATE_KEY_FILE` EC PKCS#8 PEM, `APPLE_IAP_KEY_ID`, `APPLE_IAP_ISSUER_ID` UUID; a controlled Sandbox signed transaction/notification |
| BLOCKED_BY_PORTONE_CREDENTIAL | `PORTONE_API_SECRET`, `PORTONE_WEBHOOK_SECRET` issued signing secret (`whsec_` base64 format is covered by the SDK test), exact `PORTONE_STORE_ID` and `PORTONE_CHANNEL_KEY`; reviewed `commerce_runtime_settings` with test environment and policy consent |

Use the existing mode-0600 `deploy/server.env.example` contract outside Git and
read-only `/run/secrets` mounts readable by UID 10001. No actual value belongs in
CLI arguments, logs, this report or Git. The implemented `CONTRACT.md`, `APPLE.md`
and `COMMERCE.md` flows accept these settings without a code change. Positive
provider E2E remains deferred; a real paid charge is not authorized by this report.

## Executed checks and reproduction

```sh
sh scripts/local-postgres.sh
./mvnw -q -Dtest=LegacyMigrationTest,IdentityVerifierTest,AppleVerificationTest,PortOneSignatureTest,ProviderHttpTest test
./mvnw -q clean verify
python3 scripts/check-source.py
python3 -m unittest discover -s deploy -p 'test_*.py'
python3 -m py_compile scripts/validation/*.py
```

The final full Java run is 76 tests, zero failures/errors/skips. Operator failure
tests: 7 passing. The expected migration report assertion failure was fixed before
the clean run. Runtime validation scripts live in `scripts/validation/`; fixture
creation and destructive tests refuse non-lab use or require the explicit disposable
database. Generated 15-minute fixture credentials are mode 0600 and ignored by Git.
These are SQL test fixtures, not an application authentication backdoor.

Raw JFR/credential artifacts stay private under ignored `.runtime/validation` or
the disposable VM. JFR may contain environment values and must not be published.
Only aggregate, non-secret results are committed. Existing user-owned untracked
`ProjectExporter.py` and `project_context.txt` are preserved.

Cleanup: the temporary Tunnel was stopped, task-owned Spring/PostgreSQL containers
were stopped, and `limactl list` confirms `sidey-validation` is **Stopped**. Its
private artifacts remain available for inspection. Existing target-host services
and the workspace's pre-existing local PostgreSQL test cluster were left intact.

Production cutover status: **NOT PERFORMED**.
