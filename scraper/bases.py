"""Parse base-item cards out of poe2db item-class pages."""
import re
from lib import plain, template_and_values

COL = re.compile(r'<div class="col">')
ANCHOR = re.compile(r'<a class="whiteitem [^"]*"[^>]*?href="([^"]+)"[^>]*>([^<]{1,60})</a>')
META = re.compile(r'data-hover="\?s=Data%5CBaseItemTypes%2F([^"&]+)"')
DIVC = re.compile(r'<div class="(property|requirements|implicitMod)">(.*?)</div>\s*(?=<div|</div)', re.S)

NUMPROP = re.compile(r'^([A-Za-z ][A-Za-z /]*?):\s*(.+)$')


def block_end(h, start):
    """Find end of one card block by scanning to the next col div or section end."""
    nxt = h.find('<div class="col">', start + 1)
    return nxt if nxt > 0 else min(len(h), start + 6000)


def parse_props(seg):
    props, reqs, implicits = {}, {}, []
    for kind, body in DIVC.findall(seg):
        txt = plain(body)
        if not txt:
            continue
        if kind == 'implicitMod':
            t, v = template_and_values(txt)
            implicits.append({'text': t, 'v': v})
        elif kind == 'requirements':
            # "Requires: Level 5, 11 Int"  /  "Requires: Level 12"
            lvl = re.search(r'Level\s+(\d+)', txt)
            if lvl:
                reqs['level'] = int(lvl.group(1))
            for n, a in re.findall(r'(\d+)\s*(Str|Dex|Int)', txt):
                reqs[a.lower()] = int(n)
        else:
            m = NUMPROP.match(txt)
            if m:
                k, v = m.group(1).strip(), m.group(2).strip()
                rng = re.match(r'^(-?[\d.]+)\s*-\s*(-?[\d.]+)$', v)
                if rng:
                    props[k] = [float(rng.group(1)), float(rng.group(2))]
                else:
                    num = re.match(r'^(-?[\d.]+)%?$', v)
                    props[k] = float(num.group(1)) if num else v
            elif ':' in txt:
                k, _, v = txt.partition(':')
                props[k.strip()] = v.strip()
    return props, reqs, implicits


def parse_bases(h, tab_id):
    i = h.find(f'id="{tab_id}"')
    if i < 0:
        return []
    # limit to this tab-pane; skip past this pane's own class attribute
    after = h.find('>', i) + 1
    end = h.find('class="tab-pane', after)
    seg = h[i:end if end > 0 else len(h)]

    out, seen = [], set()
    for m in COL.finditer(seg):
        blk = seg[m.start():block_end(seg, m.start())]
        a = ANCHOR.search(blk)
        if not a:
            continue
        href, name = a.group(1), plain(a.group(2))
        if not name or href in seen:
            continue
        seen.add(href)
        props, reqs, implicits = parse_props(blk)
        meta = META.search(blk)
        rec = {'name': name, 'href': href}
        if meta:
            rec['metadata'] = meta.group(1).replace('%2F', '/').replace('%5C', '/')
        if reqs:
            rec['requires'] = reqs
        if props:
            rec['properties'] = props
        if implicits:
            rec['implicits'] = implicits
        out.append(rec)
    return out
