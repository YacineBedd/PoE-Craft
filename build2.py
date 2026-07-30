#!/usr/bin/env python3
"""
Build the single-file bench from source + data.

    python build2.py                 # -> dist/index.html
    DEST=/tmp/foo.html python build2.py

Reads  src/artifact_template.html  (has a `/*__DATA__*/null` placeholder)
       out/DATA.json               (the inlined mod/currency database)
Writes dist/index.html            (self-contained, ASCII-only)

Paths are anchored to this file's directory, so it runs from any cwd.
Then `python serve.py` serves dist/ on http://127.0.0.1:8777/index.html
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'src', 'artifact_template.html')
DATA_JSON = os.path.join(HERE, 'out', 'DATA.json')
DEST = os.environ.get('DEST', os.path.join(HERE, 'dist', 'index.html'))

DATA = json.dumps(json.load(open(DATA_JSON)), separators=(',', ':'))
HTML = open(SRC, encoding='utf-8').read()
out = HTML.replace('/*__DATA__*/null', DATA)

# escape non-ASCII: HTML head as numeric char refs, <script> tail as \uXXXX
i = out.index('<script>')
head, tail = out[:i], out[i:]
head = ''.join(c if ord(c) < 128 else f'&#x{ord(c):x};' for c in head)
tail = ''.join(c if ord(c) < 128 else f'\\u{ord(c):04x}' for c in tail)
out = head + tail
assert all(ord(c) < 128 for c in out), 'non-ASCII survived'

os.makedirs(os.path.dirname(DEST), exist_ok=True)
open(DEST, 'w', encoding='ascii').write(out)
print('wrote', DEST, len(out) // 1024, 'KB')
