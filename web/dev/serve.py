# Serves web/ twice: the shop on http://127.0.0.1:8001, the Sitebound frame on http://localhost:8002.
# Different hosts make them cross-origin, as in production. Open http://127.0.0.1:8001/dev/shop.html
# Optional: serve.py <shopPort> <framePort> (shop.html still loads the button from localhost:8002).
import functools, http.server, os, sys, threading

WEB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

class NoStore(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

handler = functools.partial(NoStore, directory=WEB)
shop, frame = map(int, sys.argv[1:3]) if len(sys.argv) > 2 else (8001, 8002)
for host, port in (('127.0.0.1', shop), ('localhost', frame)):
    srv = http.server.ThreadingHTTPServer((host, port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
print(f'shop  http://127.0.0.1:{shop}/dev/shop.html\nframe http://localhost:{frame}/frame/', flush=True)
threading.Event().wait()
