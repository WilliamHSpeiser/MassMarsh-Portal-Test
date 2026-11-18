#!/usr/bin/env python3
"""Local test server for the portal: static files with HTTP Range support (COG and tile-pack reads) and open CORS, no caching.
Usage: python scripts/local_server.py DIR PORT   e.g. the repo root on 8792 and /mnt/fastdata/planet_products on 8793; then open
http://localhost:8792/experimental/ and set window.MM_PLANET_BASE = "http://127.0.0.1:8793/" in the console before starting the Planet Viewer."""
import http.server, os, re, sys
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*'); self.send_header('Accept-Ranges', 'bytes'); self.send_header('Cache-Control', 'no-store'); super().end_headers()
    def do_GET(self):
        path = self.translate_path(self.path.split('?')[0]); rng = self.headers.get('Range')
        if rng and os.path.isfile(path):
            m = re.match(r'bytes=(\d+)-(\d*)', rng); size = os.path.getsize(path); a = int(m.group(1)); b = min(int(m.group(2)) if m.group(2) else size - 1, size - 1)
            self.send_response(206); self.send_header('Content-Type', self.guess_type(path)); self.send_header('Content-Range', f'bytes {a}-{b}/{size}'); self.send_header('Content-Length', str(b - a + 1)); self.end_headers()
            with open(path, 'rb') as f: f.seek(a); self.wfile.write(f.read(b - a + 1))
            return
        super().do_GET()
    def log_message(self, *a): pass
if __name__ == '__main__':
    os.chdir(sys.argv[1]); http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[2])), H).serve_forever()
