#!/usr/bin/env python3
"""
Compile the single-file PoE2 Crafting Bench.

Inlines the scraped datasets (mods / bases / extras) and the currency icons into
`src/artifact_template.html`, then writes a self-contained, pure-ASCII HTML file
to `dist/index.html`. The result has no external dependencies: open it directly,
serve it locally (see `serve.py`), or paste it into a Claude artifact.

    python build.py                 # -> dist/index.html
    DEST=/tmp/foo.html python build.py

Everything in this project is authored in `src/artifact_template.html`. This
script is only the packaging step; it does not contain app logic.
"""
import json, gzip, os, base64

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, 'scraper', 'out')     # datasets the scraper produces
ICONS = os.path.join(ROOT, 'icons')             # currency art, inlined as data URIs
TEMPLATE = os.path.join(ROOT, 'src', 'artifact_template.html')

ALL = json.load(open(os.path.join(DATA, 'mods.json')))
b = json.load(open(os.path.join(DATA, 'bases.json')))
EX = json.load(open(os.path.join(DATA, 'extras.json')))


def compact(rows, prefix=''):
    """prefix namespaces ids: mod slugs collide across pools (a desecrated
    ChaosResistance slugs identically to the normal one)."""
    out = []
    for x in rows:
        # poe2db publishes no spawn weight for the desecrated / corrupted pools.
        # Flag them and roll uniformly rather than dropping them for weight 0.
        unweighted = all(not t.get('weight') for t in x['tiers'])
        e = {'i': prefix + x['id'], 'n': x['name'], 'a': x['affix'][0], 'g': x['group'],
             'x': x['text'], 'c': x['itemClasses'],
             # crafting tags drive Homogenising omens, which restrict a roll to
             # modifiers sharing a tag with something already on the item
             'g2': x.get('tags') or [],
             't': [[t['t'], t['ilvl'], t['v'], (t['weight'] or (1 if unweighted else 0))] +
                   ([t['name']] if t.get('name') else []) for t in x['tiers']]}
        if unweighted:
            e['u'] = 1
        if x.get('reqDefence'):
            e['d'] = x['reqDefence']
        ov = {str(t['t']): t['weightByClass'] for t in x['tiers'] if t.get('weightByClass')}
        if ov:
            e['w'] = ov
        out.append(e)
    return out


cm = compact(ALL['normal'])
# desecrated mods are what Abyss bone currency pulls in; corrupted are Vaal outcomes
des = compact([x for x in ALL['desecrated'] if x['affix'] in ('prefix', 'suffix')], 'des:')
cor = compact(ALL['corrupted'], 'cor:')
for e in cor:
    e['a'] = 'c'          # corrupted implicits occupy no prefix/suffix slot

nw = sum(1 for e in cm if e.get('u'))
print(f'normal {len(cm)} ({nw} unweighted)  desecrated {len(des)}  corrupted {len(cor)}')

DEF = {'Energy Shield': 'es', 'Armour': 'ar', 'Evasion': 'ev', 'Evasion Rating': 'ev'}
cb = {}
for k, v in b.items():
    rows = []
    for r in v['bases']:
        props = r.get('properties', {})
        d = sorted({DEF[p] for p in props if p in DEF})
        rows.append({'n': r['name'], 'r': r.get('requires', {}), 'p': props, 'd': d})
    cb[k] = {'ct': v['classTags'], 'ic': v['itemClass'], 'b': rows}

ess = [{'i': e['id'], 'n': e['name'], 'ti': e['tier'], 'a': e['affix'][0],
        'g': e['group'], 'x': e['text'], 'v': e['v'],
        'ml': e['modLevel'], 'rl': e['reqLevel'], 'c': e['classes'],
        'p': e['pool']} for e in EX['essences']]
om = [{'i': o['id'], 'n': o['name'], 'f': o['forces'], 'r': o['reqids'],
       'c': o['code'], 'x': o['exclusives'], 'd': o['poe2dbDisabled']}
      for o in EX['omens']]

