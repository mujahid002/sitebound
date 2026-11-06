import http.server, threading, os, sys
D=os.path.dirname(os.path.abspath(__file__)); LOG=os.path.join(D,'log.jsonl')
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(s,*a,**k): super().__init__(*a,directory=D,**k)
    def do_POST(s):
        n=int(s.headers.get('Content-Length',0)); b=s.rfile.read(n).decode()
        open(LOG,'a').write(b+'\n'); s.send_response(204); s.end_headers()
for host,port in (('127.0.0.1',8001),('localhost',8002)):
    srv=http.server.ThreadingHTTPServer((host,port),H); threading.Thread(target=srv.serve_forever,daemon=True).start()
print('up',flush=True); threading.Event().wait()
