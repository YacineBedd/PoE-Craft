"""Page slug -> semantic class tags for the simulator schema."""
import re

BASE = [
    (r'^Body_Armours',   ['armour', 'body']),
    (r'^Helmets',        ['armour', 'helmet']),
    (r'^Gloves',         ['armour', 'gloves']),
    (r'^Boots',          ['armour', 'boots']),
    (r'^Shields',        ['armour', 'shield', 'offhand']),
    (r'^Bucklers',       ['armour', 'shield', 'offhand']),
    (r'^Foci',           ['offhand', 'caster']),
    (r'^Quivers',        ['offhand', 'ranged']),
    (r'^Rings',          ['jewellery', 'ring']),
    (r'^Amulets',        ['jewellery', 'amulet']),
    (r'^Belts',          ['jewellery', 'belt']),
    (r'^Charms',         ['charm']),
    (r'^Claws',          ['weapon', 'martial', 'onehand']),
    (r'^Daggers',        ['weapon', 'martial', 'onehand']),
    (r'^Wands',          ['weapon', 'caster', 'onehand']),
    (r'^Sceptres',       ['weapon', 'caster', 'onehand']),
    (r'^Staves',         ['weapon', 'caster', 'twohand']),
    (r'^Spears',         ['weapon', 'martial', 'onehand']),
    (r'^Flails',         ['weapon', 'martial', 'onehand']),
    (r'^One_Hand_',      ['weapon', 'martial', 'onehand']),
    (r'^Two_Hand_',      ['weapon', 'martial', 'twohand']),
    (r'^Quarterstaves',  ['weapon', 'martial', 'twohand']),
    (r'^Bows',           ['weapon', 'martial', 'twohand', 'ranged']),
    (r'^Crossbows',      ['weapon', 'martial', 'twohand', 'ranged']),
]

ATTR = {'str': 'str', 'dex': 'dex', 'int': 'int'}


def class_tags(slug):
    tags = []
    for pat, t in BASE:
        if re.match(pat, slug):
            tags = list(t)
            break
    m = re.search(r'_((?:str|dex|int)(?:_(?:str|dex|int))*)$', slug)
    if m:
        for a in m.group(1).split('_'):
            tags.append(ATTR[a])
    return tags


DEFENCE = {'energy_shield': 'es', 'armour': 'ar', 'evasion': 'ev'}


def req_defence(fossil_tags):
    """Map poe2db defence tags -> es/ar/ev gate."""
    hits = [DEFENCE[t] for t in fossil_tags if t in DEFENCE]
    return hits[0] if len(hits) == 1 else None
