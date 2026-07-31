#!/usr/bin/env python3
"""Download poe2db base-item / currency art and wire it into web/data/DATA.json.

    python download_art.py Amulets            # one class (proof)
    python download_art.py ALL                # every base class
    python download_art.py Amulets --hinekora # also fetch the Hinekora's Lock currency

Art URLs come from the cached poe2db pages in scraper/raw/. Each base is matched
to an image by normalising its name (lowercase, alphanumerics only) against the
image file's basename. Images save to web/img/bases/ ; DATA.json bases get an
`img` field. poe2db's CDN 403s without a browser Referer, so we send one.
"""
import json, os, re, sys, glob, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, 'web', 'data', 'DATA.json')
IMGDIR = os.path.join(ROOT, 'web', 'img')
HDRS = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://poe2db.tw/', 'Accept': 'image/webp,*/*'}
norm = lambda s: re.sub(r'[^a-z0-9]', '', s.lower())

def art_urls():
    """normalised-basename -> best art URL, from the cached HTML (prefer Basetypes)."""
    urls = set()
    for f in glob.glob(os.path.join(HERE, 'raw', '*.html')):
        urls |= set(re.findall(r'https?://cdn\.poe2db\.tw/image/[Aa]rt/2[Dd][Ii]tems/[^"\'\s]*\.webp',
                               open(f, encoding='utf-8', errors='ignore').read()))
    m = {}
    for u in urls:
        base = norm(os.path.splitext(u.rsplit('/', 1)[1])[0])
        # prefer a Basetypes art over a unique with the same normalised name
        if base not in m or ('/Basetypes/' in u and '/Basetypes/' not in m[base]):
            m[base] = u
    return m

def fetch(url, dest):
    if os.path.exists(dest):
        return 'cached'
    req = urllib.request.Request(url, headers=HDRS)
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    open(dest, 'wb').write(data)
    return len(data)

def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = [a for a in sys.argv[1:] if a.startswith('--')]
    db = json.load(open(DATA))
    amap = art_urls()
    classes = list(db['bases']) if (not args or args == ['ALL']) else args

    matched = missing = 0
    for cls in classes:
        node = db['bases'].get(cls)
        if not node or 'b' not in node:
            continue
        for b in node['b']:
            u = amap.get(norm(b['n']))
            if not u:
                missing += 1
                continue
            fn = u.rsplit('/', 1)[1]
            dest = os.path.join(IMGDIR, 'bases', fn)
            try:
                res = fetch(u, dest)
                b['img'] = 'img/bases/' + fn
                matched += 1
                if res != 'cached':
                    time.sleep(0.05)   # be polite to the CDN
            except urllib.error.HTTPError as e:
                print('  !', b['n'], e.code)
                missing += 1
    print(f'bases: matched {matched}, no-art {missing}')

    if '--hinekora' in flags:
        u = 'https://cdn.poe2db.tw/image/Art/2DItems/Currency/HinekorasLock.webp'
        fetch(u, os.path.join(IMGDIR, 'currency', 'HinekorasLock.webp'))
        db.setdefault('icons', {})['hinekora'] = 'img/currency/HinekorasLock.webp'
        print('hinekora currency icon: done')

    json.dump(db, open(DATA, 'w'), separators=(',', ':'))
    print('wrote', DATA)

if __name__ == '__main__':
    main()
