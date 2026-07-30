import re, json, os, html as _html

NDASH = '—'

def payload(path):
    h = open(path, encoding='utf-8', errors='replace').read()
    i = h.find('new ModsView(')
    if i < 0:
        return None, h
    j = i + len('new ModsView(')
    depth = 0; k = j; instr = False; esc = False
    while k < len(h):
        c = h[k]
        if instr:
            if esc: esc = False
            elif c == '\\': esc = True
            elif c == '"': instr = False
        else:
            if c == '"': instr = True
            elif c == '{': depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    return json.loads(h[j:k + 1]), h
        k += 1
    return None, h

TAGSPAN = re.compile(r'<[^>]+>')
BR = re.compile(r'<br\s*/?>', re.I)

def plain(s):
    """Flatten poe2db mod HTML. <br> separates the stat lines of a hybrid mod,
    so preserve it as \\n rather than letting the tag strip concatenate them."""
    s = s.replace(NDASH, '-')
    s = BR.sub('\n', s)
    s = TAGSPAN.sub('', s)
    s = _html.unescape(s)
    lines = [re.sub(r'[ \t]+', ' ', ln).strip() for ln in s.split('\n')]
    return '\n'.join(ln for ln in lines if ln)

RANGE = re.compile(r'\((-?[\d.]+)\s*-\s*(-?[\d.]+)\)')
NUM = re.compile(r'(?<![\w.])(-?\d+(?:\.\d+)?)(?![\w.])')

def num(s):
    f = float(s)
    return int(f) if f == int(f) else f

def template_and_values(text):
    """'+(81-90) to maximum Energy Shield' -> ('+{0} to maximum Energy Shield', [[81,90]])"""
    vals = []
    def rep(m):
        vals.append([num(m.group(1)), num(m.group(2))])
        return '\x00%d\x00' % (len(vals) - 1)
    t = RANGE.sub(rep, text)
    if not vals:
        def rep2(m):
            v = num(m.group(1)); vals.append([v, v])
            return '\x00%d\x00' % (len(vals) - 1)
        t = NUM.sub(rep2, t)
    for i in range(len(vals)):
        t = t.replace('\x00%d\x00' % i, '{%d}' % i)
    return t, vals

def slug(s):
    s = re.sub(r'\{\d+\}', '#', s).lower()
    s = re.sub(r'[^a-z0-9#]+', '_', s).strip('_')
    return re.sub(r'_+', '_', s)[:60]
