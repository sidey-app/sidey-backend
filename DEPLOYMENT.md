# Deployment

One active Java 21 process serves SIDEY behind the existing Cloudflare Tunnel and
Nginx. PostgreSQL is shared by the blue/green slots. These artifacts target Linux
containerd/nerdctl with BuildKit; they do not require or install a Docker daemon.
They do not manage unrelated databases, caches, containers or tunnel routes.

## Configuration and image

Use `deploy/server.env.example` as the complete production configuration template.
Keep the real file outside Git with mode 0600. JWT secret and invite pepper are
base64-encoded random bytes (at least 32 bytes). The cutover invite pepper must
preserve the existing bytes; see README. Google/Apple audiences must exactly match
the native OAuth clients. Set both clients' API base to the deployed `/api` origin.
The website's `PUBLIC_SIDEY_API_BASE_URL` and the server website origin must agree.

The deployment key is a separate random secret of at least 32 characters, also
stored in a local mode-0600 key file for the operator. The key file and
`SIDEY_DEPLOYMENT_KEY` must contain the same value. Do not reuse the commerce ops
key, JWT key, invitation pepper, provider key or checkout token. Apple key/root
files are mounted read-only at `/run/secrets`; the directory/files must be
readable by container UID 10001. Never put credentials in image layers or CLI
arguments. Configure PortOne and Apple as documented in COMMERCE.md and APPLE.md.
Blank provider settings fail closed; they are not production test doubles.

Build against a disposable/local PostgreSQL database, **not production**: the
Maven generate-sources phase applies Flyway and generates jOOQ classes there.
The schema at build time must match the repository migrations. Then:

```sh
SIDEY_IMAGE=registry.example/sidey-server:release-id \
SIDEY_JAVA_IMAGE='eclipse-temurin:21-jre-jammy@sha256:<approved-digest>' \
sh deploy/build-image.sh
```

The script runs source guards and `clean verify` before `nerdctl build`.
Publish/import the image using the existing registry process and deploy its
immutable digest. The runtime uses UID 10001, a read-only filesystem, bounded
tmpfs and PID count, no capabilities, and `-Xms256m -Xmx768m`. Its memory limit is
1280 MiB to include non-heap JVM/native/socket memory. Review actual host capacity
before temporarily starting the inactive slot; never evict unrelated workloads.

## Initial installation and cutover

1. Back up and freeze writes on the old Supabase system. Finish core, commerce,
   Apple, client distribution and migration validation before the one-shot switch.
2. Create/configure the target PostgreSQL database and production credentials;
   run the explicit offline importer and validation in MIGRATION.md. Preserve its
   run UUID/report and the legacy ownership verification boundary. A failed report
   blocks cutover. Never run two writes-enabled backends against an import.
3. With **no active upstream file yet**, launch blue using the command below.
   It starts inactive; readiness means database/startup probes are healthy, not
   that traffic admission is enabled. Both HTTP and maintenance remain disabled.
4. Install `deploy/nginx/sidey.conf` inside the existing Nginx `http` block. Its
   active-upstream include will be created by the initial switch. The example
   upstream file is explanatory; do not preselect a slot by copying it. Existing
   Nginx must already be running so the tool can validate and reload it.
5. Execute the bootstrap switch, validate through the tunnel, and release migrated
   clients/checkout together. Add only the SIDEY route from the tunnel example.

```sh
python3 deploy/blue_green.py --key-file /etc/sidey/deployment.key \
  launch blue 'registry.example/sidey-server@sha256:<image-digest>' \
  /etc/sidey/server.env /etc/sidey/secrets
python3 deploy/blue_green.py --key-file /etc/sidey/deployment.key switch blue --bootstrap
```

Nginx listens only on host loopback port 8088 for the tunnel. Slots use application
ports 8081/8082 and management ports 9081/9082, also loopback-only via host network.
Keep these ports out of public firewall/NAT rules. Ensure the existing Nginx worker
file-descriptor/connection limits can support 2500 upgraded clients plus upstream
sockets (for example at least 8192 worker connections). Nginx forwards raw WS
upgrade headers and uses a 75-second read timeout above the 20-second heartbeat.
Only `/api/` is proxied: management and internal operations are never public.

The Linux rehearsal hit both Nginx limits independently (768 connections, then
1024 file descriptors per worker). Merge these settings into the **main** and
**events** contexts of the existing configuration; do not put them in the SIDEY
`http` include or replace unrelated configuration:

