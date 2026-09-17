# Disposable validation lab

These tools use no production verifier bypass. `lab_fixture.py` inserts synthetic
users/identities/sessions into the explicitly named **sidey_validation** database
on loopback port 55433, then signs short-lived fixture JWTs with that lab's random
key. Runtime files are mode 0600 and must stay outside Git. Never point this lab
at production or copy its generated environment into production.

The executed lab was `limactl start --name=sidey-validation --vm-type=vz --cpus=4
--memory=4 --disk=24 --mount-none --containerd=system --tty=false template:ubuntu-24.04`
with automatic TCP forwards disabled. It uses system containerd/BuildKit, not
Docker. The VM needs Nginx, PostgreSQL client, Python websockets/psycopg2 and a
Java 21 JDK for JFR. See the environment report for exact image digests.

Copy the jar to `sidey-lab/target`, deployment files to `sidey-lab/deploy`, these
scripts to `sidey-lab`, and use `/home/jungjiyu.linux/sidey-lab` as the lab root:

1. `python3 lab_fixture.py initialize runtime` creates private test environment.
2. Run the task-owned PostgreSQL 17 container with `runtime/postgres.env`, host
   network, `listen_addresses=127.0.0.1`, port 55433.
3. Build the repository Containerfile with its digest-pinned Java base, import/tag
   the same manifest digest as necessary, and launch **inactive blue** with the
   actual `deploy/blue_green.py` operator. Flyway creates the schema.
4. Install the SIDEY Nginx include in the VM, merge the main/event limits from
   DEPLOYMENT.md, validate syntax, bootstrap blue with the operator.
5. `python3 lab_fixture.py seed runtime --count 3300` creates room groups of 12.
   `python3 lab_fixture.py tokens runtime` renews fixture JWTs before later runs.
6. Launch inactive green. As VM root, `python3 linux_rehearsal.py` performs real
   response-loss/fail-closed/inactive-maintenance/in-flight-drain/recovery tests
   and leaves **green active, blue stopped**. Both slots should use the same image
   for a regression run. It refuses other hostnames/databases.
7. `python3 presence_limits.py` tests distinct service sessions, connection cap
   and 60-second expiry. `python3 slow_consumer.py` stalls one upstream TCP reader
   while 55 healthy clients use Nginx, then performs full cursor recovery.
   `--recover-only` repeats just that recovery. Run after capacity workloads.

Capacity (k6 v1.7.0, no provider/network secret arguments):

```sh
ulimit -n 16384
k6 run --summary-export runtime/load.json \
  -e FIXTURES=/private/lab/tokens.json \
  -e URL=ws://127.0.0.1:8088/api/realtime \
  -e CONNECTIONS=2500 -e MODE=mixed capacity.js
python3 metrics.py --url http://127.0.0.1:9082/actuator/prometheus --seconds 76
```

Run 1200/2500 mixed and 3200 idle admission tests. The last expects exactly 3000
connected/subscribed and 200 policy rejections. Thresholds reject actual command
errors and unexpected closes. For an external generator using SSH, one forwarding
connection hit about 1017 channels; use four independent forwards and comma-separated
`URLS`, each to the same Nginx listener. Raise the generator/forwarder FD limits.
The controlled before/after comparison used this external path. VM-local runs had
clock corrections and their latency figures were discarded.

Record JFR with the **host** Java PID from `nerdctl inspect`, copy the result from
`/proc/<host-pid>/root/tmp/`, and remove it after collection to respect the 64 MiB
tmpfs budget. JFR may include environment secrets: keep private, never commit raw
recordings. Only aggregate execution samples/metrics belong in reports.

`tunnel_smoke.py <https://temporary.trycloudflare.com> <private-token-file>` checks
HTTPS/WSS and private-route 404 through a separate temporary Tunnel. Stop that
Tunnel afterwards. It refuses a production hostname. No paid provider operation
is included. Stop only task-owned containers/VM when finished.
