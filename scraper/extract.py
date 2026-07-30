import re, json, sys

def payload(path):
    h = open(path, encoding='utf-8', errors='replace').read()
    i = h.index('new ModsView(')
    j = i + len('new ModsView(')
    # brace matching, string aware
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
                if depth == 0: return json.loads(h[j:k+1])
        k += 1
    raise ValueError('unbalanced')

d = payload(sys.argv[1])
print('TOP KEYS:', list(d.keys()))
for k, v in d.items():
    t = type(v).__name__
    n = len(v) if hasattr(v, '__len__') else ''
    print(f'  {k}: {t}[{n}]')

print('\n=== normal[0] ==='); print(json.dumps(d['normal'][0], indent=1)[:2500])
print('\n=== normal[60] ==='); print(json.dumps(d['normal'][60], indent=1)[:1800])
print('\n=== essence[0] ==='); print(json.dumps(d['essence'][0], indent=1)[:1200])
print('\n=== baseitem ==='); print(json.dumps(d['baseitem'], indent=1)[:800])
