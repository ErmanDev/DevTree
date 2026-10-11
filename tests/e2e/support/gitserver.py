"""Smart-HTTP git server with Basic auth, used by the network tests.

usage: python gitserver.py <project_root>
Listens on a free port on 127.0.0.1 and prints "PORT <n>". The only valid login is
alice / s3cret. While <project_root>/SLOW exists, every request first sleeps for the number
of seconds it contains (to test progress and cancel).
"""
import base64
import os
import subprocess
import sys
import time
from wsgiref.simple_server import WSGIRequestHandler, make_server

ROOT = sys.argv[1]
GOOD = "Basic " + base64.b64encode(b"alice:s3cret").decode()


def app(env, start):
    slow = os.path.join(ROOT, "SLOW")
    if os.path.exists(slow):
        # Read and close before sleeping: Windows can't delete a file that is open.
        with open(slow) as f:
            delay = float(f.read().strip() or 5)
        time.sleep(delay)
    if env.get("HTTP_AUTHORIZATION") != GOOD:
        start("401 Unauthorized", [("WWW-Authenticate", 'Basic realm="test"'), ("Content-Type", "text/plain")])
        return [b"auth required\n"]
    length = int(env.get("CONTENT_LENGTH") or 0)
    body = env["wsgi.input"].read(length) if length else b""
    cgi = dict(os.environ)  # keeps PATH / SYSTEMROOT, which git needs on Windows
    cgi.update({
        "GIT_PROJECT_ROOT": ROOT,
        "GIT_HTTP_EXPORT_ALL": "1",
        "REMOTE_USER": "alice",
        "PATH_INFO": env.get("PATH_INFO", ""),
        "REQUEST_METHOD": env["REQUEST_METHOD"],
        "QUERY_STRING": env.get("QUERY_STRING", ""),
        "CONTENT_TYPE": env.get("CONTENT_TYPE", ""),
        "CONTENT_LENGTH": str(len(body)),
        "GIT_PROTOCOL": env.get("HTTP_GIT_PROTOCOL", ""),
    })
    if env.get("HTTP_CONTENT_ENCODING"):
        cgi["HTTP_CONTENT_ENCODING"] = env["HTTP_CONTENT_ENCODING"]
    out = subprocess.run(["git", "http-backend"], input=body, env=cgi, capture_output=True).stdout
    head, _, rest = out.partition(b"\r\n\r\n")
    status, headers = "200 OK", []
    for line in head.decode().split("\r\n"):
        key, _, value = line.partition(":")
        if key.lower() == "status":
            status = value.strip()
        elif key:
            headers.append((key, value.strip()))
    start(status, headers)
    return [rest]


class Quiet(WSGIRequestHandler):
    def log_message(self, *args):
        pass


server = make_server("127.0.0.1", 0, app, handler_class=Quiet)
print(f"PORT {server.server_port}", flush=True)
server.serve_forever()
