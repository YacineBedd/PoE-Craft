# PoE2 Crafting Bench

**▶ Try it live: https://yacinebedd.github.io/PoE-Craft/** — no install, runs in the browser.

A single-file, self-contained web app that models Path of Exile 2's crafting
system from **real poe2db data** — mod pools, spawn weights, tiers, currency
mechanics, omens, essences, abyssal bones, corruption and the Aldur runes.

Test a craft *before* you spend the currency: see the exact odds, simulate a
thousand attempts to price a plan, or actually roll one item by hand with real
RNG — all with the game's real numbers. It's free and open source.

It has three surfaces:

- **Bench** — pick a base + item level and see the live mod pool and exact
  next-affix odds for any currency, computed from the real spawn weights.
- **Craft graph** — a node-based plan editor (each node an item state, each edge
  a currency step) with a **Monte Carlo simulator** and closed-form cost model,
  plus plan comparison ranked by median.
- **Craft emulator** — one real item crafted roll-by-roll with real RNG: a legal
  currency rail, interactive reveal/essence pickers, undo, a running currency
  tally vs. the simulation, and a bridge that seeds an emulation from a
  simulated outcome or a saved snapshot.

---

## How to use it (for players)

Open **https://yacinebedd.github.io/PoE-Craft/** and pick a view from the tabs at
the top. Nothing to install, nothing to log in to — your work stays in your browser.

**1. Start with the base.** Choose an item class (e.g. *Body Armours*, *Bows*) and
a specific base, then set the item level. Everything below reacts to this — the
mod pool, tiers, and odds are exactly what that base can roll in game.

**2. Bench — "what can this roll, and what are my odds?"**
Pick a currency and the Bench shows the live mod pool and the **exact chance** of
each next affix, straight from the real spawn weights. Use it to answer "if I
Exalt this right now, how likely am I to hit the mod I want?" before you touch a
single orb.

**3. Craft graph — "which plan is cheapest?"**
Sketch a crafting plan as a flow: each node is an item state, each arrow is a
currency step (Transmute → Regal → Exalt, essences, omens, desecration, whatever).
Hit **Simulate** and it runs a **Monte Carlo of 1,000 attempts** to estimate how
much currency the plan really costs, and you can line up two plans side by side and
see which one wins on the median. Great for "is it cheaper to slam Exalts or go
essence + omen?" decisions.

**4. Craft emulator — "let me actually try it."**
This is the fun one: craft **one real item, roll by roll**, with real RNG. Click
currencies on the rail, watch mods land, use reveals/essences/omens, and undo if
you brick it. It keeps a running tally of what you've spent versus the simulation's
estimate — so you get the full dopamine of hitting a god-roll (or the pain of
bricking) without spending anything real. Hover any mod to see its full roll range,
and the good/bad-roll colour cue tells you at a glance how well each mod rolled.

Everything models the *real* mechanics — tiered Greater/Perfect orbs, omens that
force a side or homogenise, abyssal desecration and the Well of Souls reveal,
Vaal/Architect corruption, fracturing, socket-bound runes, the lot. If you can do
it in game, you can rehearse it here first.

---

There are now **two layouts** of the same app:

- **`web/` — standalone website (the way forward).** Real separate files:
  `index.html`, `styles.css`, `app.js` (an ES module), and `data/DATA.json`
  fetched at load. This is what to edit when building out the site; no build
  step, just refresh.
- **`src/artifact_template.html` + `dist/` — the single-file build (legacy).**
  One authored file that `build2.py` inlines into a self-contained
  `dist/index.html` for use as a Claude artifact. Kept working while the site is
  reworked; edits should migrate to `web/`.

---

## Quick start

**Standalone site (`web/`):**

```bash
cd web
python serve.py       # http://127.0.0.1:8788/index.html
```

Edit `web/index.html` / `web/styles.css` / `web/app.js` and just refresh. It
**must** be served over HTTP — opening `index.html` from `file://` fails because
the browser blocks ES-module + `fetch()` from the file origin.

