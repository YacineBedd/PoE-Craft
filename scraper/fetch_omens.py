import json, urllib.request, os, re, time

e = json.load(open('out/extras.json'))
D = 'icons/omens'
os.makedirs(D, exist_ok=True)
hdr = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
                     '(KHTML, like Gecko) Chrome/120 Safari/537.36'}
IMG = re.compile(r'https://cdn\.poe2db\.tw/image/[^"\']*Omens/[^"\']+\.webp')

def get(url, ref=None):
    h = dict(hdr)
    if ref: h['Referer'] = ref
    return urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=25).read()

def is_webp(b): return b[:4] == b'RIFF' and b[8:12] == b'WEBP'

todo = [o for o in e['omens']
        if not (os.path.exists(f"{D}/{o['code']}.webp") and os.path.getsize(f"{D}/{o['code']}.webp") > 0)]
print(f"fetching {len(todo)} omen icons via their pages", flush=True)
ok = fail = 0
for o in todo:
    code, name = o['code'], o['name']
    page = "https://poe2db.tw/us/" + name.replace(' ', '_')
    got = False
    for attempt in range(4):
        try:
            html = get(page).decode('utf-8', 'replace')
            m = IMG.search(html)
            if not m: raise ValueError("no image url on page")
            data = get(m.group(0), ref=page)
            if not is_webp(data): raise ValueError(f"not webp ({len(data)}b)")
            open(f"{D}/{code}.webp", 'wb').write(data); ok += 1; got = True
            print(f"  ok {code}  <- {m.group(0).split('/')[-1]}", flush=True)
            break
        except Exception as ex:
            if attempt == 3: print(f"  FAIL {code}: {ex}", flush=True); fail += 1
            else: time.sleep(3)
    time.sleep(2)
print(f"done. ok={ok} fail={fail} total_valid={len([f for f in os.listdir(D) if f.endswith('.webp')])}", flush=True)
