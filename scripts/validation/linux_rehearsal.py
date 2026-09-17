#!/usr/bin/env python3
"""Actual Linux/containerd/Nginx rehearsal. Refuses any host except our disposable VM.

Requires copied deploy/blue_green.py, seeded runtime/, inactive green and active blue.
Run as root inside lima-sidey-validation. Writes no provider or token values to output.
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import time
from types import SimpleNamespace
import urllib.error
import urllib.request
import urllib.parse
import uuid
import websockets
import psycopg2

LAB = Path('/home/jungjiyu.linux/sidey-lab')
assert socket.gethostname() == 'lima-sidey-validation', 'Disposable VM only'
values = dict(line.split('=', 1) for line in (LAB / 'runtime/server.env').read_text().splitlines())
assert values['SIDEY_DATABASE_URL'].endswith(':55433/sidey_validation')
fixtures = json.loads((LAB / 'runtime/tokens.json').read_text())
spec = importlib.util.spec_from_file_location('deployment', LAB / 'deploy/blue_green.py')
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
args = SimpleNamespace(upstream='/etc/nginx/sidey-active-upstream.conf', key_file=str(LAB / 'runtime/deployment.key'),
                       nginx='nginx', nginx_config='/etc/nginx/nginx.conf', nerdctl='nerdctl')
host = deployment.Host(args)
report = {}


def http(path, body=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request('http://127.0.0.1:8088' + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            data = response.read()
            return response.status, json.loads(data) if data else None
    except urllib.error.HTTPError as error:
        data = error.read()
        try:
            data = json.loads(data)
        except ValueError:
            data = None
        return error.code, data


def sql(query):
    return subprocess.check_output(['psql', '-h', '127.0.0.1', '-p', '55433', '-U', 'sidey_validation', '-d', 'sidey_validation', '-v', 'ON_ERROR_STOP=1', '-At', '-c', query],
                                   env={**os.environ, 'PGPASSWORD': values['SIDEY_DATABASE_PASSWORD']}, text=True).strip()


async def receive(ws, kind):
    async with asyncio.timeout(15):
        while True:
            value = json.loads(await ws.recv())
            assert value['type'] != 'error', value
            if value['type'] == kind:
                return value


async def connect(fixture):
    ws = await websockets.connect('ws://127.0.0.1:8088/api/realtime', extra_headers={'Authorization': 'Bearer ' + fixture['token']}, ping_interval=None)
    await receive(ws, 'connected')
    await ws.send(json.dumps({'type': 'subscribe', 'roomId': fixture['room'], 'requestId': 'subscribe'}))
    await receive(ws, 'ack')
    return ws


async def main():
    f = fixtures[0]
    for path in ['/internal/deployment/status', '/actuator/prometheus', '/internal/deployment/activate']:
        assert http(path)[0] == 404
    report['private_routes_through_nginx'] = '404'
    assert http('/api/rooms', token=f['token'])[0] == 200
    report['rest_through_nginx'] = 'PASS'
    before = sql('select (select count(*) from users)||\',\'||(select count(*) from user_sessions)||\',\'||(select count(*) from commerce_grants)')
    provider_results = {}
    for provider in ['GOOGLE', 'APPLE']:
        status, challenge = http('/api/auth/challenge', {})
        assert status == 200
        status, failure = http('/api/auth/login', {'provider': provider, 'credential': 'invalid-lab-proof', 'nonce': challenge['nonce'], 'platform': 'OTHER'})
        assert status == 401 and failure['code'] == 'identity_provider_unavailable', (status, failure)
        provider_results[provider] = {'status': status, 'code': failure['code']}
    status, failure = http('/api/app-store/transactions', {'signedTransactionInfo': 'invalid-lab-proof'}, f['token'])
    assert status == 503 and failure['code'] == 'apple_not_configured', (status, failure)
    provider_results['APP_STORE'] = {'status': status, 'code': failure['code']}
    status, failure = http('/api/commerce/portone/webhook', {})
    assert status >= 400
    provider_results['PORTONE_WEBHOOK'] = {'status': status, 'code': failure['code']}
    assert sql('select (select count(*) from users)||\',\'||(select count(*) from user_sessions)||\',\'||(select count(*) from commerce_grants)') == before
    report['provider_fail_closed'] = provider_results

    ws = await connect(f)
    mid = str(uuid.uuid4())
    command = {'type': 'message.send', 'roomId': f['room'], 'id': mid, 'body': 'Deployment rehearsal', 'requestId': mid}
    await ws.send(json.dumps(command))
    canonical = (await receive(ws, 'message.ack'))['message']
    await ws.send(json.dumps({'type': 'presence.update', 'activeRoomId': f['room'], 'activity': 'ONLINE'}))
    assert (await receive(ws, 'presence'))['members'][f['user']] == 'ONLINE'

    class LostActivation(deployment.Host):
        fail_drain = False
        def control(self, slot, action):
            if self.fail_drain and slot == 'green' and action == 'drain':
                raise TimeoutError('Injected unreachable candidate')
            value = super().control(slot, action)
            if action in ('activate', 'drain'):
                states = [super(LostActivation, self).control(s, 'status') for s in ('blue', 'green')]
                assert sum(s['accepting'] for s in states) <= 1
            if slot == 'green' and action == 'activate':
                raise TimeoutError('Injected response loss AFTER real server activation')
            return value

    try:
        await asyncio.to_thread(deployment.switch, LostActivation(args), 'green')
        raise AssertionError('Expected switch failure')
    except RuntimeError:
        pass
    await asyncio.wait_for(ws.wait_closed(), 15)
    assert ws.close_code == 1012, ws.close_code
    assert host.control('blue', 'status')['accepting'] and deployment.quiescent(host.control('green', 'status'))
    report['lost_activation_response_rollback'] = 'PASS; old active, candidate quiescent, WS 1012'

    failure_host = LostActivation(args)
    failure_host.fail_drain = True
    try:
        await asyncio.to_thread(deployment.switch, failure_host, 'green')
        raise AssertionError('Expected fail-closed switch failure')
    except RuntimeError:
        pass
    assert deployment.quiescent(host.control('blue', 'status')) and host.control('green', 'status')['accepting']
    assert http('/api/rooms', token=f['token'])[0] == 503
    host.control('green', 'drain')
    host.control('blue', 'activate')
    report['unreachable_rollback_fail_closed'] = 'PASS; old stayed disabled, no simultaneous writer'

    # Both inactive: cross the real 60s scheduled maintenance boundary.
    host.control('blue', 'drain')
    expired_message, expired_session = str(uuid.uuid4()), str(uuid.uuid4())
    sql(f"insert into messages(id,room_id,sender_id,body,created_at) values ('{expired_message}','{f['room']}','{f['user']}','expired fixture',now()-interval '4 days'); insert into user_sessions(id,user_id,refresh_token_hash,created_at,last_refreshed_at,expires_at,absolute_expires_at,device_platform) values ('{expired_session}','{f['user']}',decode('{os.urandom(32).hex()}','hex'),now()-interval '2 days',now()-interval '2 days',now()-interval '1 day',now()+interval '180 days','OTHER')")
    await asyncio.sleep(65)
    assert sql(f"select count(*) from messages where id='{expired_message}'") == '1'
    assert sql(f"select count(*) from user_sessions where id='{expired_session}' and revoked_at is null") == '1'
    sql(f"delete from messages where id='{expired_message}'; delete from user_sessions where id='{expired_session}'")
    report['inactive_scheduled_maintenance'] = 'PASS; expired message/session unchanged for 65 seconds'
    host.control('blue', 'activate')

    ws = await connect(f)
    blocked = psycopg2.connect(host='127.0.0.1', port=55433, user='sidey_validation', dbname='sidey_validation', password=values['SIDEY_DATABASE_PASSWORD'])
    with blocked.cursor() as cursor:
        cursor.execute('select 1 from room_members where room_id=%s and user_id=%s for update', (f['room'], f['user']))
    inflight_id = str(uuid.uuid4())
    await ws.send(json.dumps({'type': 'message.send', 'roomId': f['room'], 'id': inflight_id, 'body': 'Committed during drain'}))
    for _ in range(100):
        if host.control('blue', 'status')['inFlight'] > 0:
            break
        await asyncio.sleep(.05)
    else:
        raise AssertionError('No admitted blocked message')
    async def release_transaction():
        await asyncio.sleep(3)
        blocked.commit()
        blocked.close()
    release = asyncio.create_task(release_transaction())
    started = time.monotonic()
    await asyncio.to_thread(deployment.switch, host, 'green')
    await release
    assert time.monotonic() - started >= 2.5
    await asyncio.wait_for(ws.wait_closed(), 15)
    assert ws.close_code == 1012
    assert not host.running('blue') and host.control('green', 'status')['accepting']
    ws = await connect(f)
    # Subscribe first, durable history then canonical retry and JVM presence rebuild.
    query = urllib.parse.urlencode({'afterCreatedAt': canonical['createdAt'], 'afterId': mid, 'limit': 200})
    status, page = http('/api/rooms/' + f['room'] + '/messages?' + query, token=f['token'])
    assert status == 200 and inflight_id in [m['id'] for m in page['messages']]
    await ws.send(json.dumps(command))
    assert (await receive(ws, 'message.ack'))['message'] == canonical
    assert sql(f"select count(*) from messages where id='{mid}'") == '1'
    await ws.send(json.dumps({'type': 'presence.update', 'activeRoomId': f['room'], 'activity': 'AWAY'}))
    assert (await receive(ws, 'presence'))['members'][f['user']] == 'AWAY'
    await ws.close()
    report['successful_switch_recovery'] = 'PASS; WS1012, old stopped, subscribe/history/retry/presence rebuilt'
    report['inflight_drain'] = 'PASS; waited for real PostgreSQL membership lock, committed without ACK, recovered after cursor'
    print(json.dumps(report, indent=2))


asyncio.run(main())
