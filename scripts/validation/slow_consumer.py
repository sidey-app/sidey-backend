#!/usr/bin/env python3
"""Real stalled TCP consumer and healthy peer ACK latency; disposable VM only."""
import asyncio
import json
import os
from pathlib import Path
import socket
import statistics
import subprocess
import time
import uuid
import urllib.parse
import urllib.request
import websockets

assert socket.gethostname() == 'lima-sidey-validation'
directory = Path('/home/jungjiyu.linux/sidey-lab/runtime')
fixtures = json.loads((directory / 'tokens.json').read_text())
env = dict(line.split('=', 1) for line in (directory / 'server.env').read_text().splitlines())
assert env['SIDEY_DATABASE_URL'].endswith(':55433/sidey_validation')


async def connect(fixture, room, stalled=False):
    # Isolate the application's outbound bound from Nginx's extra TCP buffers.
    port = int(Path('/etc/nginx/sidey-active-upstream.conf').read_text().split(':')[-1].rstrip(';\n')) if stalled else 8088
    ws = await websockets.connect(f'ws://127.0.0.1:{port}/api/realtime', extra_headers={'Authorization': 'Bearer ' + fixture['token']}, ping_interval=None, max_queue=1, compression=None)
    assert json.loads(await ws.recv())['type'] == 'connected'
    await ws.send(json.dumps({'type': 'subscribe', 'roomId': room}))
    while True:
        event = json.loads(await ws.recv())
        assert event['type'] != 'error', event
        if event['type'] == 'ack':
            break
    return ws


async def main():
    slow = fixtures[0]
    rooms = [slow['room']]
    senders = [(fixtures[i], rooms[0]) for i in range(1, 12)]
    statements = ['begin;', f"delete from rooms where name='Slow socket lab' and owner_id='{slow['user']}';"]
    for group in range(1, 5):
        room = str(uuid.uuid4())
        rooms.append(room)
        statements.append(f"insert into rooms(id,name,owner_id) values ('{room}','Slow socket lab','{slow['user']}');")
        statements.append(f"insert into room_members(room_id,user_id) values ('{room}','{slow['user']}');")
        for i in range(group * 12, group * 12 + 11):
            f = fixtures[i]
            statements.append(f"insert into room_members(room_id,user_id) values ('{room}','{f['user']}');")
            senders.append((f, room))
    statements.append('commit;')
    subprocess.run(['psql', '-h', '127.0.0.1', '-p', '55433', '-U', 'sidey_validation', '-d', 'sidey_validation', '-q', '-v', 'ON_ERROR_STOP=1'], input='\n'.join(statements), text=True, check=True,
                   env={**os.environ, 'PGPASSWORD': env['SIDEY_DATABASE_PASSWORD']}, stdout=subprocess.DEVNULL)
    stalled = await connect(slow, rooms[0], stalled=True)
    for room in rooms[1:]:
        await stalled.send(json.dumps({'type': 'subscribe', 'roomId': room}))
        assert json.loads(await stalled.recv())['type'] == 'ack'
    stalled.transport.get_extra_info('socket').setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
    stalled.transport.pause_reading()
    latencies, failures = [], []
    deadline = time.monotonic() + 90

    async def healthy(fixture, room):
        ws = await connect(fixture, room)
        pending = {}
        async def read():
            try:
                async for frame in ws:
                    event = json.loads(frame)
                    if event['type'] == 'message.ack':
                        latencies.append((time.monotonic() - pending.pop(event['requestId'])) * 1000)
                    elif event['type'] == 'error':
                        failures.append(event['code'])
            except websockets.ConnectionClosed as error:
                if time.monotonic() < deadline:
                    failures.append('healthy_close_' + str(error.code))
        reader = asyncio.create_task(read())
        counter = 0
        while time.monotonic() < deadline:
            mid = str(uuid.uuid4())
            pending[mid] = time.monotonic()
            await ws.send(json.dumps({'type': 'message.send', 'roomId': room, 'id': mid, 'body': '검' * 200, 'requestId': mid}))
            if counter % 25 == 0:
                await ws.send(json.dumps({'type': 'heartbeat'}))
            counter += 1
            await asyncio.sleep(0.42)
        await asyncio.sleep(1)
        if pending:
            failures.append('missing_ack')
        await ws.close()
        await reader

    async def stalled_heartbeat():
        while time.monotonic() < deadline:
            try:
                await stalled.send(json.dumps({'type': 'heartbeat'}))
            except websockets.ConnectionClosed:
                break
            await asyncio.sleep(15)

    heartbeat = asyncio.create_task(stalled_heartbeat())
    await asyncio.gather(*(healthy(f, r) for f, r in senders))
    heartbeat.cancel()
    stalled.transport.resume_reading()
    code = None
    try:
        async with asyncio.timeout(20):
            async for frame in stalled:
                pass
    except websockets.ConnectionClosed as closed:
        code = closed.code
    except TimeoutError:
        code = 'not_disconnected'
    await stalled.close()
    latencies.sort()
    result = {'healthy_acks': len(latencies), 'healthy_errors': failures, 'ack_p95_ms': latencies[int(len(latencies) * .95)], 'ack_max_ms': max(latencies), 'slow_close_code': code}
    print(json.dumps(result), flush=True)
    assert not failures and len(latencies) > 10000, result
    # Queue overflow or the Tomcat bounded write timeout closes this real transport.
    assert code in (1013, 1006, 1011), result
    subprocess.run(['psql', '-h', '127.0.0.1', '-p', '55433', '-U', 'sidey_validation', '-d', 'sidey_validation', '-q', '-v', 'ON_ERROR_STOP=1', '-c', "delete from rooms where id in (" + ','.join("'" + r + "'" for r in rooms[1:]) + ")"],
                   env={**os.environ, 'PGPASSWORD': env['SIDEY_DATABASE_PASSWORD']}, check=True)


async def recovery():
    fixture = fixtures[0]
    ws = await connect(fixture, fixture['room'])
    ids = set()
    cursor = None
    pages = 0
    while True:
        query = {'limit': 200}
        if cursor:
            query.update(afterCreatedAt=cursor['createdAt'], afterId=cursor['id'])
        request = urllib.request.Request('http://127.0.0.1:8088/api/rooms/' + fixture['room'] + '/messages?' + urllib.parse.urlencode(query), headers={'Authorization': 'Bearer ' + fixture['token']})
        with urllib.request.urlopen(request, timeout=10) as response:
            page = json.load(response)
        for message in page['messages']:
            assert message['id'] not in ids
            ids.add(message['id'])
        pages += 1
        cursor = page['nextCursor']
        if cursor is None:
            break
    expected = int(subprocess.check_output(['psql', '-h', '127.0.0.1', '-p', '55433', '-U', 'sidey_validation', '-d', 'sidey_validation', '-At', '-c', f"select count(*) from messages where room_id='{fixture['room']}' and created_at>=clock_timestamp()-interval '3 days'"], env={**os.environ, 'PGPASSWORD': env['SIDEY_DATABASE_PASSWORD']}, text=True).strip())
    assert len(ids) == expected and expected > 1000
    await ws.close()
    print(json.dumps({'post_slow_consumer_recovery': 'PASS', 'pages': pages, 'unique_messages': len(ids), 'database_messages': expected}))


if __name__ == '__main__':
    import sys
    if '--recover-only' not in sys.argv:
        asyncio.run(main())
    asyncio.run(recovery())