**Single-file artifact build (`dist/`):**

```bash
python build2.py      # src/ + out/DATA.json -> dist/index.html
python serve.py       # serve dist/ on http://127.0.0.1:8777
```

`dist/index.html` is fully self-contained (all CSS, JS and data inlined, pure
ASCII, no external requests) — open from disk, host anywhere, or paste into a
Claude artifact.

Requires **Python 3** (standard library only) for the serve scripts and **Node**
only for the engine regression tests.

---

## Project layout

```
poe2-crafting-bench/
├── web/                      # STANDALONE SITE (separate files, edit these)
│   ├── index.html            #   full HTML document
│   ├── styles.css            #   all styles
│   ├── app.js                #   the engine, as an ES module (fetches data)
│   ├── data/DATA.json        #   mod/currency/base/… database, fetched at load
│   └── serve.py              #   static server for web/ (PORT env, default 8788)
├── build2.py                 # single-file build: src + out/DATA.json -> dist/index.html
├── serve.py                  # static server for dist/ (PORT env, default 8777)
├── out/
│   └── DATA.json             # inlined database build2.py reads (source for web/data too)
├── src/
│   └── artifact_template.html   # single-file app (legacy artifact source)
├── icons/                    # currency art (.webp)
├── dist/
│   └── index.html            # built, self-contained output (generated)
├── engine/                   # standalone models + regression suites (Node)
│   ├── strict_model.mjs      #   biased-random-walk cost model (removals undo progress)
│   ├── strict_test.mjs
│   ├── cost_model.mjs        #   closed-form expected-cost model
│   └── cost_test.mjs
└── scraper/                  # the poe2db extraction pipeline
    ├── lib.py                #   shared parsing (ModsView payload, templates, slugs)
    ├── extract.py            #   mods from ModsView payloads
    ├── bases.py              #   base items from item-class pages
    ├── build_extras.py       #   essences / omens / abyssal bones
    ├── classmap.py           #   page slug -> semantic class tags
    ├── modsview.js           #   poe2db ModsView.js (currency spec)
    ├── raw/                  #   cached poe2db HTML pages (input to the scrapers)
    └── out/                  #   datasets (build.py reads mods/bases/extras here)
```

### The data the build needs

`build.py` reads three files from `scraper/out/`:

| file          | what it holds                                             |
|---------------|-----------------------------------------------------------|
| `mods.json`   | normal / desecrated / corrupted mod pools, tiers, weights |
| `bases.json`  | base items per class, their properties and requirements   |
| `extras.json` | essences, omens, abyssal bones                            |

The other JSONs in `scraper/out/` (`currencies*.json`, `classes.json`,
`pools.json`) are intermediate scraper outputs kept for reference.

---

## Developing

1. Edit `src/artifact_template.html` — this is the whole app (markup, CSS, and
   the JavaScript engine, all in one file). The data placeholder is the literal
   token `/*__DATA__*/null`, which the build replaces with the inlined JSON.
2. `python build.py` to regenerate `dist/index.html`.
3. `python serve.py` (leave it running) and refresh the browser.

For rapid iteration you can also open `dist/index.html` directly.

### Engine tests

The cost/strict models are mirrored as standalone ES modules so they can be
tested without a browser:

```bash
cd engine
node strict_test.mjs      # biased-walk model vs. Monte Carlo
node cost_test.mjs        # closed-form model vs. Monte Carlo
```

> Note: `engine/*.mjs` are a **standalone mirror** of the models used for
> regression testing. The live models the app runs are inside
> `src/artifact_template.html`; if you change a model there, port the change to
> the matching `engine/*.mjs` to keep the tests meaningful.

---

## Re-scraping poe2db (optional)

The datasets are already built and checked in under `scraper/out/`. To refresh
them from the cached pages in `scraper/raw/` (or newly downloaded ones):

