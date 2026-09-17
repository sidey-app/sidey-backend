#!/usr/bin/env python3
"""Run only the CI image on runner loopback with disposable PostgreSQL/keys."""
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


def inspect_image(image, revision):
    info = json.loads(docker('image', 'inspect', image))[0]
    config = info['Config']
    if (info['Os'], info['Architecture'], config['User']) != ('linux', 'amd64', '10001:10001'):
        raise RuntimeError('Image must be linux/amd64 running as UID/GID 10001')
    if config['Entrypoint'] != ['java', '-jar', '/app/sidey-server.jar']:
        raise RuntimeError('Production executable JAR entrypoint changed')
    if 'JAVA_TOOL_OPTIONS=-Xms256m -Xmx768m -XX:+ExitOnOutOfMemoryError' not in config['Env']:
        raise RuntimeError('Production JVM budget changed')
    labels = config.get('Labels', {})
    if labels.get('org.opencontainers.image.revision') != revision:
        raise RuntimeError('Image revision differs from tested commit')
    if labels.get('org.opencontainers.image.source') != 'https://github.com/sidey-app/sidey-backend':
        raise RuntimeError('Image repository metadata mismatch')
    return info['Id']


def request(port, path):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}', timeout=3) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def smoke(image, revision):
    inspect_image(image, revision)
    # Fixed runner-local destination: this helper cannot select a production DB.
    env = {
        'SIDEY_DATABASE_URL': 'jdbc:postgresql://127.0.0.1:55432/sidey',
        'SIDEY_DATABASE_USER': 'sidey',
        'SIDEY_DATABASE_PASSWORD': 'sidey-disposable-ci',
        'SIDEY_SERVER_ADDRESS': '127.0.0.1',
        'SIDEY_SERVER_PORT': '18080',
        'SIDEY_MANAGEMENT_ADDRESS': '127.0.0.1',
        'SIDEY_MANAGEMENT_PORT': '19090',
    }
    for key in ('SIDEY_JWT_SECRET', 'SIDEY_INVITE_PEPPER', 'SIDEY_DEPLOYMENT_KEY'):
        env[key] = base64.b64encode(secrets.token_bytes(32)).decode()
    name = 'sidey-ci-smoke-' + secrets.token_hex(6)
    try:
        with tempfile.NamedTemporaryFile(mode='w', prefix='sidey-ci-', suffix='.env') as file:
            os.chmod(file.name, 0o600)
            file.write(''.join(f'{key}={value}\n' for key, value in env.items()))
            file.flush()
            docker('run', '--detach', '--name', name, '--platform', 'linux/amd64',
                   '--network', 'host', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
                   '--pids-limit', '256', '--memory', '1g', '--cap-drop', 'ALL',
                   '--security-opt', 'no-new-privileges', '--env-file', file.name, image)
        for _ in range(120):
            if docker('inspect', '--format', '{{.State.Running}}', name) != 'true':
                raise RuntimeError('Image process exited during startup')
            try:
                status, body = request(19090, '/actuator/health/readiness')
                if status == 200 and json.loads(body).get('status') == 'UP':
                    break
            except (urllib.error.URLError, TimeoutError):
                pass
            time.sleep(1)
        else:
            raise RuntimeError('Image readiness did not become UP')
        if request(19090, '/actuator/health')[0] != 200:
            raise RuntimeError('Management listener health failed')
        if request(18080, '/api/rooms')[0] != 401:
            raise RuntimeError('Application listener must reject unauthenticated room access')
        logs = docker('logs', name)
        if 'Application run failed' in logs or 'APPLICATION FAILED TO START' in logs:
            raise RuntimeError('Fatal startup error found')
        print('Image smoke PASS: linux/amd64, UID 10001, read-only root, readiness UP, both listeners, protected REST')
    except Exception:
        result = subprocess.run(['docker', 'logs', '--tail', '120', name], capture_output=True, text=True)
        logs = result.stdout + result.stderr
        for value in env.values():
            logs = logs.replace(value, '[REDACTED]')
        print(logs, file=sys.stderr)
        raise
    finally:
        subprocess.run(['docker', 'rm', '--force', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    smoke(*sys.argv[1:])
