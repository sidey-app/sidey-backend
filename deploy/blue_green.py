#!/usr/bin/env python3
"""Host-local, fail-closed single-active deployment; never evaluates a shell."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

PORTS = {"blue": (8081, 9081), "green": (8082, 9082)}


def quiescent(status):
    return status.get("accepting") is False and status.get("inFlight") == 0 and status.get("connections") == 0


class Host:
    def __init__(self, args):
        self.args = args
        self.upstream = Path(args.upstream)
        self.key = Path(args.key_file).read_text().strip()
        if len(self.key) < 32 or "\n" in self.key:
            raise RuntimeError("Invalid deployment key file")
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def run(self, *command):
        # No secret values are command arguments; no inherited HTTP proxy for control.
        return subprocess.run(command, check=True, text=True, capture_output=True, timeout=120).stdout

    def control(self, slot, action):
        request = urllib.request.Request(
            f"http://127.0.0.1:{PORTS[slot][0]}/internal/deployment/{action}",
            method="GET" if action == "status" else "POST",
            headers={"X-Sidey-Deployment-Key": self.key},
        )
        with self.opener.open(request, timeout=40) as response:
            value = json.loads(response.read(4096))
        if not isinstance(value, dict) or not isinstance(value.get("accepting"), bool):
            raise RuntimeError("Invalid deployment control response")
        return value

    def ready(self, slot):
        end = time.monotonic() + 60
        while time.monotonic() < end:
            try:
                with self.opener.open(f"http://127.0.0.1:{PORTS[slot][1]}/actuator/health/readiness", timeout=3) as response:
                    if json.loads(response.read(4096)).get("status") == "UP":
                        return
            except (OSError, ValueError):
                pass
            time.sleep(0.5)
        raise RuntimeError("Candidate readiness timed out")

    def running(self, slot):
        names = self.run(self.args.nerdctl, "ps", "--format", "{{.Names}}").splitlines()
        return "sidey-server-" + slot in names

    def active(self):
        if not self.upstream.exists():
            return None
        value = self.upstream.read_text().strip()
        for slot, ports in PORTS.items():
            if value == f"server 127.0.0.1:{ports[0]};":
                return slot
        raise RuntimeError("Refusing to replace an unrecognized upstream file")

    def route(self, slot):
        self.upstream.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=".sidey-upstream-", dir=self.upstream.parent)
        try:
            with os.fdopen(descriptor, "w") as stream:
                stream.write(f"server 127.0.0.1:{PORTS[slot][0]};\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o644)
            os.replace(temporary, self.upstream)
        finally:
            Path(temporary).unlink(missing_ok=True)
        self.run(self.args.nginx, "-t", "-c", self.args.nginx_config)
        self.run(self.args.nginx, "-s", "reload", "-c", self.args.nginx_config)

    def stop(self, slot):
        self.run(self.args.nerdctl, "stop", "--time", "40", "sidey-server-" + slot)

    def launch(self, slot, image, env_file, secrets):
        if self.active() == slot:
            raise RuntimeError("Refusing to launch over the configured active slot")
        names = self.run(self.args.nerdctl, "ps", "-a", "--format", "{{.Names}}").splitlines()
        if "sidey-server-" + slot in names:
            raise RuntimeError("Slot already exists; inspect and explicitly remove that stopped SIDEY container first")
        if not re.fullmatch(r"[^\s]+@sha256:[a-f0-9]{64}", image):
            raise RuntimeError("Use an immutable image reference with sha256 digest")
        env_file, secrets = Path(env_file).resolve(), Path(secrets).resolve()
        if not env_file.is_file() or not secrets.is_dir() or "," in str(secrets):
            raise RuntimeError("Invalid environment file or secret directory")
        if env_file.stat().st_mode & 0o077:
            raise RuntimeError("Environment file must not be readable by group/others")
        self.run(self.args.nerdctl, "run", "-d", "--name", "sidey-server-" + slot,
                 "--network", "host", "--restart", "unless-stopped", "--read-only",
                 "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--memory", "1280m",
                 "--pids-limit", "512", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                 "--env-file", str(env_file), "--env", "SIDEY_SERVER_ADDRESS=127.0.0.1",
                 "--env", f"SIDEY_SERVER_PORT={PORTS[slot][0]}",
                 "--env", f"SIDEY_MANAGEMENT_PORT={PORTS[slot][1]}",
                 "--env", "SIDEY_MANAGEMENT_ADDRESS=127.0.0.1", "--env", "SIDEY_SERVING_ENABLED=false",
                 "--mount", f"type=bind,src={secrets},dst=/run/secrets,ro", image)
        self.ready(slot)
        if not quiescent(self.control(slot, "status")):
            raise RuntimeError("Candidate unexpectedly active; do not route traffic")


def switch(host, candidate, bootstrap=False):
    old = host.active()
    if candidate == old:
        raise RuntimeError("Candidate already selected; refusing an ambiguous repeated switch")
    other = "green" if candidate == "blue" else "blue"
    if old is None and (not bootstrap or host.running(other)):
        raise RuntimeError("Initial activation requires --bootstrap and no other running SIDEY slot")
    if old is not None and bootstrap:
        raise RuntimeError("Bootstrap cannot replace an existing upstream")
    host.ready(candidate)
    if not quiescent(host.control(candidate, "status")):
        raise RuntimeError("Candidate must be inactive before switching")
    drained = False
    try:
        if old is not None:
            if not quiescent(host.control(old, "drain")):
                raise RuntimeError("Old instance has not quiesced")
            drained = True
        if host.control(candidate, "activate").get("accepting") is not True:
            raise RuntimeError("Candidate activation failed")
        host.route(candidate)
    except Exception:
        # An HTTP response can be lost after activation. Always disable the candidate
        # before restoring the old JVM. If this cannot be proved, leave both stopped
        # or draining and require the operator to inspect; never guess.
        try:
            if not quiescent(host.control(candidate, "drain")):
                raise RuntimeError("Candidate drain pending")
            if old is not None and drained:
                host.route(old)
                if host.control(old, "activate").get("accepting") is not True:
                    raise RuntimeError("Old activation failed")
        except Exception as rollback_error:
            raise RuntimeError("Switch failed; rollback could not establish a safe active instance") from rollback_error
        raise RuntimeError("Switch failed; candidate inactive, old route restored when possible") from None
    if old is not None:
        # A stop failure must not roll back a successfully switched production route.
        host.stop(old)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", default="/etc/nginx/sidey-active-upstream.conf")
    parser.add_argument("--nginx-config", default="/etc/nginx/nginx.conf")
    parser.add_argument("--nginx", default="nginx")
    parser.add_argument("--nerdctl", default="nerdctl")
    parser.add_argument("--key-file", required=True)
    parser.add_argument("--lock-file", default="/run/lock/sidey-deployment.lock")
    commands = parser.add_subparsers(dest="command", required=True)
    launch = commands.add_parser("launch")
    launch.add_argument("slot", choices=PORTS)
    launch.add_argument("image")
    launch.add_argument("env_file")
    launch.add_argument("secrets_directory")
    activate = commands.add_parser("switch")
    activate.add_argument("slot", choices=PORTS)
    activate.add_argument("--bootstrap", action="store_true")
    args = parser.parse_args()
    with open(args.lock_file, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        host = Host(args)
        if args.command == "launch":
            host.launch(args.slot, args.image, args.env_file, args.secrets_directory)
        else:
            switch(host, args.slot, args.bootstrap)
    print("SIDEY deployment operation complete")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Do not echo provider/environment files or control response bodies.
        raise SystemExit(f"Deployment failed ({type(error).__name__}); inspect slot status and local service logs") from None