```bash
cd scraper
python extract.py            # inspect a ModsView payload
python build_extras.py       # -> out/extras.json  (needs out/currencies2.json)
```

`bases.py`, `classmap.py` and `lib.py` are helpers used by the extractors. The
scrapers read poe2db's inline `new ModsView({...})` payload and the item-class
card markup; `raw/` holds the cached HTML they parse. This pipeline is the
messiest part of the project — treat it as reference for how the data was
produced rather than a polished CLI.

---

## Engine rules modelled

A summary of the mechanics the engine implements, all from poe2db data (points
marked *assumption* are where poe2db publishes no number and a reasonable model
was chosen — the app flags these in its own notes):

- **Rarity & affix caps** — Normal 0, Magic 1 prefix + 1 suffix, Rare 3 + 3.
  Corrupted lines and fractured mods sit outside the budget.
- **Tiered currency** — Greater / Perfect orbs impose a minimum modifier level
  (poe2db `beforeMin_mod_lv`), cutting low tiers out of the pool.
- **Currencies** — Transmute / Augment / Regal / Exalt / Chaos (remove-one-then-
  add-one) / Annul / Divine (reroll values in-tier) / Vaal / Architect.
- **Vaal Orb** — four equally likely outcomes (*assumption*: even split): nothing,
  lose a mod, gain a corrupted line, reroll values; plus a `+1 socket` outcome on
  bases that have sockets. Corruption is final.
- **Architect's Orb** — used once on a corrupted item: 50% destroy, 50% a second
  corruption that writes **Twice Corrupted** and applies another outcome. That
  outcome can't repeat the first corruption's and is **never** "no change" (the
  cost is already the 50% destroy risk).
- **Abyssal bones** — add one **unrevealed desecrated** modifier. Tiers scale like
  Normal / Greater / Perfect: **Gnawed** (floor 0) / **Preserved** (35) /
  **Ancient** (50). Desecrated mods all sit at level 65, so the tier only thins
  the ordinary pool a reveal mixes in.
- **Revealing** — resolves one unrevealed modifier from 3 candidates. Un-omened
  it mixes the **desecrated + normal** pools (balanced to contribute equally —
  *assumption*); a lich omen (Sovereign / Liege / Blackblooded) confines it to one
  faction's desecrated set. **Omen of Abyssal Echoes**, armed before the reveal,
  grants exactly **one reroll** and is consumed on reveal either way. A reveal is
  one-shot; to retry, Annul the desecrated mod off (Omen of Light guarantees it)
  and desecrate again.
- **Fracturing** — locks one existing modifier at random (1/n to hit a specific
  one); a fractured mod is immune to removal/reroll. An unrevealed desecrated mod
  can't be fractured — which is why fracture-before-reveal is 1/3, not 1/4.
- **Essences** — grant a fixed modifier (max one crafted). Perfect essences
  replace a modifier on a full rare (same side if that side is full). Sinistral /
  Dextral Crystallisation force the side.
- **Omens** — force side / homogenise / lowest / desecrate / reroll / lich /
  essence-side effects, shown on the item before you commit the currency.
- **Whittling** — targets the **lowest-ilvl** modifier on the item (poe2db's
  internal "lowest level mod"); ties broken by worse tier.
- **Aldur runes** — +1 suffix and +1 crafted, one of each, gated by item sockets.
- **Sockets** — by item type, with exceptional-base +1 socket / +quality and the
  Vaal +1-socket outcome; Architect can't repeat the first corruption's outcome.

Two cost models back the graph: a **closed-form** expected-cost model and a
**strict biased-random-walk** model that accounts for removals undoing progress.
Both are validated against Monte Carlo (see `engine/`), and the in-app simulator
runs the very same `mcApply` the emulator does, so odds and outcomes never drift.

---

## Publishing as a Claude artifact

`dist/index.html` is exactly the kind of self-contained page a Claude artifact
wants: no external hosts, everything inlined, theme-aware, pure ASCII. Build it,
then paste or publish its contents.
