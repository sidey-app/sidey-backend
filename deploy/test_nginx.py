"""Real task-local Nginx syntax, REST and WebSocket forwarding checks."""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request


class Backend(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.path == "/api/realtime":
            assert self.headers["Authorization"] == "Bearer fixture-token"
            key = self.headers["Sec-WebSocket-Key"]
            accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            body = b'{"type":"connected"}'
            self.wfile.write(bytes([0x81, len(body)]) + body)
            self.wfile.flush()
        else:
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")

    def log_message(self, *_):
        pass


def main():
    nginx = str(Path(sys.argv[1]).resolve())
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with tempfile.TemporaryDirectory(prefix="sidey-nginx-") as directory:
        root = Path(directory)
        backend = ThreadingHTTPServer(("127.0.0.1", 0), Backend)
        worker = threading.Thread(target=backend.serve_forever, daemon=True)
        worker.start()
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        upstream = root / "upstream.conf"
        upstream.write_text(f"server 127.0.0.1:{backend.server_port};\n")
        config = (Path(__file__).parent / "nginx/sidey.conf").read_text()
        config = config.replace("/etc/nginx/sidey-active-upstream.conf", str(upstream))
        config = config.replace("127.0.0.1:8088", f"127.0.0.1:{port}")
        config = config.replace("/var/log/nginx/", str(root) + "/")
        (root / "nginx.conf").write_text(f"pid {root}/nginx.pid;\nerror_log {root}/master.log;\nevents {{worker_connections 1024;}}\nhttp {{\n{config}\n}}\n")
        command = [nginx, "-p", str(root) + "/", "-c", str(root / "nginx.conf")]
        subprocess.run([*command, "-t"], check=True, capture_output=True)
        process = subprocess.Popen([*command, "-g", "daemon off;"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            for _ in range(50):
                try:
                    with opener.open(f"http://127.0.0.1:{port}/api/profile?token=query-canary", timeout=1) as response:
                        assert response.read() == b"ok"
                    break
                except OSError:
                    time.sleep(0.1)
            else:
                raise AssertionError("Nginx did not become ready")
            for path in ["/internal/deployment/activate", "/internal/commerce/refund", "/actuator/prometheus"]:
                try:
                    opener.open(f"http://127.0.0.1:{port}{path}", timeout=2)
                    raise AssertionError("Private operation exposed")
                except urllib.error.HTTPError as error:
                    assert error.code == 404
            with socket.create_connection(("127.0.0.1", port), timeout=3) as client:
                client.sendall(("GET /api/realtime HTTP/1.1\r\nHost: api.sidey.app\r\nUpgrade: websocket\r\n"
                                "Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
                                "Sec-WebSocket-Version: 13\r\nAuthorization: Bearer fixture-token\r\n\r\n").encode())
                received = b""
                while b'{"type":"connected"}' not in received:
                    chunk = client.recv(4096)
                    assert chunk
                    received += chunk
                assert b"101 Switching Protocols" in received
            time.sleep(0.1)
            log = (root / "sidey-access.log").read_text()
            assert "query-canary" not in log and "fixture-token" not in log
            print("Nginx syntax, REST, private-route isolation, raw WebSocket and log checks passed")
        finally:
            process.terminate()
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=5)
            backend.shutdown()
            backend.server_close()


if __name__ == "__main__":
    main()
