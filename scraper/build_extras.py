"""Build essence / omen / abyss-bone datasets from cached poe2db pages + ModsView.js."""
import json, glob, re, collections, os
from lib import payload, plain, template_and_values, slug

OUT = os.environ.get('OUTDIR', 'out')
CUR = json.load(open(f'{OUT}/currencies2.json'))

pages = {}
for f in sorted(glob.glob('raw/*.html')):
    d, h = payload(f)
    if d:
        pages[f.split('/')[-1][:-5]] = d

AFFIX = {'1': 'prefix', '2': 'suffix'}
TIERWORD = [('Perfect ', 'perfect'), ('Greater ', 'greater'),
            ('Lesser ', 'lesser'), ('', 'normal')]


def ess_tier(name, is_perfect, pool):
    if name.startswith('Perfect ') or is_perfect in ('1', 1, True):
        return 'perfect'
    for pre, key in TIERWORD:
        if pre and name.startswith(pre):
            return key
    # the perfect_essence pool also carries the special corrupted essences
    # (Hysteria, Delirium, the Abyss) which carry no tier word at all
    return 'special' if pool == 'perfect_essence' else 'normal'


# ---------------------------------------------------------------- essences
# key: (essence name, affix, stat template) -> record
ess = {}
for cls, d in pages.items():
    for pool in ('essence', 'perfect_essence'):
        for m in d.get(pool) or []:
            if not m.get('str'):
                continue
            name = plain(m.get('Name', ''))
            if not name:
                continue
            tmpl, vals = template_and_values(plain(m['str']))
            gen = str(m.get('ModGenerationTypeID'))
            if gen not in AFFIX:
                continue
            key = (name, gen, tmpl)
            r = ess.setdefault(key, {
                'name': name,
                'tier': ess_tier(name, m.get('IsPerfect'), pool),
                'pool': pool,
                'affix': AFFIX[gen],
                'group': (m.get('ModFamilyList') or [slug(tmpl)])[0],
                'text': tmpl,
                'v': vals,
                'modLevel': int(m.get('Level') or 0),
                'reqLevel': int(m.get('reqlvl') or 0),
                'classes': set(),
            })
            r['classes'].add(cls)
            # keep the widest observed value range
            if len(vals) == len(r['v']):
                r['v'] = [[min(a[0], b[0]), max(a[1], b[1])] for a, b in zip(r['v'], vals)]

essences = []
for r in ess.values():
    r['classes'] = sorted(r['classes'])
    r['id'] = slug(r['name'] + '_' + r['text'])
    essences.append(r)

seen = collections.Counter()
for e in essences:
    seen[e['id']] += 1
    if seen[e['id']] > 1:
        e['id'] += f"~{seen[e['id']]}"

order = {'lesser': 0, 'normal': 1, 'greater': 2, 'perfect': 3, 'special': 4}
essences.sort(key=lambda e: (order.get(e['tier'], 9), e['name'], e['affix']))
print(f'essences: {len(essences)}  '
      f'({collections.Counter(e["tier"] for e in essences).most_common()})')

# ---------------------------------------------------------------- omens
GEN = {1: 'prefix', 2: 'suffix'}
omens = []
for k, v in CUR.items():
    if v.get('type') != 'Omen':
        continue
    code = (v.get('code') or '').split('/')[-1]
    omens.append({
        'id': k,
        'name': v['name'],
        'code': code,
        'forces': GEN.get(v.get('gentype_only')),
        'reqids': v.get('reqids') or [],
        'exclusives': v.get('exclusives') or [],
        # poe2db greys these out in its own calculator
        'poe2dbDisabled': v.get('class') == 'disabled',
    })
omens.sort(key=lambda o: (not o['forces'], o['name']))
print(f'omens: {len(omens)}  (with prefix/suffix forcing: '
      f'{sum(1 for o in omens if o["forces"])})')

# ---------------------------------------------------------------- abyss bones
# poe2db classIds -> our page-slug prefixes
CLASSMAP = {
    'Amulet': ['Amulets'], 'Ring': ['Rings'], 'Belt': ['Belts'],
    'Body Armour': ['Body_Armours'], 'Helmet': ['Helmets'], 'Gloves': ['Gloves'],
    'Boots': ['Boots'], 'Shield': ['Shields'], 'Buckler': ['Bucklers'],
    'Focus': ['Foci'], 'Quiver': ['Quivers'],
    'Claw': ['Claws'], 'Dagger': ['Daggers'], 'Wand': ['Wands'],
    'Sceptre': ['Sceptres'], 'Spear': ['Spears'], 'Flail': ['Flails'],
    'Bow': ['Bows'], 'Crossbow': ['Crossbows'], 'Warstaff': ['Quarterstaves'],
    'One Hand Sword': ['One_Hand_Swords'], 'One Hand Axe': ['One_Hand_Axes'],
    'One Hand Mace': ['One_Hand_Maces'], 'Two Hand Sword': ['Two_Hand_Swords'],
    'Two Hand Axe': ['Two_Hand_Axes'], 'Two Hand Mace': ['Two_Hand_Maces'],
    'Talisman': [], 'Staff': ['Staves'],
}
allslugs = sorted(pages)
bones = []
for k, v in CUR.items():
    if not re.search(r'collarbone|jawbone|rib$', k):
        continue
    prefixes = [p for cid in (v.get('beforeClassIds') or [])
                for p in CLASSMAP.get(cid, [])]
    classes = sorted({s for s in allslugs
                      if any(s == p or s.startswith(p + '_') for p in prefixes)})
    bones.append({
        'id': k, 'name': v['name'],
        'min': v.get('beforeMin_mod_lv') or 0,
        'max': v.get('beforeMax_mod_lv') or None,
        'pools': v.get('beforePools') or ['normal'],
        'rarity': v.get('beforeRarity') or ['Rare'],
        'classes': classes,
    })
bones.sort(key=lambda b: b['name'])
print(f'bones: {len(bones)}')
for b in bones:
    print(f"  {b['name']:22s} min={b['min']:<3} max={str(b['max']):<5} "
          f"{len(b['classes']):2d} classes  pools={b['pools']}")

json.dump({'essences': essences, 'omens': omens, 'bones': bones},
          open(f'{OUT}/extras.json', 'w'), indent=1)
print('wrote', f'{OUT}/extras.json')
