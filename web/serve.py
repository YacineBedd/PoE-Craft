#!/usr/bin/env python3
"""
Serve the standalone site in this folder.

    python serve.py            # serves ./ on http://127.0.0.1:8788
    PORT=9000 python serve.py

Unlike the single-file dist/ build, this version loads data/DATA.json with
fetch() and app.js as an ES module, so it MUST be served over HTTP -
opening index.html from file:// will not work (the browser blocks module +
fetch from the file: origin).
"""
import os, functools, http.server, socketserver

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get('PORT', '8788'))

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', PORT), Handler) as httpd:
    print(f'serving {ROOT} on http://127.0.0.1:{PORT}/index.html', flush=True)
    httpd.serve_forever()
