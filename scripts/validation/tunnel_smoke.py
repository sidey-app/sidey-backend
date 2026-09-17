#!/usr/bin/env python3
"""Non-production quick Tunnel HTTPS/WSS check with disposable fixture credentials."""
import asyncio
import json
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request
import websockets

origin = sys.argv[1].rstrip('/')
assert urllib.parse.urlparse(origin).hostname.endswith('.trycloudflare.com')
fixture = json.loads(Path(sys.argv[2]).read_text())[0]


async def main():
    request = urllib.request.Request(origin + '/api/rooms', headers={'Authorization': 'Bearer ' + fixture['token']})
    with urllib.request.urlopen(request, timeout=20) as response:
        assert response.status == 200 and fixture['room'] in response.read().decode()
    for path in ['/internal/deployment/status', '/actuator/prometheus']:
        try:
            urllib.request.urlopen(origin + path, timeout=20)
            raise AssertionError('Private route exposed')
        except urllib.error.HTTPError as error:
            assert error.code == 404
    async with websockets.connect(origin.replace('https://', 'wss://') + '/api/realtime', extra_headers={'Authorization': 'Bearer ' + fixture['token']}, ping_interval=None) as ws:
        assert json.loads(await asyncio.wait_for(ws.recv(), 20))['type'] == 'connected'
        await ws.send(json.dumps({'type': 'subscribe', 'roomId': fixture['room']}))
        assert json.loads(await asyncio.wait_for(ws.recv(), 20))['type'] == 'ack'
        await ws.send(json.dumps({'type': 'heartbeat'}))
        assert json.loads(await asyncio.wait_for(ws.recv(), 20))['type'] == 'heartbeat.ack'
    print(json.dumps({'https_rest': 'PASS', 'wss_subscribe_heartbeat': 'PASS', 'private_routes': '404', 'production_route': 'NOT USED'}))


asyncio.run(main())
