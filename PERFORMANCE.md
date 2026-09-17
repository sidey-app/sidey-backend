# Measured validation — 2026-09-17

Disposable Ubuntu 24.04 ARM64 Lima VM, 4 CPUs/4 GiB, containerd 2.3.3,
Java 21.0.12, PostgreSQL 17.11, Nginx. Production container settings:
UID 10001, read-only root, 64 MiB tmpfs, 512 PIDs, 1280 MiB container,
`-Xms256m -Xmx768m`. This is not an msi-server production capacity certification.

The same k6 v1.7.0 mixed workload ran before/after the limiter change:
2,500 distinct authenticated connections, rooms of 12, 15-second connection ramp,
60 seconds per connection. Each client sends heartbeat, typing, presence, pulse,
throw and persistent messages. Ten k6 VUs run on the Mac through four independent
SSH forwards to Nginx; both runs use the same path and server resource limits.
About 1,700 commands/s and 19,350 delivered frames/s were observed. Short stress
runs are not a soak test or an estimate of daily sustained throughput.

| Measurement | Before | After |
| --- | ---: | ---: |
| Accepted/subscribed | 2,500/2,500 | 2,500/2,500 |
| Command errors / unexpected disconnects | 0 / 0 | 0 / 0 |
| Message ACK mean | 30.34 ms | 8.59 ms |
| Message ACK p95 | 239.78 ms | 19.89 ms |
| Message ACK maximum | 486.21 ms | 136.09 ms |
| JFR execution samples containing TransientLimiter | 1,734 / 2,980 (58.19%) | 5 / 1,298 (0.39%) |

The observed hotspot was the synchronized full-map expiration scan on every
transient command. The change orders windows by last accepted event, evicts an
expired prefix and prunes only the requested window. The 10-second rolling limit,
20,000-key bound and reconnect-independent per-user limits remain. Clock rollback
cannot reopen a window. A deterministic 100,000-event reference comparison,
capacity/expiry and concurrent-limit tests pass in the full 76-test build.

No outbound worker-count or connection-cap tuning was made: 64 workers, a bounded
4096-task executor queue, global cap 3000 and per-user cap 16 remain.

Measurement setup failures were excluded: a shared SSH control tunnel closed;
single SSH tunnels hit descriptor/channel limits; VM wall-clock correction made
some VM-local k6 latency samples negative. The final comparison runs on the Mac.
Default Nginx `worker_connections 768` accepted only 1,528 sockets; increasing only
that setting exposed the worker's 1,024-FD limit. Both existing deployment
requirements were then applied: `worker_connections 8192` and
`worker_rlimit_nofile 16384`. No application rewrite addressed those proxy limits.

Reproduction scripts and complete remaining validation are in
`scripts/validation/` and `VALIDATION-2026-09-17.md`. Raw JFR files remain private:
they can include JVM environment information and must never be committed.
