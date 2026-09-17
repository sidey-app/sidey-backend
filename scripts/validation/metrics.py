#!/usr/bin/env python3
"""Sample non-secret Prometheus capacity metrics from a loopback lab listener."""
import argparse
import json
import time
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--url", default="http://127.0.0.1:19081/actuator/prometheus")
parser.add_argument("--seconds", type=int, default=90)
args = parser.parse_args()
prefixes = ("process_cpu_usage", "process_cpu_time", "process_resident_memory", "system_cpu_usage",
            "jvm_memory_used_bytes", "jvm_gc_pause_seconds", "jvm_threads_live", "hikaricp_",
            "sidey_", "executor_")
end = time.monotonic() + args.seconds
while time.monotonic() < end:
    try:
        with urllib.request.urlopen(args.url, timeout=3) as response:
            lines = response.read().decode().splitlines()
        selected = {line.rsplit(" ", 1)[0]: float(line.rsplit(" ", 1)[1]) for line in lines if line.startswith(prefixes)}
        print(json.dumps({"time": time.time(), "metrics": selected}), flush=True)
    except (OSError, ValueError) as error:
        print(json.dumps({"time": time.time(), "error": type(error).__name__}), flush=True)
    time.sleep(2)
