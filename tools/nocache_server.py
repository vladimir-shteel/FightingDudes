"""Static file server that disables caching. For the dev/preview loop only.

Usage: python tools/nocache_server.py [port]  (default 8771)
Serves the repo root so ES modules and data JSON always reload fresh.
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8771
    server = ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler)
    server.daemon_threads = True
    server.serve_forever()
