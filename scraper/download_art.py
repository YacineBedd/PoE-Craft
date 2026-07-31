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
import json, os, re, sys, glob, time, html, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, 'web', 'data', 'DATA.json')
IMGDIR = os.path.join(ROOT, 'web', 'img')
HDRS = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://poe2db.tw/', 'Accept': 'image/webp,*/*'}
norm = lambda s: re.sub(r'[^a-z0-9]', '', s.lower())

COL = re.compile(r'<div class="col">')
ANCHOR = re.compile(r'<a class="whiteitem[^"]*"[^>]*>([^<]{1,60})</a>')
BASETYPES = re.compile(r'https?://cdn\.poe2db\.tw/image/[Aa]rt/2[Dd][Ii]tems/[^"\'\s]*?/Basetypes/[^"\'\s]+\.webp')
# some classes (spears, shields, flails, crossbows, quarterstaves, bucklers) store
# base art directly under the class folder, not a Basetypes/ subfolder.
DIRECTART = re.compile(r'https?://cdn\.poe2db\.tw/image/[Aa]rt/2[Dd][Ii]tems/(?:Weapons|Offhand|Armours|Amulets|Rings|Belts|Charms|Quivers|Jewels)/[^"\'\s]+\.webp')

def block_img(blk):
    m = BASETYPES.search(blk)
    if m:
        return m.group(0)
    for m in DIRECTART.finditer(blk):
        u = m.group(0)
        if 'Uniques' not in u and 'minimap' not in u.lower() and '/maps/' not in u.lower():
            return u
    return None

def art_urls():
    """normalised base display-name -> art URL, by pairing each base card's
    <a class="whiteitem">Name</a> with its item image in the same col block.
    Armour/weapon art uses internal names (BodyStr01.webp / 1HSpear01.webp), so
    the name and image must be read together from the row."""
    m = {}
    for f in glob.glob(os.path.join(HERE, 'raw', '*.html')):
        h = open(f, encoding='utf-8', errors='ignore').read()
        starts = [c.start() for c in COL.finditer(h)]
        for i, s in enumerate(starts):
            e = starts[i + 1] if i + 1 < len(starts) else min(len(h), s + 8000)
            blk = h[s:e]
            a, u = ANCHOR.search(blk), block_img(blk)
            if a and u:
                m.setdefault(norm(html.unescape(a.group(1)).strip()), u)
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

UNIQUE = re.compile(r'https?://cdn\.poe2db\.tw/image/[Aa]rt/2[Dd][Ii]tems/[^"\'\s]*Uniques/[^"\'\s]+\.webp')
ANYART = re.compile(r'https?://cdn\.poe2db\.tw/image/[Aa]rt/2[Dd][Ii]tems/[^"\'\s]+\.webp')

def class_icons(db):
    """A fallback icon per class, for bases that have no art of their own: a
    sibling base's art when the class has any, else a representative unique from
    the class page (so art-less classes like Spears still show something)."""
    made = borrowed = 0
    for cls, node in db['bases'].items():
        bs = node.get('b', [])
        art = next((b['img'] for b in bs if b.get('img')), None)
        if art:
            node['classimg'] = art; borrowed += 1; continue
        f = os.path.join(HERE, 'raw', cls + '.html')
        if not os.path.exists(f):
            continue
        h = open(f, encoding='utf-8', errors='ignore').read()
        m = UNIQUE.search(h) or ANYART.search(h)
        if not m:
            continue
        u = m.group(0); fn = u.rsplit('/', 1)[1]
        try:
            fetch(u, os.path.join(IMGDIR, 'class', fn))
            node['classimg'] = 'img/class/' + fn; made += 1
        except urllib.error.HTTPError as e:
            print('  ! class icon', cls, e.code)
    print(f'class icons: {borrowed} reuse a base art, {made} downloaded a representative')

def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = [a for a in sys.argv[1:] if a.startswith('--')]
    db = json.load(open(DATA))
    if '--classicons' in flags and not args:      # standalone: just (re)build class icons
        class_icons(db)
        json.dump(db, open(DATA, 'w'), separators=(',', ':'))
        print('wrote', DATA); return
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