```nginx
# main context
worker_rlimit_nofile 16384;
events {
    worker_connections 8192;
    # Preserve the existing events settings.
}
```

Validate with `nginx -t` and inspect the actual worker `/proc/<pid>/limits` after
reload. The main Nginx process needs permission to raise the worker limit. A
container/service hard limit below this value must be corrected in that service's
own configuration. This is required proxy capacity, not a change to JVM limits.

For an offline image transfer, `nerdctl save -o release.tar <release-tag>` followed
by `nerdctl load -i release.tar` was exercised on containerd. Confirm the manifest
digest with `nerdctl images --digests`. A locally built/imported tag may not have
the digest-name alias needed by the launcher; register the **same verified** digest
using `nerdctl tag <release-tag> <repository>@sha256:<manifest-digest>` before
launching. Never invent a digest or infer it from the image configuration ID.

## Subsequent blue/green releases

Launch the inactive slot with its new digest, then `switch green` (or blue):

1. Check candidate readiness and its inactive/quiescent status.
2. Disable admission on the old process; close existing sockets with 1012 and wait
   for admitted HTTP, WS and maintenance operations to finish (maximum 30 seconds).
3. Activate the candidate, invalidating any stale membership cache.
4. Atomically replace the upstream include, run `nginx -t`, reload Nginx.
5. Stop only the named old `sidey-server-blue`/`sidey-server-green` container.

A brief 503/reconnect window is intentional. Nginx reload alone cannot move an
existing WS to the new process. There is never an intentional two-active period.
The operator uses a host file lock; all deployment operators must use that same
lock/path. An HTTP response loss is treated as uncertain state: rollback must prove
the candidate inactive before reactivating the old process. Failure to establish
this proof leaves traffic unavailable rather than opening two active JVMs. Inspect
both loopback `/internal/deployment/status` endpoints using the deployment header
and local logs; do not manually activate a slot until the other is stopped or
confirmed quiescent. A process/container restart starts inactive by construction.
Recover by quiescing/stopping the other slot, then using the authenticated activation
operation for the selected route; do not assume the upstream file proves liveness.

Stopped containers are intentionally retained for inspection. Explicitly remove
only the stopped SIDEY slot you intend to reuse (`nerdctl rm sidey-server-green`,
for example). The launcher refuses to overwrite existing containers. If the old
stop fails after a successful switch, the new route remains active and the old
process remains admission-disabled; resolve its termination separately.

Flyway runs at startup. Future releases must use expand/migrate/contract changes:
candidate schema changes must remain compatible with the old running version and
rollback version. Do not combine destructive schema contraction with a switch or
use Flyway clean against production. Application rollback does not undo migrated
schema or purchases; retain verified backups and grant/audit provenance.

## Observability and checks

Merge `deploy/prometheus.yml.example` into the existing Prometheus configuration.
An inactive slot may be UP but has `sidey_serving_accepting=0`. Alerts should follow
the active slot, connection/queue pressure, message errors, Hikari saturation and
HTTP errors. Exposed series include `sidey_ws_connections`, `sidey_ws_subscriptions`,
`sidey_presence_sessions`, `sidey_ws_queued_bytes`, `sidey_serving_inflight`, message
counters and standard JVM/HTTP/Hikari metrics. `/actuator/prometheus` is permitted
only on the loopback management listener; application-port access is denied.

Use the existing containerd/Alloy log collection for the named SIDEY containers;
application stdout is structured JSON. Collect the Nginx SIDEY JSON access file
with the existing Alloy file source and Loki destination. Logs omit request bodies,
authorization headers and query strings. Do not enable request/SQL parameter dumps
or high-cardinality user/session/message labels. No new logging service is needed.

```sh
./mvnw -q -Dtest=DeploymentTest,HttpContractTest,WebSocketContractTest test
python3 -m unittest discover -s deploy -p 'test_*.py'
python3 deploy/test_nginx.py /path/to/nginx
sh -n deploy/build-image.sh
```

Local validation executes a real Nginx process on temporary loopback ports and
actual Spring HTTP/WS listeners backed by PostgreSQL. Container image build/run,
the target's existing Nginx/Alloy/tunnel configuration, production provider calls
and production import/cutover still require verification on the deployment host.

References: [Spring management listeners](https://docs.spring.io/spring-boot/reference/actuator/monitoring.html),
[Nginx WS proxying](https://nginx.org/en/docs/http/websocket.html),
[nerdctl command reference](https://github.com/containerd/nerdctl/blob/main/docs/command-reference.md).