# Currency art, inlined as data URIs - the artifact CSP blocks external hosts.
# Greater/Perfect variants share their base orb's art on poe2db; the tier is
# carried by the roman numeral, so one icon per family is enough.
ICONMAP = {
    'transmute': 'CurrencyUpgradeToMagic', 'aug': 'CurrencyAddModToMagic',
    'regal': 'CurrencyUpgradeMagicToRare', 'exalted': 'CurrencyAddModToRare',
    'chaos': 'CurrencyRerollRare', 'annul': 'AnnullOrb',
    'alch': 'CurrencyUpgradeToRare', 'divine': 'CurrencyModValues',
    'vaal': 'CurrencyVaal', 'fracture': 'FracturingOrb',
    'gnawed-rib': 'GnawedRibs', 'ancient-rib': 'AncientRibs',
    'preserved-rib': 'PreservedRibs',
    'gnawed-jawbone': 'GnawedJawbone', 'ancient-jawbone': 'AncientJawbone',
    'preserved-jawbone': 'PreservedJawbone',
    'gnawed-collarbone': 'GnawedClavicle', 'ancient-collarbone': 'AncientClavicle',
    'preserved-collarbone': 'PreservedCalvicle',
}

icons, missing, raw = {}, [], 0
for key, fname in ICONMAP.items():
    path = os.path.join(ICONS, fname + '.webp')
    if not os.path.exists(path):
        missing.append(fname)
        continue
    blob = open(path, 'rb').read()
    raw += len(blob)
    icons[key] = 'data:image/webp;base64,' + base64.b64encode(blob).decode()
print(f'icons: {len(icons)} inlined ({raw//1024} KB raw)' +
      (f'  MISSING: {missing}' if missing else ''))

# Omen icons, keyed by their poe2db code (om:<Code>). Several omens share art
# (the "Voodoo" set); each file is inlined once per code.
OMENDIR = os.path.join(ICONS, 'omens')
nom = 0
if os.path.isdir(OMENDIR):
    for fn in sorted(os.listdir(OMENDIR)):
        if not fn.endswith('.webp'):
            continue
        blob = open(os.path.join(OMENDIR, fn), 'rb').read()
        if blob[:4] == b'RIFF' and blob[8:12] == b'WEBP':
            icons['om:' + fn[:-5]] = 'data:image/webp;base64,' + base64.b64encode(blob).decode()
            raw += len(blob); nom += 1
print(f'omen icons: {nom} inlined')

DATA_JSON = json.dumps({'mods': cm, 'des': des, 'cor': cor, 'bases': cb,
                        'ess': ess, 'omens': om, 'bones': EX['bones'], 'icons': icons},
                       separators=(',', ':'))
print('payload', len(DATA_JSON) // 1024, 'KB, gzip', len(gzip.compress(DATA_JSON.encode())) // 1024, 'KB')

HTML = open(TEMPLATE, encoding='utf-8').read()
out = HTML.replace('/*__DATA__*/null', DATA_JSON)

# The page is served without a charset declaration we control, so emit pure ASCII:
# \uXXXX escapes inside <script>, numeric character references in markup.
i = out.index('<script>')
head, tail = out[:i], out[i:]
head = ''.join(c if ord(c) < 128 else f'&#x{ord(c):x};' for c in head)
tail = ''.join(c if ord(c) < 128 else f'\\u{ord(c):04x}' for c in tail)
out = head + tail
assert all(ord(c) < 128 for c in out), 'non-ASCII survived'

dest = os.environ.get('DEST', os.path.join(ROOT, 'dist', 'index.html'))
os.makedirs(os.path.dirname(dest), exist_ok=True)
open(dest, 'w', encoding='ascii').write(out)
print('wrote', dest, len(out) // 1024, 'KB (pure ASCII)')
