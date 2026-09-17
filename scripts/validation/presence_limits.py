#!/usr/bin/env python3
"""Actual per-user connection ceiling, multi-connection presence and expiry."""
import asyncio
import json
from pathlib import Path
import socket
import time
import uuid
import secrets
import psycopg2
import websockets
from lab_fixture import issue

assert socket.gethostname() == 'lima-sidey-validation'
f = json.loads(Path('/home/jungjiyu.linux/sidey-lab/runtime/tokens.json').read_text())[-1]


async def connect(fixture=f):
    return await websockets.connect('ws://127.0.0.1:8088/api/realtime', extra_headers={'Authorization': 'Bearer ' + fixture['token']}, ping_interval=None)


async def next_type(ws, kind):
    async with asyncio.timeout(10):
        while True:
            event = json.loads(await ws.recv())
            assert event['type'] != 'error', event
            if event['type'] == kind:
                return event


async def main():
    sockets = []
    for _ in range(16):
        ws = await connect()
        await next_type(ws, 'connected')
        sockets.append(ws)
    overflow = await connect()
    await asyncio.wait_for(overflow.wait_closed(), 5)
    assert overflow.close_code == 1008
    for ws in sockets[2:]:
        await ws.close()
    one, replaced = sockets[:2]
    await replaced.close()
    values = dict(line.split('=', 1) for line in Path('/home/jungjiyu.linux/sidey-lab/runtime/server.env').read_text().splitlines())
    second = {**f, 'sid': str(uuid.uuid4())}
    with psycopg2.connect(host='127.0.0.1', port=55433, user='sidey_validation', dbname='sidey_validation', password=values['SIDEY_DATABASE_PASSWORD']) as connection:
        with connection.cursor() as cursor:
            cursor.execute("insert into user_sessions(id,user_id,refresh_token_hash,created_at,last_refreshed_at,expires_at,absolute_expires_at,device_platform) values (%s,%s,%s,now(),now(),now()+interval '1 day',now()+interval '180 days','WINDOWS')", (second['sid'], f['user'], secrets.token_bytes(32)))
    second['token'] = issue(values, second)
    two = await connect(second)
    await next_type(two, 'connected')
    for ws in (one, two):
        await ws.send(json.dumps({'type': 'subscribe', 'roomId': f['room']}))
        await next_type(ws, 'ack')
    for ws, activity in [(one, 'AWAY'), (two, 'ONLINE')]:
        await ws.send(json.dumps({'type': 'presence.update', 'activeRoomId': f['room'], 'activity': activity}))
        await next_type(ws, 'presence')
    async def snapshot(expected):
        # Drain pending broadcasts before requesting the authoritative aggregate.
        await asyncio.sleep(.1)
        while one.messages:
            await one.recv()
        await one.send(json.dumps({'type': 'presence.snapshot', 'roomId': f['room']}))
        assert (await next_type(one, 'presence'))['members'][f['user']] == expected
    await snapshot('ONLINE')
    await two.close()
    await snapshot('AWAY')
    started = time.monotonic()
    await asyncio.wait_for(one.wait_closed(), 70)
    elapsed = time.monotonic() - started
    assert 55 <= elapsed <= 65, elapsed
    # New connection has reconstructed membership and no stale presence.
    recovered = await connect()
    await next_type(recovered, 'connected')
    await recovered.send(json.dumps({'type': 'subscribe', 'roomId': f['room']}))
    await next_type(recovered, 'ack')
    await recovered.send(json.dumps({'type': 'presence.snapshot', 'roomId': f['room']}))
    assert (await next_type(recovered, 'presence'))['members'][f['user']] == 'OFFLINE'
    await recovered.close()
    print(json.dumps({'per_user_accepted': 16, 'overflow_close': overflow.close_code, 'aggregation': 'ONLINE > AWAY > OFFLINE', 'dead_session_removed_seconds': round(elapsed, 3), 'reconnect': 'PASS'}))


asyncio.run(main())
