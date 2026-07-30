#!/usr/bin/env python3
"""
Serve dist/ on http://127.0.0.1:8777 so you can open the built bench in a browser.

    python serve.py            # serves ./dist on :8777
    PORT=9000 python serve.py

Run `python build.py` first (or after any edit to src/artifact_template.html).
"""
import os, functools, http.server, socketserver

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dist')
PORT = int(os.environ.get('PORT', '8777'))

os.makedirs(ROOT, exist_ok=True)
Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', PORT), Handler) as httpd:
    print(f'serving {ROOT} on http://127.0.0.1:{PORT}/index.html', flush=True)
    httpd.serve_forever()
