// Cloud layer (accounts, save/sync/share). The app runs fully without these;
// they are additive — see the integration block at the end of this file.
import * as auth from './js/auth.js';
import * as sync from './js/sync.js';
import * as router from './js/router.js';

// The mod / currency / base database is served as static JSON and fetched
// at load. This file is an ES module, so the top-level await below finishes
// before any of the derived constants run - they still initialise
// synchronously, exactly as they did when the data was inlined.
const DB = await fetch(new URL('./data/DATA.json', import.meta.url))
  .then(r => { if (!r.ok) throw new Error('DATA.json ' + r.status); return r.json(); });
const MODS = DB.mods, BASES = DB.bases, DES = DB.des, COR = DB.cor,
      ESS = DB.ess, OMENS = DB.omens, BONES = DB.bones, ICONS = DB.icons || {};

/* Socket-bound Augment runes: each is permanent once socketed and unlocks a
   modifier family on a specific base (Uhtred -> Chronomancy on Boots, etc.).
   Loaded from a companion JSON and reshaped into MODS-form so the family mods
   roll through the same pool machinery once the rune is in. Value ranges are
   partial for now (poe2db shows some inline); a mod with no range rolls a
   placeholder that renders as "#" until the range is filled in. */
const SBDATA = await fetch(new URL('./data/sbrunes.json', import.meta.url))
  .then(r => r.ok ? r.json() : { runes: [] }).catch(() => ({ runes: [] }));
const SB_FITS = {
  Boots: s => /^Boots/.test(s), Gloves: s => /^Gloves/.test(s),
  Helmets: s => /^Helmets/.test(s), 'Body Armours': s => /^Body_Armours/.test(s),
  Weapon: s => /^(Spears|Bows|Crossbows|Daggers|Claws|Flails|Quarterstaves|One_Hand_(Axes|Maces|Swords)|Two_Hand_(Axes|Maces|Swords))$/.test(s),
};
const sbName = x => String(x).replace(/\{\d+\}/g, '#').split('\n').join(', ');
const SBRUNES = (SBDATA.runes || []).map(r => ({ ...r, fits: SB_FITS[r.base] || (() => false),
  iconUrl: r.icon ? 'https://cdn.poe2db.tw/image/' + r.icon + '.webp' : '' }));
const SBRUNE_BY_ID = Object.fromEntries(SBRUNES.map(r => [r.id, r]));
const SBMODS = {};          // family -> [mod in MODS shape]
const SBMODS_ALL = [];
for (const r of SBRUNES) {
  SBMODS[r.family] = r.mods.map((m, i) => {
    const mod = { i: 'sb_' + r.id + '_' + i, g: 'sb_' + r.id + '_' + i, a: m.a,
      n: sbName(m.x), x: m.x, c: null, g2: m.tags || [], fam: r.family, rune: r.id,
      tbd: !m.vr, t: [[1, m.ml || 1, m.vr || null, 100, '']] };
    SBMODS_ALL.push(mod); return mod;
  });
}
/* which runes lock their socket forever once placed (all socket-bound augments,
   incl. the two Aldur cap-runes — Serle's Triumph is the +1-suffix one) */
const isBoundRune = id => !!SBRUNE_BY_ID[id] || id === 'aldur-suffix' || id === 'aldur-crafted';

/* Abyssal bones come in three tiers that scale exactly like Normal / Greater /
   Perfect currency: a higher tier imposes a higher minimum modifier level, which
   trims the low tiers out of the normal pool a reveal can surface. Gnawed is the
   base tier, Preserved the Greater, Ancient the Perfect. Every desecrated
   modifier sits at level 65, so it survives all three floors; the tier only
   thins the ordinary modifiers an un-omened reveal mixes in. Floors mirror the
   Regal/Exalted line (Greater 35, Perfect 50) so a desecrated mod is never cut. */
const BONETIER = { gnawed: { min: 0, word: 'base', tier: 'I' },
                   preserved: { min: 35, word: 'Greater', tier: 'II' },
                   ancient: { min: 50, word: 'Perfect', tier: 'III' } };
const boneTierOf = b => BONETIER[String(b && b.id || '').split('-')[0]] || BONETIER.gnawed;
BONES.forEach(b => { b.min = boneTierOf(b).min; b.max = null; });

const POOLS = {
  normal:     { label: 'Normal',     src: MODS, weighted: true },
  desecrated: { label: 'Desecrated', src: DES,  weighted: false },
  corrupted:  { label: 'Corrupted',  src: COR,  weighted: false },
};

const LIMITS = { normal:{p:0,s:0,total:0}, magic:{p:1,s:1,total:2}, rare:{p:3,s:3,total:6} };

/**
 * Aldur-league runes are socketed on the item and lift crafting caps. Only Rare
 * crafting is affected: a +1 prefix rune lets a Rare hold four prefixes, a +1
 * desecrated rune lets it hold two desecrated modifiers, and so on. Magic and
 * Normal limits are fixed by rarity and never move.
 */
let runes = { suffix: 0, crafted: 0 };   // the two Aldur cap-runes, one of each max
function LIM(rarity) {
  if (rarity !== 'rare') return LIMITS[rarity] || LIMITS.normal;
  // only a +1 suffix cap-rune exists, and the cap-runes do not stack, so the
  // most an item reaches is seven modifiers: 3 prefixes and 4 suffixes
  return { p: 3, s: 3 + runes.suffix, total: 6 + runes.suffix };
}
const effLimit = k => LIM('rare')[k];
const runeSockets = () => baseSockets(state.slug) + (state.exceptional === 'socket' ? 1 : 0);
const maxDesecrated = () => 1;            // no rune lifts this cap
const maxCrafted = () => 1 + runes.crafted;
const countCat = (aff, cat) => aff.filter(a => a.cat === cat).length;

/**
 * Socket count by item type. Runes and Soul Cores go in these. Body armour and
 * two-handed weapons hold two, one-handers and the smaller armour pieces hold
 * one, and jewellery and charms hold none. Corruption and exceptional bases can
 * push one over this maximum.
 */
function baseSockets(slug) {
  const ct = (BASES[slug] && BASES[slug].ct) || [];
  if (ct.includes('body')) return 2;
  if (ct.includes('weapon')) return ct.includes('twohand') ? 2 : 1;
  if (ct.includes('helmet') || ct.includes('gloves') || ct.includes('boots')) return 1;
  if (ct.includes('offhand') || ct.includes('shield')) return 1;
  return 0;                                   // jewellery, charms, jewels
}
// exceptional base (+1 socket) and corruption both add over the type maximum
function itemExc(it) {
  // an item's own exceptional flag (set in the emulator) wins over the global toggle
  return (it && it.exc !== undefined) ? it.exc : (state.exceptional || '');
}
function maxSockets(it) {
  return baseSockets(state.slug) + (itemExc(it) === 'socket' ? 1 : 0) + ((it && it.socketBonus) || 0);
}
// quality cap: 20, or 28 on an exceptional +quality base
function qCap(it) { return 20 + (itemExc(it) === 'quality' ? 8 : 0); }

/* Socketable runes (poe2db /Runes), three tiers each. Armour stats are applied
   to the item totals; on weapons/casters the relevant line is shown but not
   summed (the totals panel only tracks defences/life/mana/res/attr/stun). The
   two Aldur runes carry no stats - they lift the Rare caps instead. */
const RUNES = (() => {
  const out = [], T = [['I', '', 0], ['II', 'Greater ', 30], ['III', 'Perfect ', 50]];
  const N = { iron: 'Iron Rune', body: 'Body Rune', mind: 'Mind Rune', desert: 'Desert Rune',
    glacial: 'Glacial Rune', storm: 'Storm Rune', stone: 'Stone Rune', rebirth: 'Rebirth Rune',
    inspiration: 'Inspiration Rune', vision: 'Vision Rune' };
  const A = {
    iron: t => ({ incDef: [16, 18, 20][t] }), body: t => ({ life: [45, 60, 75][t] }),
    mind: t => ({ mana: [30, 40, 50][t] }), desert: t => ({ fire: [14, 18, 22][t] }),
    glacial: t => ({ cold: [14, 18, 22][t] }), storm: t => ({ lightning: [14, 18, 22][t] }),
    stone: t => ({ stun: [75, 100, 125][t] }),
    rebirth: t => ({ other: `Regenerate ${[0.4, 0.45, 0.5][t]}% of maximum Life per second` }),
    inspiration: t => ({ other: `${[15, 18, 21][t]}% increased Mana Regeneration Rate` }),
    vision: t => ({ other: `${[12, 16, 20][t]}% increased Life and Mana Recovery from Flasks` }) };
  const W = { iron: t => `${[16, 18, 20][t]}% increased Physical Damage`,
    body: t => `Leeches ${[4, 5, 6][t]}% of Physical Damage as Life`,
    mind: t => `Leeches ${[3, 4, 5][t]}% of Physical Damage as Mana`,
    desert: () => 'Adds Fire Damage', glacial: () => 'Adds Cold Damage', storm: () => 'Adds Lightning Damage',
    stone: t => `${[30, 40, 50][t]}% increased Stun Buildup`, rebirth: () => 'Gain Life on kill',
    inspiration: () => 'Gain Mana on kill', vision: t => `+${[90, 120, 150][t]} to Accuracy Rating` };
  const C = { iron: t => `${[25, 30, 35][t]}% increased Spell Damage`,
    body: t => `+${[40, 50, 60][t]} to maximum Energy Shield`, mind: t => `+${[60, 75, 90][t]} to maximum Mana`,
    desert: t => `Gain ${[8, 10, 12][t]}% of Damage as Extra Fire Damage`,
    glacial: t => `Gain ${[8, 10, 12][t]}% of Damage as Extra Cold Damage`,
    storm: t => `Gain ${[8, 10, 12][t]}% of Damage as Extra Lightning Damage`,
    stone: () => 'Stun Threshold from Energy Shield', rebirth: t => `${[8, 10, 12][t]}% increased Energy Shield Recharge Rate`,
    inspiration: t => `${[25, 30, 35][t]}% increased Mana Regeneration Rate`,
    vision: t => `${[20, 24, 28][t]}% increased Critical Hit Chance for Spells` };
  // martial-weapon damage each rune adds, for the DPS panel (armour side stays in A)
  const WD = {
    iron:    t => ({ incPhys: [16, 18, 20][t] }),
    desert:  t => ({ fire: [[7, 11], [13, 16], [17, 20]][t] }),
    glacial: t => ({ cold: [[6, 10], [9, 15], [16, 20]][t] }),
    storm:   t => ({ lightning: [[1, 20], [1, 30], [1, 40]][t] }),
    vision:  t => ({ acc: [90, 120, 150][t] }),
  };
  for (const k in N) T.forEach(([tl, pre, req], ti) =>
    out.push({ i: k + '-' + ti, n: pre + N[k], fam: k, t: tl, req,
               a: A[k](ti), w: W[k](ti), c: C[k](ti), wd: WD[k] ? WD[k](ti) : null }));
  // attribute runes apply on every item type
  const AT = { robust: ['str', 'Robust'], adept: ['dex', 'Adept'], resolve: ['int', 'Resolve'] };
  for (const k in AT) T.forEach(([tl, pre, req], ti) => {
    const [stat, base] = AT[k];
    out.push({ i: k + '-' + ti, n: pre + base + ' Rune', fam: k, t: tl, req,
               a: { [stat]: [9, 12, 15][ti] }, all: true });
  });
  out.push({ i: 'aldur-suffix', n: 'Aldur Rune \u2014 +1 Suffix', fam: 'aldur', t: '', req: 0, special: 'suffix', a: {} });
  out.push({ i: 'aldur-crafted', n: 'Aldur Rune \u2014 +1 Crafted', fam: 'aldur', t: '', req: 0, special: 'crafted', a: {} });
  return out;
})();
const runeById = id => RUNES.find(r => r.i === id) || null;
function runeCat(slug) {
  const ct = (BASES[slug] && BASES[slug].ct) || [];
  if (ct.includes('caster')) return 'caster';
  if (ct.includes('martial') || ct.includes('weapon')) return 'martial';
  return 'armour';
}
/* The emulated item's sockets drive the Rare caps while the emulator is open:
   an Aldur suffix/crafted rune lifts the cap exactly as the header chips do. */
function syncEmRunes() {
  if (!em) return;
  em.sockets = (em.sockets || []).slice(0, maxSockets(em));
  runes.suffix = em.sockets.includes('aldur-suffix') ? 1 : 0;
  runes.crafted = em.sockets.includes('aldur-crafted') ? 1 : 0;
}
function syncHeaderRunes() {
  const q = k => { const b = document.querySelector('#runepick [data-rune=' + k + ']');
    return b && b.getAttribute('aria-pressed') === 'true' ? 1 : 0; };
  runes.suffix = q('suffix'); runes.crafted = q('crafted');
}
const RNAME  = { normal:'Normal', magic:'Magic', rare:'Rare' };

/* Greater / Perfect orbs impose a minimum modifier level, cutting low tiers out
   of the pool. Values are poe2db's beforeMin_mod_lv. */
const TIERS = {
  transmute: { I:0, II:44, III:70 },
  aug:       { I:0, II:44, III:70 },
  regal:     { I:0, II:35, III:50 },
  exalted:   { I:0, II:35, III:50 },
  chaos:     { I:0, II:35, III:50 },
};
const TIERWORD = { I:'', II:'Greater ', III:'Perfect ' };
const TIERLABEL = { I:'Normal', II:'Greater', III:'Perfect' };

/* poe2db currency ids per tier, so omen `reqids` can be matched */
const CURID = {
  transmute: { I:'transmute', II:'greater-orb-of-transmutation', III:'perfect-orb-of-transmutation' },
  aug:       { I:'aug', II:'greater-orb-of-augmentation', III:'perfect-orb-of-augmentation' },
  regal:     { I:'regal', II:'greater-regal-orb', III:'perfect-regal-orb' },
  exalted:   { I:'exalted', II:'greater-exalted-orb', III:'perfect-exalted-orb' },
  chaos:     { I:'chaos', II:'greater-chaos-orb', III:'perfect-chaos-orb' },
  alch:      { I:'alc' }, annul: { I:'annu' }, divine: { I:'divine' }, vaal: { I:'vaal-orb' },
};
const curId = c => (CURID[c.k] || {})[c.tiered ? ctier : 'I'] || c.k;

/* Omen behaviours we simulate. Anything not listed is shown but inert. */
const OMENFX = {
  OmenOnExaltAddPrefixes:'force', OmenOnExaltAddSuffixes:'force',
  OmenOnRegalPrefix:'force', OmenOnRegalSuffix:'force',
  OmenOnChaosPrefix:'force', OmenOnChaosSuffix:'force',
  OmenOnAnnulRemovePrefixes:'force', OmenOnAnnulRemoveSuffixes:'force',
  OmenOnAlchemyMaximumPrefixes:'force', OmenOnAlchemyMaximumSuffixes:'force',
  // Necromancy omens force the side an Abyssal bone writes its modifier on
  OmenOnAbyssAddPrefixes:'force', OmenOnAbyssAddSuffixes:'force',
  // Abyssal Echoes rerolls the reveal's options; Light narrows an Annulment
  // down to the desecrated modifier alone
  OmenOnAbyssRerollOptions:'reroll', OmenOnAnnulRemoveAbyssMod:'desec',
  // Sovereign / Liege / Blackblooded guarantee a bone pulls from one lich's set
  OmenOnAbyssGuarenteeLichTypeMod1:'lich', OmenOnAbyssGuarenteeLichTypeMod2:'lich',
  OmenOnAbyssGuarenteeLichTypeMod3:'lich',
  // Crystallisation restricts a perfect essence to one side of the item
  OmenOnPerfectEssencePrefix:'essside', OmenOnPerfectEssenceSuffix:'essside',
  OmenOnExaltAddTwoMods:'two', OmenOnAnnulRemoveTwoMods:'two',
  OmenOnChaosLowestLevelMod:'lowest',
  OmenOnExaltAddExistingModType:'homog', OmenOnRegalAddExistingModType:'homog',
  // Sanctification turns a Divine into a per-modifier value shift (78-122%, can
  // beat the tier max) and permanently locks (Sanctifies) the item.
  OmenOnDivineSanctify:'sanctify',
  // Omen of the Blessed makes a Divine reroll ONLY the implicit modifiers'
  // values, leaving every explicit affix exactly as it is.
  OmenOnDivineRerollImplicits:'blessed',
};
const ESSTIERS = ['lesser','normal','greater','perfect','special'];
const ESSLABEL = { lesser:'Lesser', normal:'Normal', greater:'Greater',
                   perfect:'Perfect', special:'Special' };

let state = null, filter = 'all', open = new Set(), step = 0, hist = [];
let ctier = 'I', preview = 'exalted', omen = '', etier = 'greater', pool = 'normal';
let strict = false;
let openPool = new Set();     // step ids whose modifier list is expanded
let openTier = new Set();     // 'stepId:group|side' rows showing their tier ladder
let zoom = 1;                 // canvas scale; layout stays in unscaled coordinates

function applyZoom() {
  const st = document.getElementById('stage'), wrap = document.getElementById('zoomwrap');
  if (!st || !wrap) return;
  // grow the stage to whatever the cards actually occupy: a vertical chain with
  // open modifier lists runs well past any fixed height
  let w = 900, h = 600;
  for (const c of document.querySelectorAll('#cards .card')) {
    w = Math.max(w, c.offsetLeft + c.offsetWidth + 40);
    h = Math.max(h, c.offsetTop + c.offsetHeight + 40);
  }
  st.style.width = w + 'px';
  st.style.height = h + 'px';
  st.style.transform = `scale(${zoom})`;
  // transform does not change layout size, so size the wrapper for the scrollbars
  wrap.style.width = (w * zoom) + 'px';
  wrap.style.height = (h * zoom) + 'px';
  const lv = document.getElementById('zoomlvl');
  if (lv) lv.textContent = Math.round(zoom * 100) + '%';
}

function setZoom(z, anchor) {
  const cv = document.getElementById('canvas');
  const prev = zoom;
  zoom = Math.max(0.35, Math.min(1.6, z));
  if (cv && anchor) {
    // keep the point under the cursor fixed while scaling
    const sx = (cv.scrollLeft + anchor.x) / prev, sy = (cv.scrollTop + anchor.y) / prev;
    applyZoom();
    cv.scrollLeft = sx * zoom - anchor.x;
    cv.scrollTop = sy * zoom - anchor.y;
  } else applyZoom();
}

/** Shrink until every card fits the viewport, for when a plan gets long. */
function zoomFit() {
  const cv = document.getElementById('canvas');
  const cards = [...document.querySelectorAll('#cards .card')];
  if (!cv || !cards.length) return;
  let w = 0, h = 0;
  for (const c of cards) {
    w = Math.max(w, c.offsetLeft + c.offsetWidth);
    h = Math.max(h, c.offsetTop + c.offsetHeight);
  }
  setZoom(Math.min(1, (cv.clientWidth - 32) / w, (cv.clientHeight - 32) / h));
  cv.scrollLeft = 0; cv.scrollTop = 0;
}
let poolQ = {};               // per-step search text
let boneSrc = 'des';

const minFor = (key, t) => (TIERS[key] ? TIERS[key][t] : 0) || 0;
const omenById = id => OMENS.find(o => o.i === id) || null;
const omenFx = o => o && (OMENFX[o.c] || null);
const LICHTAG = {
  OmenOnAbyssGuarenteeLichTypeMod1: 'ulaman_mod',
  OmenOnAbyssGuarenteeLichTypeMod2: 'amanamu_mod',
  OmenOnAbyssGuarenteeLichTypeMod3: 'kurgal_mod',
};
const LICHNAME = { ulaman_mod: 'Ulaman', amanamu_mod: 'Amanamu', kurgal_mod: 'Kurgal' };
// these two carry no `forces` value in the source data, so the side comes from the code
const ESSSIDE = { OmenOnPerfectEssencePrefix: 'p', OmenOnPerfectEssenceSuffix: 's' };

function newItem() {
  const slug = document.getElementById('cls').value;
  const bname = document.getElementById('base').value;
  const src = BASES[slug];
  const base = src.b.find(x => x.n === bname) || src.b[0];
  return {
    slug, base, classTags: src.ct, itemClass: src.ic,
    ilvl: +document.getElementById('ilvl').value || 1,
    rarity: 'normal', affixes: [], corrupted: false, sanctified: false,
    exceptional: exceptional,           // carried across resets from the toggle
  };
}
let exceptional = null;                  // null | 'socket' | 'quality'

const AFFIX_LIMITS_FOR = r => LIM(r);
const countBy = (it, a) => it.affixes.filter(x => x.a === a).length;
const openSlots = (it, a) => Math.max(0, LIM(it.rarity)[a] - countBy(it, a));
// corrupted implicits don't consume the prefix/suffix budget
const explicits = it => it.affixes.filter(a => a.a !== 'c');
const isFull = it => explicits(it).length >= LIM(it.rarity).total;

function eligible(it, affix, minLv = 0, maxLv = Infinity, src = MODS) {
  const taken = new Set(it.affixes.map(x => x.g));
  const out = [];
  for (const m of src) {
    if (affix && m.a !== affix) continue;
    if (taken.has(m.g)) continue;
    // corrupted implicits sit outside the prefix/suffix budget
    if (m.a !== 'c' && openSlots(it, m.a) <= 0) continue;
    if (!m.c.includes(it.slug)) continue;
    if (m.d && !(it.base.d || []).includes(m.d)) continue;
    for (const t of m.t) {
      if (t[1] > it.ilvl) continue;
      if (t[1] < minLv || t[1] > maxLv) continue;   // currency / bone level gate
      const w = (m.w && m.w[t[0]] && m.w[t[0]][it.slug]) ?? t[3];
      if (!w || w <= 0) continue;
      out.push({ m, t, w });
    }
  }
  // socket-bound rune families: a rune socketed on the item opens its own pool
  // to the normal add/reroll currencies (Exalt/Chaos/Regal). Base restriction is
  // already enforced by the rune only fitting the right base.
  if (src === MODS && it.sockets && it.sockets.length) {
    const fams = new Set(it.sockets.map(id => SBRUNE_BY_ID[id]).filter(Boolean).map(r => r.family));
    for (const fam of fams) for (const m of (SBMODS[fam] || [])) {
      if (affix && m.a !== affix) continue;
      if (taken.has(m.g) || openSlots(it, m.a) <= 0) continue;
      for (const t of m.t) {
        // rune-unlocked mods only obey the item level, NOT the currency tier's
        // level floor (a Perfect Aug still rolls them), since the rune grants them
        if (t[1] > it.ilvl) continue;
        out.push({ m, t, w: t[3] });
      }
    }
  }
  return out;
}

const rint = (lo, hi) => lo === hi ? lo : lo + Math.floor(Math.random() * (hi - lo + 1));
// tidy a rolled number for display: integers stay integers, decimals round to 2
// places so float noise (e.g. 3.81 + 1 = 4.8100000000000005) never shows.
const fmtNum = x => x == null ? '#' : (typeof x === 'number' && !Number.isInteger(x)) ? +x.toFixed(2) : x;
const render = (txt, v) => txt.replace(/\{(\d+)\}/g, (_, i) => fmtNum(v[i]));

function instantiate(e) {
  const v = e.t[2].map(r => rint(r[0], r[1]));
  return { id: e.m.i, a: e.m.a, g: e.m.g, tier: e.t[0], ilvl: e.t[1],
           tname: e.t[4] || null, v, text: render(e.m.x, v) };
}

function addRandom(it, affix, minLv = 0, maxLv = Infinity, src = MODS) {
  const pool = eligible(it, affix, minLv, maxLv, src);
  const total = pool.reduce((s, e) => s + e.w, 0);
  if (!total) return null;
  let r = Math.random() * total, hit = pool[pool.length - 1];
  for (const e of pool) if ((r -= e.w) < 0) { hit = e; break; }
  const a = instantiate(hit);
  it.affixes.push(a);
  return a;
}

/* An armed omen reshapes the roll: force an affix side, add/remove two,
   target the lowest tier, or match an existing mod's tag. */
function omenAdd(it, o, minLv) {
  const fx = omenFx(o);
  if (fx === 'force') return addRandom(it, o.f === 'prefix' ? 'p' : 's', minLv);
  if (fx === 'homog') {
    const tags = new Set(it.affixes.flatMap(a => {
      const m = MODS.find(x => x.i === a.id); return m ? [m.g] : [];
    }));
    const pool = eligible(it, null, minLv).filter(e => tags.has(e.m.g));
    if (pool.length) {
      const tot = pool.reduce((s, e) => s + e.w, 0);
      let r = Math.random() * tot, hit = pool[pool.length - 1];
      for (const e of pool) if ((r -= e.w) < 0) { hit = e; break; }
      const a = instantiate(hit); it.affixes.push(a); return a;
    }
    return addRandom(it, null, minLv);
  }
  return addRandom(it, null, minLv);
}

function omenRemove(it, o) {
  if (!it.affixes.length) return null;
  const fx = omenFx(o);
  let pool = it.affixes;
  if (fx === 'force') pool = it.affixes.filter(a => a.a === (o.f === 'prefix' ? 'p' : 's'));
  if (fx === 'lowest') {
    const lo = Math.min(...it.affixes.map(a => a.ilvl));
    pool = it.affixes.filter(a => a.ilvl === lo);
  }
  if (!pool.length) pool = it.affixes;
  const g = pool[Math.floor(Math.random() * pool.length)];
  it.affixes.splice(it.affixes.indexOf(g), 1);
  return g;
}

const CURR = [
  { k:'transmute', n:'Transmutation', tiered:true, ok: it => it.rarity==='normal',
    run(it,mn,o){ it.rarity='magic'; const a=omenAdd(it,o,mn); return a?`magic, rolled ${a.text}`:'magic, but no mod could spawn'; } },
  { k:'aug', n:'Augmentation', tiered:true, ok: it => it.rarity==='magic' && !isFull(it),
    run(it,mn,o){ const a=omenAdd(it,o,mn); return a?`added ${a.text}`:'no eligible mod'; } },
  { k:'regal', n:'Regal', tiered:true, ok: it => it.rarity==='magic',
    run(it,mn,o){ it.rarity='rare'; const a=omenAdd(it,o,mn); return a?`rare, added ${a.text}`:'rare, no mod added'; } },
  { k:'alch', n:'Alchemy', ok: it => it.rarity==='normal'||it.rarity==='magic',
    run(it,mn,o){ it.rarity='rare'; it.affixes=[]; let n=0;
             const side = omenFx(o)==='force' ? (o.f==='prefix'?'p':'s') : null;
             if(side){ while(openSlots(it,side)>0 && addRandom(it,side)) n++; }
             while(it.affixes.length<4 && addRandom(it)) n++;
             return `rerolled rare with ${n} modifiers`; } },
  { k:'exalted', n:'Exalted', tiered:true, ok: it => it.rarity==='rare' && !isFull(it),
    run(it,mn,o){ if(omenFx(o)==='two'){ const a=omenAdd(it,o,mn), b=!isFull(it)?omenAdd(it,o,mn):null;
                    return `added ${[a,b].filter(Boolean).map(x=>x.text).join('; ')}`; }
             const a=omenAdd(it,o,mn); return a?`added ${a.text}`:'no eligible mod'; } },
  { k:'chaos', n:'Chaos', tiered:true, ok: it => it.rarity==='rare' && it.affixes.length>0,
    run(it,mn,o){ const gone=omenRemove(it,o);
             const a=omenAdd(it,o,mn); return `removed ${gone?gone.text:'nothing'}; added ${a?a.text:'nothing'}`; } },
  { k:'annul', n:'Annulment', ok: it => it.affixes.length>0 && it.rarity!=='normal',
    run(it,mn,o){ const g=omenRemove(it,o);
             if(omenFx(o)==='two' && it.affixes.length){ const g2=omenRemove(it,o);
               return `removed ${[g,g2].filter(Boolean).map(x=>x.text).join('; ')}`; }
             return `removed ${g?g.text:'nothing'}`; } },
  { k:'divine', n:'Divine', ok: it => it.affixes.length>0 && it.rarity!=='normal' && !it.sanctified,
    run(it,mn,o){ const by=new Map(MODS.map(m=>[m.i,m]));
             if(omenFx(o)==='sanctify'){
               // Sanctify: multiply each non-fractured value by 0.78-1.22x (can
               // exceed the tier max), then lock the item for good.
               for(const a of it.affixes){ if(a.fx) continue;
                 if(corruptRerollVals(a)){ const m=by.get(a.id); if(m) a.text=render(m.x,a.v); } }
               it.sanctified=true;
               return 'Sanctified — each modifier shifted 78-122%; the item is now locked'; }
             for(const a of it.affixes){ const m=by.get(a.id); const t=m.t.find(t=>t[0]===a.tier);
               if(t){ a.v=t[2].map(r=>rint(r[0],r[1])); a.text=render(m.x,a.v); } }
             return 'rerolled numeric values'; } },
  { k:'vaal', n:'Vaal', warn:true, ok: it => !it.corrupted,
    run(it){ it.corrupted=true; const r=Math.random();
             if(r<0.25) return 'corrupted — no change';
             if(r<0.5 && it.affixes.length){ const g=it.affixes.splice(Math.floor(Math.random()*it.affixes.length),1)[0];
               return `corrupted — lost ${g.text}`; }
             if(r<0.75){ // gain a corrupted implicit from the corrupted pool
               const a=addRandom(it,'c',0,Infinity,COR);
               return a ? `corrupted — gained ${a.text}` : 'corrupted — no change'; }
             // fourth outcome rerolls the numeric values, staying inside each tier
             for(const a of it.affixes){ const m=MODS.find(x=>x.i===a.id);
               if(!m) continue; const t=m.t.find(x=>x[0]===a.tier);
               if(t){ a.v=t[2].map(r2=>rint(r2[0],r2[1])); a.text=render(m.x,a.v); } }
             return 'corrupted — rerolled values'; } },
];

/* ---------------- rendering ---------------- */

function esc(s){ return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function drawItem() {
  const it = state, t = [];
  // Magic items read as "<prefix> <base> <suffix>"; rare names aren't in the
  // dataset, so a rare shows its base once rather than repeating it on two lines.
  const rc = 'r-' + it.rarity;
  const name = it.rarity === 'magic' ? magicName(it) : it.base.n;
  t.push(`<div class="${rc}"><div class="iname">${esc(name)}</div></div>`);

  const props = Object.entries(it.base.p || {});
  if (props.length) {
    t.push('<div class="rule"></div>');
    for (const [k, v] of props)
      t.push(`<div class="prop"><span>${esc(k)}</span><span>${Array.isArray(v)?v.join('–'):v}</span></div>`);
  }
  const r = it.base.r || {};
  const reqs = [];
  if (r.level) reqs.push('Level ' + r.level);
  for (const a of ['str','dex','int']) if (r[a]) reqs.push(r[a] + ' ' + a[0].toUpperCase()+a.slice(1));
  if (reqs.length) {
    t.push('<div class="rule"></div>');
    t.push(`<div class="prop"><span>Requires</span><span>${esc(reqs.join(', '))}</span></div>`);
  }

  // base implicit modifiers sit between the properties and the explicit block;
  // the graph plans a base, so show the implicit's roll RANGE, not one roll.
  const imp = (it.base && it.base.imp) || [];
  if (imp.length) {
    t.push('<div class="rule"></div>');
    for (const im of imp) {
      const text = render(im.x, (im.v || []).map(r => r[0] === r[1] ? String(r[0]) : r[0] + '–' + r[1]));
      t.push(`<div class="mline impl">${esc(text)}<span class="tg">implicit</span></div>`);
    }
  }

  // corrupted implicits render above the explicit block, as the game shows them
  const corr = it.affixes.filter(a => a.a === 'c');
  if (corr.length) {
    t.push('<div class="rule"></div>');
    for (const a of corr)
      t.push(`<div class="mline c">${a.text.split('\n').map(esc).join('<br>')}` +
             `<span class="tg">implicit</span></div>`);
  }

  t.push('<div class="rule"></div>');
  if (!explicits(it).length) {
    t.push('<div class="empty">no modifiers</div>');
  } else {
    const ord = explicits(it).sort((a,b) => a.a===b.a ? 0 : a.a==='p' ? -1 : 1);
    for (const a of ord) {
      // a hybrid mod carries several stat lines; keep them visually one affix
      const lines = a.text.split('\n').map(esc).join('<br>');
      t.push(`<div class="mline ${a.a}">${lines}<span class="tg">T${a.tier}${a.tname?' · '+esc(a.tname):''}</span></div>`);
    }
  }
  if (it.corrupted) t.push('<div class="rule"></div><div class="empty" style="color:var(--suffix)">Corrupted</div>');
  if (it.sanctified) t.push('<div class="rule"></div><div class="empty" style="color:var(--accent)">Sanctified</div>');
  const tipEl = document.getElementById('tip');
  tipEl.className = 'tip ' + rc;               // rarity tints the border + name banner
  tipEl.innerHTML = t.join('');

  const L = LIM(it.rarity);
  document.getElementById('slots').innerHTML =
    `<span>${RNAME[it.rarity]}</span>` +
    `<span>prefix <b>${countBy(it,'p')}/${L.p}</b></span>` +
    `<span>suffix <b>${countBy(it,'s')}/${L.s}</b></span>` +
    `<span>ilvl <b>${it.ilvl}</b></span>`;
}

function magicName(it) {
  const p = explicits(it).find(a => a.a === 'p'), s = explicits(it).find(a => a.a === 's');
  return [p && p.tname, it.base.n, s && s.tname].filter(Boolean).join(' ');
}

function drawCurrency() {
  const box = document.getElementById('curr');
  box.innerHTML = '';
  for (const c of CURR) {
    const t = c.tiered ? ctier : 'I';
    const mn = c.tiered ? minFor(c.k, ctier) : 0;
    const b = document.createElement('button');
    b.className = 'cur' + (c.warn ? ' warn' : '') + (c.tiered && ctier !== 'I' ? ' up' : '');
    const art = ICONS[c.k];
    b.innerHTML = (art ? `<img class="bico" src="${art}" alt="">` : '') +
                  esc((c.tiered ? TIERWORD[ctier] : '') + c.n);
    if (mn) b.title = `Only rolls modifiers of level ${mn} or higher`;
    const o = omenById(omen);
    const armed = o && o.r.includes(curId(c));
    if (armed) b.classList.add('armed');
    b.disabled = state.corrupted || state.sanctified || !c.ok(state);
    b.onclick = () => {
      let msg;
      try { msg = c.run(state, mn, armed ? o : null); }
      catch (e) { msg = 'failed: ' + e.message; }
      hist.push({ n: ++step,
                  c: (armed ? o.n + ' + ' : '') + (c.tiered ? TIERWORD[t] : '') + c.n,
                  msg: msg + (mn ? ` (mod lv >= ${mn})` : '') });
      if (armed) omen = '';          // an omen is consumed on use
      draw();
    };
    box.appendChild(b);
  }
}

function drawOmens() {
  const sel = document.getElementById('omensel');
  // only omens whose paired currency is usable on this item right now
  const usable = new Set(CURR.filter(c => !state.corrupted && !state.sanctified && c.ok(state)).map(curId));
  const list = OMENS.filter(o => o.r.some(id => usable.has(id)));
  if (!list.find(o => o.i === omen)) omen = '';
  sel.innerHTML = `<option value="">none</option>` + list.map(o =>
    `<option value="${o.i}"${o.i===omen?' selected':''}>${esc(o.n)}${omenFx(o)?'':' (listed only)'}</option>`
  ).join('');
  sel.onchange = e => { omen = e.target.value; draw(); };

  const o = omenById(omen);
  const note = document.getElementById('omennote');
  if (!o) {
    note.innerHTML = list.length
      ? `<b>${list.length}</b> omens apply to the currency this item can take. An omen is consumed by the next matching orb.`
      : `No omen applies at this rarity.`;
  } else {
    const fx = omenFx(o);
    const what = fx === 'force' ? `forces the roll to be a <b>${o.f}</b>`
               : fx === 'two'   ? `acts on <b>two</b> modifiers instead of one`
               : fx === 'lowest'? `targets the <b>lowest-level</b> modifier`
               : fx === 'homog' ? `adds a modifier of an <b>existing family</b> on the item`
               : `is not simulated here &mdash; poe2db lists it without behaviour`;
    note.innerHTML = `<span class="arm">Armed:</span> <b>${esc(o.n)}</b> &mdash; ${what}. ` +
      `Pairs with the highlighted orb${o.r.length>1?'s':''}.`;
  }
}

/* ---- essences: a guaranteed modifier rather than a weighted roll ---- */
const essFor = t => ESS.filter(e =>
  e.ti === t && e.c.includes(state.slug) && e.rl <= state.ilvl);

function drawEssences() {
  document.getElementById('etier').innerHTML = ESSTIERS.map(t => {
    const n = essFor(t).length;
    return `<button class="chip" data-t="${t}" aria-pressed="${t===etier}"${n?'':' disabled'}>` +
           `${ESSLABEL[t]} <span style="opacity:.6">${n}</span></button>`;
  }).join('');
  document.getElementById('etier').querySelectorAll('button').forEach(b =>
    b.onclick = () => { etier = b.dataset.t; drawEssences(); });

  const rows = essFor(etier);
  const sel = document.getElementById('esssel');
  sel.innerHTML = rows.length
    ? rows.map(e => `<option value="${e.i}">${esc(e.n)} &middot; ${esc(
        e.x.replace(/\{(\d+)\}/g, (_, i) => e.v[i] ? (e.v[i][0]===e.v[i][1] ? e.v[i][0] : e.v[i][0]+'-'+e.v[i][1]) : 'X')
         .split('\n').join(' + '))}</option>`).join('')
    : `<option value="">none available for this base and item level</option>`;
  sel.disabled = !rows.length;
  sel.onchange = () => drawEssences();   // note + enabled state follow the choice

  const needRare = etier === 'perfect' || etier === 'special';
  const okRarity = needRare ? state.rarity === 'rare' : state.rarity === 'magic';
  // slots are judged at the rarity the essence leaves the item at, not before
  const after = needRare ? state.rarity : 'rare';
  const chosen = ESS.find(x => x.i === sel.value);
  const side = chosen ? (chosen.a === 'p' ? 'p' : 's') : null;
  const roomy = side
    ? countBy(state, side) < AFFIX_LIMITS_FOR(after)[side]
    : state.affixes.length < AFFIX_LIMITS_FOR(after).total;
  const clash = chosen && state.affixes.some(a => a.g === chosen.g);

  document.getElementById('essgo').disabled =
    !rows.length || state.corrupted || state.sanctified || !okRarity || !roomy || !!clash;
  document.getElementById('essnote').innerHTML = rows.length
    ? `${ESSLABEL[etier]} essences apply to a <b>${needRare ? 'Rare' : 'Magic'}</b> item and grant their modifier outright &mdash; no weighted roll.` +
      (okRarity ? '' : `<br>This item is <b>${RNAME[state.rarity]}</b>.`) +
      (okRarity && clash ? `<br><b>${esc(chosen.g)}</b> is already on the item.` : '') +
      (okRarity && !clash && !roomy ? `<br>No open ${side==='p'?'prefix':'suffix'} once it becomes ${RNAME[after]}.` : '')
    : `No ${ESSLABEL[etier].toLowerCase()} essence targets this base at item level ${state.ilvl}.`;
}

function applyEssence() {
  const id = document.getElementById('esssel').value;
  const e = ESS.find(x => x.i === id);
  if (!e) return;
  if (state.affixes.some(a => a.g === e.g)) {
    hist.push({ n: ++step, c: e.n, msg: `failed: ${e.g} already on the item` });
    return draw();
  }
  const side = e.a === 'p' ? 'p' : 's';
  // the upgrade to Rare happens first: a full Magic item (1 prefix + 1 suffix)
  // still takes an essence, because Rare opens 3/3.
  const was = state.rarity;
  if (e.ti !== 'perfect' && e.ti !== 'special') state.rarity = 'rare';
  if (openSlots(state, side) <= 0) {
    state.rarity = was;
    hist.push({ n: ++step, c: e.n, msg: `failed: no open ${side==='p'?'prefix':'suffix'}` });
    return draw();
  }
  const v = e.v.map(r => rint(r[0], r[1]));
  state.affixes.push({ id: e.i, a: side, g: e.g, tier: 0, ilvl: e.ml,
                       tname: null, v, text: render(e.x, v), ess: true });
  hist.push({ n: ++step, c: e.n, msg: `guaranteed ${render(e.x, v).split('\n').join(' + ')}` });
  draw();
}

/* ---- abyssal bones: desecrated pool, gated by modifier level ---- */
const bonesFor = () => BONES.filter(b => b.classes.includes(state.slug));

function drawBones() {
  const rows = bonesFor();
  const panel = document.getElementById('bonepanel');
  panel.classList.toggle('hide', !rows.length);
  if (!rows.length) return;
  const box = document.getElementById('bones');
  box.innerHTML = '';
  const src = boneSrc === 'des' ? DES : MODS.concat(DES);
  const probe = { ...state, rarity: 'rare', affixes: [] };
  for (const b of rows) {
    const reach = eligible(probe, null, b.min || 0, b.max || Infinity, src).length;
    const btn = document.createElement('button');
    btn.className = 'cur';
    const bart = ICONS[b.id];
    btn.innerHTML = (bart ? `<img class="bico" src="${bart}" alt="">` : '') +
                    esc(b.name + (reach ? '' : ' — 0'));
    btn.title = (b.max ? `Only modifiers up to level ${b.max}`
              : b.min ? `Only modifiers of level ${b.min} or higher`
              : 'No modifier level restriction')
              + ` — ${reach} reachable on this base`;
    btn.disabled = state.corrupted || state.sanctified || state.rarity !== 'rare' || isFull(state) || !reach;
    btn.onclick = () => {
      // poe2db lists both pools for a bone but publishes no split, and the
      // desecrated pool carries no weights. Mixing them would bury desecrated
      // mods at ~0.02% of the roll, so the source is an explicit choice.
      const src = boneSrc === 'des' ? DES : MODS.concat(DES);
      const a = addRandom(state, null, b.min || 0, b.max || Infinity, src);
      hist.push({ n: ++step, c: b.name,
                  msg: a ? `desecrated ${a.text}` : 'no eligible modifier in that window' });
      draw();
    };
    box.appendChild(btn);
  }
  const gates = rows.map(b => `${b.name.split(' ')[0]} ${b.max ? '&le; '+b.max : b.min ? '&ge; '+b.min : 'any'}`);
  document.getElementById('bonesrc').innerHTML =
    [['des','Desecrated only'],['both','Normal + desecrated']].map(([k,l]) =>
      `<button class="chip" data-s="${k}" aria-pressed="${k===boneSrc}">${l}</button>`).join('');
  document.getElementById('bonesrc').querySelectorAll('button').forEach(bt =>
    bt.onclick = () => { boneSrc = bt.dataset.s; draw(); });
  const desReach = eligible(probe, null, 0, Infinity, DES).length;
  const desLo = Math.min(...DES.flatMap(m => m.t.map(t => t[1])));
  document.getElementById('bonenote').innerHTML =
    `Level windows: ${gates.join(' &middot; ')}. Rare items only. ` +
    `<b>${desReach}</b> of ${DES.length} desecrated modifiers reach this base.` +
    (boneSrc === 'both'
      ? `<br>poe2db lists both pools for a bone but states no split, and the desecrated pool carries no weights &mdash; ` +
        `mixed into the weighted normal pool they land at roughly <b>0.02%</b> of the roll. Illustrative only.`
      : `<br>Rolling the desecrated pool uniformly, which is what desecration is for. ` +
        `Desecrated modifiers start at level <b>${desLo}</b>, so a Gnawed bone (&le; 64) cannot reach any of them &mdash; ` +
        `it only rolls the normal pool.`);
}

function drawTierPicker() {
  const el = document.getElementById('ctier');
  el.innerHTML = ['I','II','III'].map(t =>
    `<button class="chip" data-t="${t}" aria-pressed="${t===ctier}">${TIERLABEL[t]}</button>`).join('');
  el.querySelectorAll('button').forEach(b => b.onclick = () => { ctier = b.dataset.t; draw(); });
}

function drawLog() {
  const el = document.getElementById('log');
  if (!hist.length) { el.innerHTML = '<div style="color:var(--faint)">No currency used yet.</div>'; return; }
  el.innerHTML = hist.slice(-40).map(h =>
    `<div><span class="step">${h.n}</span><span><b>${esc(h.c)}</b> — ${esc(h.msg)}</span></div>`).join('');
  el.scrollTop = el.scrollHeight;
}

function drawOdds() {
  const P = POOLS[pool];
  const affix = filter === 'all' ? null : filter;
  // the currency level gate only governs the normal pool
  const minLv = pool === 'normal' ? minFor(preview, ctier) : 0;
  const rows = eligible(state, affix, minLv, Infinity, P.src);
  const total = rows.reduce((s, e) => s + e.w, 0);

  const all = eligible(state, null, minLv, Infinity, P.src);
  const tp = all.filter(e => e.m.a === 'p').reduce((s,e)=>s+e.w,0);
  const ts = all.filter(e => e.m.a === 's').reduce((s,e)=>s+e.w,0);
  const grand = tp + ts;

  // what the level gate removed, measured against the ungated pool
  const ungated = eligible(state, affix, 0, Infinity, P.src);
  const cut = ungated.length - rows.length;
  const cutW = ungated.reduce((s,e)=>s+e.w,0) - total;

  document.getElementById('poolnote').textContent = P.weighted
    ? `${rows.length} tiers · ${total.toLocaleString()} weight`
    : `${rows.length} modifiers · unweighted`;

  const probe = { ...state, rarity: 'rare', affixes: [] };
  document.getElementById('poolpick').innerHTML = Object.entries(POOLS).map(([k, v]) => {
    const n = eligible(probe, null, 0, Infinity, v.src).length;
    return `<button class="chip" data-p="${k}" aria-pressed="${k===pool}">` +
           `${v.label} <span style="opacity:.6">${n}</span></button>`;
  }).join('');
  document.getElementById('poolpick').querySelectorAll('button').forEach(b =>
    b.onclick = () => { pool = b.dataset.p; open = new Set(); drawOdds(); });

  document.getElementById('gatebar').innerHTML = P.weighted
    ? `<span class="glabel">Preview</span>
       <select id="prevsel" aria-label="Currency to preview">${CURR.filter(c=>c.tiered).map(c =>
          `<option value="${c.k}"${c.k===preview?' selected':''}>${TIERWORD[ctier]}${c.n}</option>`).join('')}</select>
       ${minLv
          ? `<span class="gate">modifier level <b>&ge; ${minLv}</b></span>
             <span class="cut">${cut} tier${cut===1?'':'s'} cut &middot; ${cutW.toLocaleString()} weight removed</span>`
          : `<span class="gate">full pool, no level gate</span>`}`
    : `<span class="gate">poe2db publishes <b>no spawn weight</b> for this pool &mdash;
        shares below assume a uniform roll</span>
       <span class="cut">${pool === 'desecrated' ? 'rolled by Abyssal bones' : 'Vaal corruption outcomes'}</span>`;
  const ps = document.getElementById('prevsel');
  if (ps) ps.onchange = e => { preview = e.target.value; drawOdds(); };

  document.getElementById('stats').innerHTML = all.length ? (
    P.weighted ? `
      <div class="stat"><div class="k">Pool weight</div><div class="v">${grand.toLocaleString()}</div></div>
      <div class="stat pre"><div class="k">P(prefix)</div><div class="v">${(tp/grand*100).toFixed(1)}%</div></div>
      <div class="stat suf"><div class="k">P(suffix)</div><div class="v">${(ts/grand*100).toFixed(1)}%</div></div>
      <div class="stat"><div class="k">Families open</div><div class="v">${new Set(all.map(e=>e.m.g)).size}</div></div>`
    : `
      <div class="stat"><div class="k">Modifiers</div><div class="v">${all.length}</div></div>
      <div class="stat pre"><div class="k">Prefixes</div><div class="v">${all.filter(e=>e.m.a==='p').length}</div></div>
      <div class="stat suf"><div class="k">Suffixes</div><div class="v">${all.filter(e=>e.m.a==='s').length}</div></div>
      <div class="stat"><div class="k">Families</div><div class="v">${new Set(all.map(e=>e.m.g)).size}</div></div>`
  ) : `<div class="stat"><div class="k">Pool</div><div class="v">—</div></div>`;

  const byFam = new Map();
  for (const e of rows) {
    const k = e.m.i;
    if (!byFam.has(k)) byFam.set(k, { m: e.m, w: 0, tiers: [] });
    const f = byFam.get(k);
    f.w += e.w; f.tiers.push(e);
  }
  const fams = [...byFam.values()].sort((a, b) => b.w - a.w);
  const max = fams.length ? fams[0].w : 1;

  const tbody = document.getElementById('rows');
  if (!fams.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty" style="padding:22px">
      ${state.sanctified ? 'Item is Sanctified — permanently locked; no further modifiers can be added.'
        : state.corrupted ? 'Item is corrupted — no further modifiers can be added.'
        : !P.weighted && pool === 'desecrated' && state.rarity !== 'rare'
          ? 'Desecrated modifiers land on Rare items, via Abyssal bones.'
        : state.rarity === 'normal' && P.weighted
          ? 'A Normal item has no affix slots. Use Transmutation or Alchemy first.'
        : isFull(state) && P.weighted ? 'No open affix slots.'
        : 'No modifier in this pool can spawn on this base.'}</td></tr>`;
    return;
  }

  const out = [];
  for (const f of fams) {
    const p = total ? f.w / total : 0;
    const best = f.tiers.reduce((a, b) => (b.t[1] > a.t[1] ? b : a));
    const isOpen = open.has(f.m.i);
    out.push(`<tr class="fam" data-id="${esc(f.m.i)}">
      <td><span class="aff ${f.m.a}"></span><span class="caret">${isOpen ? '▾' : '▸'}</span>
          <span class="mname">${esc(f.m.n)}</span><div class="grp">${esc(f.m.g)}</div></td>
      <td class="num">T${best.t[0]} · i${best.t[1]}</td>
      <td class="num">${f.w.toLocaleString()}</td>
      <td class="num"><span class="pct">${(p*100).toFixed(2)}%</span></td>
      <td><div class="barwrap"><div class="bar ${f.m.a}" style="width:${(f.w/max*100).toFixed(1)}%"></div></div></td>
    </tr>`);
    if (isOpen) {
      // show every tier the item level unlocks, including the ones the currency
      // tier gates out — struck through, so the cut itself is visible
      const shown = new Set(f.tiers.map(e => e.t[0]));
      const ladder = f.m.t
        .filter(t => t[1] <= state.ilvl)
        .map(t => ({ t, w: (f.m.w && f.m.w[t[0]] && f.m.w[t[0]][state.slug]) ?? t[3] }))
        .filter(e => e.w > 0)
        .sort((a,b) => a.t[0]-b.t[0]);
      for (const e of ladder) {
        const live = shown.has(e.t[0]);
        const vals = e.t[2].map(r => r[0]===r[1] ? r[0] : `${r[0]}–${r[1]}`);
        out.push(`<tr class="tier${live?'':' gone'}">
          <td><span class="tn">T${e.t[0]}</span> ${esc(render(f.m.x, vals).split('\n').join('  +  '))}${e.t[4]?` <span class="grp" style="display:inline">${esc(e.t[4])}</span>`:''}</td>
          <td class="num">i${e.t[1]}</td>
          <td class="num">${e.w.toLocaleString()}</td>
          <td class="num">${live ? (total ? (e.w/total*100).toFixed(2) : '0.00')+'%' : 'cut'}</td>
          <td></td></tr>`);
      }
    }
  }
  tbody.innerHTML = out.join('');
  tbody.querySelectorAll('tr.fam').forEach(tr => tr.onclick = () => {
    const id = tr.dataset.id;
    open.has(id) ? open.delete(id) : open.add(id);
    drawOdds();
  });
}

// keep the previewed currency relevant to what the item can actually take
function autoPreview() {
  const want = state.rarity === 'normal' ? 'transmute'
             : state.rarity === 'magic'  ? 'regal'
             : 'exalted';
  if (!CURR.find(c => c.k === preview && c.tiered && c.ok(state))) preview = want;
}

function draw() {
  autoPreview(); drawItem(); drawTierPicker(); drawOmens(); drawCurrency();
  drawEssences(); drawBones(); drawLog(); drawOdds();
  if (view === 'desec') drawDesec();
  drawBaseThumb();
}

// the item's art: its own if it has one, else a per-class fallback icon
function baseArt() {
  if (!state) return null;
  return (state.base && state.base.img)
      || (BASES[state.slug] && BASES[state.slug].classimg) || null;
}

// the selected base's art next to the base picker (graph view)
function drawBaseThumb() {
  const t = document.getElementById('basethumb');
  if (!t) return;
  const src = baseArt();
  if (src) { if (t.getAttribute('src') !== src) t.src = src; t.hidden = false; }
  else { t.hidden = true; t.removeAttribute('src'); }
}

/* ================= Monte Carlo =================
   The closed-form solver gives exact expected costs, but a mean hides the
   shape: most attempts are cheap and a long tail is ruinous. This plays the
   plan out with real weighted rolls, so it also captures what the analytic
   model only approximates - Chaos removing before it adds, an Annul taking a
   modifier you wanted, and the pool shifting as the item fills. */

const mcPoolCache = new Map();

/**
 * Every tier is a numeric window, not a single number: T1 increased Energy
 * Shield is 101-110%, not "T1". A real craft lands somewhere inside that
 * window, so the emulator rolls it. The tier still decides the window and the
 * odds; the roll only decides where in it you land.
 */
const rollVals = ranges => (ranges || []).map(r => fmtNum(rint(r[0], r[1])));

const isPerfectEss = e => e && (e.ti === 'perfect' || e.ti === 'special');
const isAbyssEss = e => e && e.g === 'EssenceAbyss';

/**
 * A perfect essence does not add on top; it REPLACES. It removes one existing
 * modifier and writes its guaranteed one in place, so the modifier count does
 * not change. The removal is constrained only by capacity: if the essence's own
 * side is already at its cap the removed modifier must come from that side (you
 * cannot end up with four suffixes), otherwise any modifier is fair game. A
 * fractured modifier can never be the one removed.
 *
 * Returns the list of modifiers eligible to be replaced, empty if none is.
 */
function essReplacePool(affixes, side, forceSide) {
  // a Crystallisation omen forces the replaced modifier onto one side
  if (forceSide) return affixes.filter(a => !a.fx && !a.un && a.a === forceSide);
  const atCap = affixes.filter(a => a.a === side).length >= effLimit(side);
  return affixes.filter(a => !a.fx && !a.un && (atCap ? a.a === side : true));
}

/**
 * The modifier level of an affix: the item level its tier begins spawning at.
 * This is what Omen of Whittling ranks on - its internal name is literally
 * "lowest level mod" - and it is NOT the same as the tier number. Two T1
 * modifiers can sit at different levels, and the lower-level one is the weaker
 * roll in the game's eyes, so tier alone cannot separate them.
 */
function modLevel(a) {
  if (typeof a.ml === 'number') return a.ml;
  const m = modOf(a);
  const t = m && m.t.find(x => x[0] === a.tier);
  return t ? t[1] : 0;
}

/**
 * The real tier a rolled value belongs to. Essences grant a value RANGE that
 * spans several of a mod's tiers (e.g. "Adds 48-79 Cold Damage" is a T3 roll on
 * the ladder, not a T1), so match the rolled numbers against the tier windows to
 * show the true tier and give Whittling the right mod level.
 */
function realTier(m, v) {
  if (!m || !v || !v.length) return null;
  // The largest rolled number is the discriminating one ("Adds A to B" scales on
  // B; lightning fixes A=1). Align it with each tier's window for that same slot -
  // by position from the end, since an essence template may drop the fixed min.
  const eMax = v[v.length - 1];
  const win = t => t[2][t[2].length - 1];
  for (const t of m.t) { const w = win(t); if (w && eMax >= w[0] && eMax <= w[1]) return t; }
  // Below the base's weakest tier (essences can grant sub-tier rolls) or above its
  // best: clamp to the nearest tier by that value.
  let lo = m.t[0], hi = m.t[0];
  for (const t of m.t) { if (win(t)[0] < win(lo)[0]) lo = t; if (win(t)[0] > win(hi)[0]) hi = t; }
  return eMax < win(lo)[0] ? lo : hi;
}

/** The single modifier Whittling would take: lowest level, then worst tier. */
function lowestMod(list) {
  let worst = null;
  for (const a of list) {
    if (!worst) { worst = a; continue; }
    const la = modLevel(a), lw = modLevel(worst);
    if (la < lw || (la === lw && (a.tier || 0) > (worst.tier || 0))) worst = a;
  }
  return worst;
}

/**
 * Find the exact modifier a placed affix came from. Resolving by family alone
 * is not safe: the Armour and Energy Shield variants of a defence family share
 * a group, so a group lookup can silently swap one for the other and rewrite
 * the line. The id is unique, so it is what we match on.
 */
function modOf(a) {
  if (a.id) {
    for (const src of [MODS, DES, COR, SBMODS_ALL]) {
      const hit = src.find(x => x.i === a.id);
      if (hit) return hit;
    }
  }
  const src = a.a === 'c' ? COR : (a.cat === 'desecrated' ? DES : MODS);
  return src.find(x => x.g === a.g && x.a === a.a && (x.c || []).includes(state.slug)) ||
         src.find(x => x.g === a.g && x.a === a.a) || null;
}

/** Reroll one affix's numbers inside the tier it already has. */
/* A Vaal value reroll multiplies each rolled number by 0.78x-1.22x and may push
   it past the tier's normal min/max. It does NOT re-roll fresh inside the tier -
   that regressed good rolls toward the mean, which is why it always felt like a
   downgrade. The multiplier is symmetric around 1.0, so up and down are equal. */
function corruptRerollVals(a) {
  if (!a.v || !a.v.length) return false;
  a.v = a.v.map(v => {
    const nv = v * (0.78 + Math.random() * 0.44);
    return Number.isInteger(v) ? Math.max(1, Math.round(nv)) : +nv.toFixed(2);
  });
  return true;
}
function rerollVals(a) {
  // essence/alloy mods reroll inside their OWN window (a.er), not the base ladder
  if (a.er && a.er.length) { a.v = rollVals(a.er); return true; }
  const m = modOf(a);
  const t = m && m.t.find(x => x[0] === a.tier);
  if (!t) return false;
  a.v = rollVals(t[2]); a.x = m.x;
  return true;
}
/** Reroll one implicit's numbers inside its base window (Divine / Omen of the Blessed). */
function rerollImpVals(a) {
  const src = ((state.base && state.base.imp) || []).find(im => im.x === a.x);
  if (!src || !src.v || !src.v.length) return false;
  a.v = rollVals(src.v);
  return true;
}

/** The concrete line a modifier shows once its values are rolled. */
function modText(a) {
  if (a.v && a.x) return render(a.x, a.v);
  return a.name || a.g;
}

function mcFresh() {
  return { rarity: state.rarity === 'normal' ? 'normal' : state.rarity,
           corrupted: !!state.corrupted, sanctified: !!state.sanctified, socketBonus: 0, corruptDid: null, sockets: [],
           affixes: state.affixes.filter(a => a.a !== 'c')
                      .map(a => ({ g: a.g, a: a.a, tier: a.tier, cat: a.cat, fx: a.fx })) };
}

/** Pools repeat constantly across trials, so memoise on the state that shapes one. */
function mcPool(it, s, D) {
  const min = D.bone ? (D.bone.min || 0) : (D.tiered ? minFor(s.cur, s.tier) : 0);
  const max = D.bone && D.bone.max ? D.bone.max : Infinity;
  const src = s.kind === 'vaal' ? COR
            : (s.kind === 'bone' || s.kind === 'reveal') ? DES : MODS;
  const key = state.slug + '#' + state.ilvl + '#' + (state.exceptional || '') + '#' +
              it.rarity + '#' + it.affixes.map(a => a.g + '|' + a.a).sort().join(',') +
              '#' + min + '#' + max + '#' + (src === DES ? 'd' : 'n') + '#' + (s.omen || '') +
              '#' + (it.sockets || []).filter(id => SBRUNE_BY_ID[id]).sort().join(',');
  let c = mcPoolCache.get(key);
  if (c) return c;
  let pool = eligible(asItem(it), null, min, max, src);
  pool = omenNarrow(pool, s, it).pool;
  c = { pool, tot: pool.reduce((a, e) => a + e.w, 0) };
  mcPoolCache.set(key, c);
  return c;
}

function mcRoll(c) {
  if (!c.tot) return null;
  let r = Math.random() * c.tot;
  for (const e of c.pool) if ((r -= e.w) < 0) return e;
  return c.pool[c.pool.length - 1];
}

/**
 * The four equally-likely outcomes of a corruption: nothing, lose a modifier,
 * gain a corrupted line, or reroll every unlocked modifier's numbers. Shared by
 * the Vaal Orb and by a successful Architect's Orb, which is a second
 * corruption on an already corrupted item.
 */
function corruptGainLine(it, s) {
  const e = mcRoll(mcPool(it, { ...s, kind: 'vaal' }, stepDef({ kind: 'vaal' })));
  if (e) it.affixes.push({ id: e.m.i, g: e.m.g, a: 'c', tier: e.t[0], name: e.m.n,
                           ml: e.t[1], cor: true, x: e.m.x, v: rollVals(e.t[2]) });
}

/**
 * The outcomes of a corruption. On an item type that has sockets a fifth
 * outcome, "+1 socket" (over the type maximum), joins the four modifier
 * outcomes; on jewellery and charms, which have no sockets, only the four
 * apply. The `avoid` argument lets a successful Architect's Orb skip whatever
 * the first corruption already did, since it cannot repeat it.
 *
 * ASSUMPTION: the outcomes are taken as equally likely. GGG has not published
 * the real split, so this is the one number here that is a guess rather than a
 * scraped fact.
 */
function corruptOutcomes(it) {
  // poe2 Vaal core outcomes: nothing, add a corrupted mod, reroll values by a
  // 0.78-1.22x multiplier, and (where the base has sockets) +1 socket. It does
  // not remove an existing modifier.
  const list = ['none', 'gain', 'reroll'];
  if (baseSockets(state.slug) > 0) list.push('socket');
  return list;
}
function applyCorruptOutcome(it, s, o) {
  if (o === 'gain') corruptGainLine(it, s);
  else if (o === 'reroll') { for (const a of it.affixes) if (!a.fx) corruptRerollVals(a); }
  else if (o === 'socket') it.socketBonus = (it.socketBonus || 0) + 1;
  // 'none' does nothing
  return o;
}
function vaalOutcome(it, s, D) {
  const opts = corruptOutcomes(it);
  const o = opts[(Math.random() * opts.length) | 0];
  it.corruptDid = applyCorruptOutcome(it, s, o);
  it.lastCorrupt = it.corruptDid;      // for the emulator to narrate what landed
}

/** Plain-language name for a corruption outcome the diff cannot see on its own. */
function corruptOutcomeNote(o) {
  return o === 'none'   ? 'no visible change'
       : o === 'socket' ? 'added a socket'
       : o === 'reroll' ? 'rerolled values by 0.78x\u20131.22x'
       : o === 'lose'   ? 'removed a modifier'
       : o === 'gain'   ? 'added a corrupted modifier'
       : 'no visible change';
}

function mcRemoveRandom(it, s, wantIndex) {
  // fractured modifiers are safe, corrupted lines are not removable, and an
  // armed omen may narrow this further
  const free = annulPool(it.affixes, s);
  if (!free.length) return wantIndex ? -1 : false;
  const v = free[(Math.random() * free.length) | 0];
  const at = it.affixes.indexOf(v);
  it.affixes.splice(at, 1);
  return wantIndex ? at : true;
}

/** Apply one use of a step's currency. Returns 'ok' or 'dead' (cannot proceed). */
function mcApply(it, s, D) {
  if (s.kind === 'hinekora') return 'ok';   // foresight only: no change to the item
  if (s.kind === 'architect') {
    if (!it.corrupted || it.affixes.some(a => a.twice)) return 'dead';
    // half the time the item is gone; the other half is a second corruption
    if (Math.random() < 0.5) return 'destroyed';
    it.affixes.push({ g: '__twice', a: 'c', tier: 0,
                      name: 'Twice Corrupted', cor: true, twice: true });
    // An Architect's Orb adds a corruption ENCHANTMENT and nothing else: it never
    // rolls a socket, rerolls values, removes a modifier or does nothing - those
    // are Vaal outcomes it does not touch. The enchant also cannot share a mod
    // group with anything already on the item; the corrupted pool already drops
    // taken groups (see eligible), so a success is always a fresh implicit.
    corruptGainLine(it, s);
    it.lastCorrupt = 'gain';
    return 'ok';
  }
  if (s.kind === 'vaal') {
    it.corrupted = true;                 // sealed whichever outcome lands
    vaalOutcome(it, s, D);
    return 'ok';
  }
  if (s.kind === 'reveal') {
    const idx = it.affixes.findIndex(a => a.un);
    if (idx < 0) return 'dead';
    const held = it.affixes[idx];
    const c = revealCandidates(it, held);
    if (!c.tot) return 'dead';
    it.affixes.splice(idx, 1);                       // free the slot it occupies
    const drawOptions = () => {
      const out = [];
      for (let g = 0; out.length < REVEAL_OPTS && g < REVEAL_OPTS * 12; g++) {
        const e = mcRoll(c);
        if (e && !out.some(o => o.m.g === e.m.g && o.m.a === e.m.a)) out.push(e);
      }
      return out;
    };
    const wanted = set => set.find(e => s.targets.some(t => t.g === e.m.g && t.a === e.m.a &&
                                    (!t.maxTier || e.t[0] <= t.maxTier)));
    let opts = drawOptions();
    if (!opts.length) { it.affixes.splice(idx, 0, held); return 'dead'; }
    let want = wanted(opts);
    // Abyssal Echoes rerolls the options, so a miss gets one more independent set
    if (!want && omenFx(s.omen ? omenById(s.omen) : null) === 'reroll') {
      const again = drawOptions();
      if (again.length) { opts = again; want = wanted(again); }
    }
    const take = want || opts[0];
    it.affixes.splice(idx, 0, { g: take.m.g, a: take.m.a, tier: take.t[0],
                                name: take.m.n, cat: 'desecrated' });
    return 'ok';
  }
  if (s.kind === 'divine') {
    if (it.corrupted || it.sanctified) return 'dead';   // both freeze the numbers
    const dfx = omenFx(s.omen ? omenById(s.omen) : null);
    // Omen of Sanctification reshapes a Divine: values shift 0.78-1.22x (may beat
    // the tier max) and the item is permanently locked.
    if (dfx === 'sanctify') {
      for (const a of it.affixes) if (!a.fx) corruptRerollVals(a);
      it.sanctified = true;
      return 'ok';
    }
    // Omen of the Blessed: reroll ONLY the implicit values, explicit untouched.
    if (dfx === 'blessed') {
      for (const a of (it.imp || [])) rerollImpVals(a);
      return 'ok';                          // a Divine never bricks the item
    }
    let moved = 0;
    // a fractured modifier is locked in every sense: its roll cannot move either
    for (const a of it.affixes) if (!a.fx && rerollVals(a)) moved++;
    // a plain Divine rerolls implicit values too (the game rolls both)
    for (const a of (it.imp || [])) if (rerollImpVals(a)) moved++;
    return moved ? 'ok' : 'dead';
  }
  if (s.kind === 'annul') {
    if (!mcRemoveRandom(it, s)) return 'dead';
    // Omen of Greater Annulment strips a second random modifier
    if (omenFx(s.omen ? omenById(s.omen) : null) === 'two') mcRemoveRandom(it, s);
    return 'ok';
  }
  if (s.kind === 'fracture') {
    if (it.affixes.some(a => a.fx)) return 'dead';   // one fracture per item
    // an unrevealed desecrated modifier is not a legal fracture target
    const free = it.affixes.filter(a => !a.fx && !a.un);
    if (!free.length) return 'dead';
    free[(Math.random() * free.length) | 0].fx = true;
    return 'ok';
  }
  if (D.to) it.rarity = D.to;
  if (s.kind === 'essence') {
    const e = D.ess;
    if (countCat(it.affixes, 'crafted') >= maxCrafted()) return 'dead';
    if (it.affixes.some(a => a.g === e.g && a.a === e.a)) return 'dead';
    const add = () => {
      const v = rollVals(e.v);
      // resolve the real mod on this base so the rolled values show their true tier.
      // Match by group/side/class (the essence's template can differ from the mod's
      // - lightning's "Adds 1 to {0}" vs the mod's "Adds {0} to {1}") and prefer the
      // one whose text starts the same way (Adds vs Gain, for the damage families).
      const verb = String(e.x).split(' ')[0];
      const cands = MODS.filter(x => x.g === e.g && x.a === e.a && (x.c || []).includes(state.slug));
      const m = cands.find(x => String(x.x).split(' ')[0] === verb) || cands[0];
      const t = realTier(m, v);
      it.affixes.push({ g: e.g, a: e.a, tier: t ? t[0] : 1, name: e.n, cat: 'crafted',
                        // er = the essence's OWN value window; a Divine and the range
                        // tooltip must stay inside it, not the base mod's wider ladder
                        // (e.g. an Expansive Alloy caps Presence AoE at 35-50%, not 80%)
                        x: e.x, v, er: (e.v || []).map(r => r.slice()),
                        tname: t ? t[4] || null : null, ml: t ? t[1] : (e.ml || 0) });
    };
    if (isPerfectEss(e)) {
      // A Crystallisation omen forces which side is replaced: Sinistral -> prefix,
      // Dextral -> suffix (ESSSIDE holds the mapping).
      const cryst = omenFx(s.omen ? omenById(s.omen) : null) === 'essside'
        ? ESSSIDE[omenById(s.omen).c] : null;
      if (isAbyssEss(e)) {
        // NEW RULE: the Abyss essence cannot be used on an item that already
        // carries a desecrated modifier (revealed, unrevealed, or a pending Mark)
        if (it.affixes.some(a => a.cat === 'desecrated' || a.un || a.mark)) return 'dead';
        // The Essence of the Abyss removes a modifier and writes a "Mark of the
        // Abyssal Lord" placeholder in its place. The Mark's side is set by the
        // Crystallisation omen, or by the chosen essence variant when none is
        // armed. A later desecration bone turns the Mark into an unrevealed
        // desecrated modifier - a second, side-controlled route to the abyss.
        const side = cryst || e.a;
        const pool = it.affixes.filter(a => !a.fx && !a.un && a.a === side);
        if (!pool.length) return 'dead';
        it.affixes.splice(it.affixes.indexOf(pool[(Math.random() * pool.length) | 0]), 1);
        it.affixes.push({ g: 'EssenceAbyss', a: side, tier: 0,
                          name: 'Mark of the Abyssal Lord', cat: 'crafted', mark: true });
        return 'ok';
      }
      // replace: remove one existing modifier, then write the guaranteed one
      const pool = essReplacePool(it.affixes, e.a, cryst === e.a ? cryst : null);
      if (!pool.length) return 'dead';
      const victim = pool[(Math.random() * pool.length) | 0];
      it.affixes.splice(it.affixes.indexOf(victim), 1);
      add();
      return 'ok';
    }
    if (it.affixes.length >= effLimit('total')) return 'dead';
    if (it.affixes.filter(a => a.a === e.a).length >= effLimit(e.a)) return 'dead';
    add();
    return 'ok';
  }
  if (s.kind === 'bone') {
    const mark = it.affixes.find(a => a.mark);
    if (mark) {
      // the Abyss Mark becomes an unrevealed desecrated modifier on its own side,
      // instead of the bone adding a fresh desecrated slot
      mark.mark = false; mark.cat = 'desecrated'; mark.un = true;
      mark.g = '__unrevealed'; mark.name = 'desecrated modifier';
      mark.rOmen = s.omen || null; mark.rMin = D.bone ? (D.bone.min || 0) : 0;
      return 'ok';
    }
    if (countCat(it.affixes, 'desecrated') >= maxDesecrated()) return 'dead';
  }
  // a Chaos Orb takes one modifier away before it writes the new one. Capture the
  // group removed so the replacement is genuinely a different modifier, not a
  // reroll of the very line just taken off (which reads as "nothing changed").
  let slot = -1, avoidG = null;
  if (s.kind === 'orb' && s.cur === 'chaos') {
    const free = annulPool(it.affixes, s);
    if (free.length) {
      const v = free[(Math.random() * free.length) | 0];
      slot = it.affixes.indexOf(v); avoidG = v.g;
      it.affixes.splice(slot, 1);
    }
  }
  let e;
  {
    const P = mcPool(it, s, D);
    if (avoidG) {
      const pool = P.pool.filter(x => x.m.g !== avoidG);
      e = pool.length ? mcRoll({ pool, tot: pool.reduce((a, x) => a + x.w, 0) }) : mcRoll(P);
    } else e = mcRoll(P);
  }
  if (!e && s.kind === 'bone') {
    // A base can lack desecrated modifiers on one side (Int body armour has no
    // desecrated prefixes). A Necromancy omen still forces that side: reserve an
    // unrevealed slot so the reveal - which also draws the normal pool - can fill
    // it. This is what makes "force a prefix, then reveal a normal prefix" work.
    const om = s.omen ? omenById(s.omen) : null;
    const side = omenFx(om) === 'force' ? (om.f === 'prefix' ? 'p' : 's') : null;
    if (side) {
      const probe = asItem(it), min = D.bone ? (D.bone.min || 0) : 0;
      const revealable = eligible(probe, side, min, Infinity, MODS).length
                       + eligible(probe, side, 0, Infinity, DES).length;
      if (revealable) {
        it.affixes.push({ g: '__unrevealed', a: side, tier: 0, name: 'desecrated modifier',
          cat: 'desecrated', un: true, rOmen: s.omen || null, rMin: min });
        return 'ok';
      }
    }
  }
  if (!e) return 'dead';
  const placed = { id: e.m.i, g: e.m.g, a: e.m.a, tier: e.t[0], name: e.m.n,
                   ml: e.t[1], x: e.m.x, v: rollVals(e.t[2]), tname: e.t[4] || null,
                   cat: e.m.fam ? 'rune' : s.kind === 'bone' ? 'desecrated' : undefined,
                   fam: e.m.fam || undefined, tbd: e.m.tbd || undefined,
                   un: s.kind === 'bone' || undefined, g2: e.m.g2,
                   // an Abyss omen spent on the bone also constrains the reveal,
                   // and the bone's tier sets the floor the reveal's normal pool obeys
                   rOmen: s.kind === 'bone' ? (s.omen || null) : undefined,
                   rMin: s.kind === 'bone' ? (D.bone ? (D.bone.min || 0) : 0) : undefined };
  // reuse the emptied slot so a Chaos changes one visible line, not the order
  if (slot >= 0) it.affixes.splice(slot, 0, placed); else it.affixes.push(placed);
  // Omen of Greater Exaltation writes a SECOND modifier when there is room. The
  // pool is re-rolled on the updated item, so it respects the freed capacity, the
  // per-side cap and the no-duplicate-group rule exactly as the first add did.
  if (s.cur === 'exalted' && omenFx(s.omen ? omenById(s.omen) : null) === 'two'
      && it.affixes.length < effLimit('total')) {
    const e2 = mcRoll(mcPool(it, s, D));
    if (e2) it.affixes.push({ id: e2.m.i, g: e2.m.g, a: e2.m.a, tier: e2.t[0], name: e2.m.n,
                              ml: e2.t[1], x: e2.m.x, v: rollVals(e2.t[2]),
                              tname: e2.t[4] || null, g2: e2.m.g2,
                              cat: e2.m.fam ? 'rune' : undefined, fam: e2.m.fam || undefined, tbd: e2.m.tbd || undefined });
  }
  return 'ok';
}

/** Has this step got what it was asked for? */
function mcHit(it, s) {
  if (s.kind === 'divine') return true;
  if (s.kind === 'architect') return it.affixes.some(a => a.twice);
  if (s.kind === 'vaal') {
    if (!s.targets.length) return true;
    return it.affixes.some(a => a.a === 'c' && s.targets.some(t => t.g === a.g));
  }
  if (s.kind === 'reveal') {
    if (!s.targets.length) return true;
    return it.affixes.some(a => !a.un && s.targets.some(t => t.g === a.g && t.a === a.a &&
                            (!t.maxTier || (a.tier && a.tier <= t.maxTier))));
  }
  if (s.kind === 'annul') {
    if (!s.fxPick) return true;
    return !it.affixes.some(a => a.g === s.fxPick.g && a.a === s.fxPick.a);
  }
  if (s.kind === 'fracture') {
    if (!s.fxPick) return it.affixes.some(a => a.fx);
    return it.affixes.some(a => a.fx && a.g === s.fxPick.g && a.a === s.fxPick.a);
  }
  if (s.kind === 'essence') return true;            // an essence always grants its mod
  if (!s.targets.length) return true;
  const has = t => it.affixes.some(a => a.g === t.g && a.a === t.a &&
                     (!t.maxTier || (a.tier && a.tier <= t.maxTier)) &&
                     (!t.minV || (a.v && a.v[0] >= t.minV)));
  return s.mode === 'all' ? s.targets.every(has) : s.targets.some(has);
}

const mcCopy = it => ({ rarity: it.rarity, corrupted: it.corrupted, sanctified: it.sanctified,
                        socketBonus: it.socketBonus || 0, corruptDid: it.corruptDid || null,
                        affixes: it.affixes.map(a => ({ ...a })) });

function mcTrial(cap, P) {
  const use = {};
  const bump = (k, v = 1) => { use[k] = (use[k] || 0) + v; };
  let it = mcFresh(), bricks = 0, k = 0, guard = 0;
  bump('base');
  while (k < P.length) {
    if (++guard > cap) return { stuck: true, use, bricks };
    const s = P[k], D = stepDef(s);
    if (!D) { k++; continue; }
    // corruption is final - except for the one currency built to act on it
    if (it.sanctified) return { stuck: true, use, bricks };   // a total, permanent lock
    if (it.corrupted && s.kind !== 'architect') return { stuck: true, use, bricks };
    if (!it.corrupted && D.needsCorrupt) return { stuck: true, use, bricks };
    if (!D.from.includes(it.rarity)) return { stuck: true, use, bricks };

    // Remember the item as it entered the step. A plain retry means starting the
    // attempt over on an equivalent item - you cannot re-Transmute something that
    // is already Magic - so a miss rolls the item back and pays for a fresh base.
    const entry = mcCopy(it);
    bump(costKey(s));
    if (s.omen) bump('omen:' + s.omen);
    const applied = mcApply(it, s, D);

    // an Architect's Orb can destroy the item outright: that is a brick
    if (applied === 'destroyed') {
      bricks++; bump('base'); it = mcFresh(); k = 0; continue;
    }
    if (applied === 'ok' && mcHit(it, s)) { k++; continue; }

    if (s.fail === 'brick') {
      bricks++; bump('base'); it = mcFresh(); k = 0; continue;
    }
    if (s.rec === 'annul') {
      // an Annul strips a random unlocked modifier, which may be one you wanted
      if (applied === 'dead') { it = entry; }
      bump('annul');
      if (!mcRemoveRandom(it)) return { stuck: true, use, bricks };
      continue;
    }
    // plain retry: rewind to the entry state and try again
    it = entry;
    if (entry.rarity !== it.rarity || applied === 'dead') { /* rewound */ }
    bump('base');
  }
  return { stuck: false, use, bricks, item: it };
}

const mcQ = (sorted, p) => sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))] : 0;

/* Currency market values, denominated in Divine Orbs. PoE2 prices move hourly on
   the exchange (poe.ninja and similar), so this is a hand-entered snapshot: a
   starting point you edit to your league in the Currency prices panel. The Divine
   Orb is the unit (= 1). Keys match costKey(); essences and bones are priced by
   tier. Anything without a price contributes nothing to the total. */
let PRICES = {
  base: 0, 'base:exc': 1, divine: 1,
  transmute: 0.0033, aug: 0.0055, alch: 0.0027, regal: 0.0172, exalted: 0.0022, chaos: 0.114,
  'transmute@II': 0.0032, 'aug@II': 0.003, 'regal@II': 0.0096, 'exalted@II': 0.0149, 'chaos@II': 0.345,
  'transmute@III': 0.0192, 'aug@III': 0.104, 'regal@III': 0.077, 'exalted@III': 2.6, 'chaos@III': 6.2,
  annul: 0.5, vaal: 0.0094, fracture: 8.8, architect: 4.9, reveal: 0, hinekora: 1200,
  'q-weapon': 0.021, 'q-armour': 0.0065, 'q-caster': 0.0096,
  'vinfuse-weapon': 3.3, 'vinfuse-armour': 8.2, 'vinfuse-caster': 2.1,
  'bone:gnawed': 0.05, 'bone:preserved': 0.4, 'bone:ancient': 2,
  'ess:lesser': 0.01, 'ess:normal': 0.03, 'ess:greater': 0.3, 'ess:perfect': 2, 'ess:special': 15,
};
// omen divine values read from poe.ninja (Divine display); 0 = not yet priced
const OMEN_DIV = {
  'omen-of-sinistral-annulment': 15, 'omen-of-sinistral-erasure': 15, 'omen-of-light': 13,
  'omen-of-dextral-annulment': 11, 'omen-of-whittling': 10, 'omen-of-dextral-erasure': 10,
  'omen-of-sanctification': 0.4, 'omen-of-dextral-crystallisation': 0.345, 'omen-of-abyssal-echoes': 0.238,
  'omen-of-the-blackblooded': 0.227, 'omen-of-sinistral-crystallisation': 0.2, 'omen-of-the-blessed': 0.091,
  'omen-of-sinistral-exaltation': 0.053, 'omen-of-catalysing-exaltation': 0.038, 'omen-of-the-sovereign': 0.019,
  'omen-of-dextral-exaltation': 0.008, 'omen-of-greater-exaltation': 0.0076,
};
// each bone defaults to its tier price; omens use the snapshot above, else 0
BONES.forEach(b => { if (!(b.id in PRICES)) PRICES[b.id] = PRICES['bone:' + b.id.split('-')[0]] || 0; });
OMENS.forEach(o => { const k = 'omen:' + o.i; if (!(k in PRICES)) PRICES[k] = OMEN_DIV[o.i] || 0; });
// prices + rates persist across reloads once you edit or import them
const PRICE_LS = 'poe2planner.prices.v1', RATE_LS = 'poe2planner.rates.v1';
try { const sv = JSON.parse(localStorage.getItem(PRICE_LS) || 'null');
      if (sv && typeof sv === 'object') Object.assign(PRICES, sv); } catch (e) {}
function savePrices() { try { localStorage.setItem(PRICE_LS, JSON.stringify(PRICES)); } catch (e) {} cloudPushPricesDebounced(); }
function saveRates(ex, c) { try { localStorage.setItem(RATE_LS, JSON.stringify({ ex, c })); } catch (e) {} cloudPushPricesDebounced(); }
function loadRates() { try { return JSON.parse(localStorage.getItem(RATE_LS) || 'null'); } catch (e) { return null; } }
/** Divine-orb value of one use of a cost key. */
function curDiv(key) {
  if (key == null) return 0;
  if (key === 'base') return state.exceptional ? (PRICES['base:exc'] || 0) : (PRICES.base || 0);
  if (key in PRICES) return PRICES[key];
  if (key === 'brick') return PRICES.base || 0;
  if (key.slice(0, 4) === 'ess:') { const e = ESS.find(x => x.i === key.slice(4)); return PRICES['ess:' + (e ? e.ti : 'normal')] || 0; }
  const b = BONES.find(x => x.id === key);
  if (b) return PRICES['bone:' + b.id.split('-')[0]] || 0;
  return PRICES[key] || 0;
}
const fmtDiv = v => !v ? '0' : v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(1)
  : v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toFixed(4);

function runMC(trials, P, baseCost) {
  P = P || plan;
  mcPoolCache.clear();
  const t0 = performance.now();
  const spends = [], perCur = {}, brickList = [], costs = [];
  let stuck = 0;
  const cap = 4000;
  // a bounded, evenly-spread reservoir of real finished items, kept so a run you
  // like in the distribution can be handed to the emulator to craft on further
  const RES = 120; const reservoir = []; let seenOK = 0;
  for (let n = 0; n < trials; n++) {
    const r = mcTrial(cap, P);
    if (r.stuck) { stuck++; continue; }
    let tot = 0;
    for (const kk in r.use) {
      if (kk !== 'base') tot += r.use[kk];
      perCur[kk] = (perCur[kk] || 0) + r.use[kk];
    }
    spends.push(tot);
    brickList.push(r.bricks);
    let cst = 0; for (const kk in r.use)
      cst += r.use[kk] * (kk === 'base' && baseCost != null ? baseCost : curDiv(kk));
    costs.push(cst);
    if (r.item) {
      seenOK++;
      if (reservoir.length < RES) reservoir.push({ spend: tot, item: mcCopy(r.item) });
      else { const j = (Math.random() * seenOK) | 0; if (j < RES) reservoir[j] = { spend: tot, item: mcCopy(r.item) }; }
    }
  }
  // pick a luckiest / typical / unlucky exemplar from the reservoir by cost
  reservoir.sort((a, b) => a.spend - b.spend);
  const samples = [];
  if (reservoir.length) {
    const at = f => reservoir[Math.min(reservoir.length - 1, Math.max(0, Math.round(f * (reservoir.length - 1))))];
    const seen = new Set();
    [['luckiest', 0], ['typical', .5], ['unlucky', .9]].forEach(([tag, f]) => {
      const pick = at(f);
      if (pick && !seen.has(pick.spend + '#' + pick.item.affixes.length)) {
        seen.add(pick.spend + '#' + pick.item.affixes.length);
        samples.push({ tag, spend: pick.spend, item: pick.item });
      }
    });
  }
  spends.sort((a, b) => a - b);
  costs.sort((a, b) => a - b);
  const ok = spends.length;
  const mean = ok ? spends.reduce((a, b) => a + b, 0) / ok : 0;
  const costMean = ok ? costs.reduce((a, b) => a + b, 0) / ok : 0;
  const meanBricks = ok ? brickList.reduce((a, b) => a + b, 0) / ok : 0;
  const per = {};
  for (const kk in perCur) per[kk] = perCur[kk] / (ok || 1);
  return { trials, ok, stuck, spends, mean, meanBricks, per, samples, costs, costMean,
           costMedian: mcQ(costs, .5), costP10: mcQ(costs, .1), costP90: mcQ(costs, .9),
           median: mcQ(spends, .5), p10: mcQ(spends, .1), p90: mcQ(spends, .9),
           p99: mcQ(spends, .99), min: spends[0] || 0, max: spends[ok - 1] || 0,
           ms: Math.round(performance.now() - t0) };
}

/* ---- plan variants, ranked by what a typical attempt costs ---- */
let variants = [];

function planSnapshot(label) {
  return { id: ++planSeq, label, steps: JSON.parse(JSON.stringify(plan)) };
}

function drawVariants() {
  const box = document.getElementById('vlist');
  if (!box) return;
  box.innerHTML = variants.length
    ? variants.map(v => `<span class="vchip">
        <b>${esc(v.label)}</b> <span style="opacity:.6">${v.steps.length} steps</span>
        <span class="vx" data-vdel="${v.id}">&times;</span></span>`).join('')
    : '<span class="mcnote">No saved variants. Build a plan, save it, change something, save again.</span>';
  box.querySelectorAll('[data-vdel]').forEach(b => b.onclick = () => {
    variants = variants.filter(v => v.id !== +b.dataset.vdel);
    drawVariants();
  });
}

function compareVariants(trials) {
  const all = variants.slice();
  if (plan.length) all.push({ id: 0, label: 'Current plan', steps: plan });
  const rows = all.map(v => {
    const untargeted = v.steps.filter(x =>
      (x.kind === 'orb' || x.kind === 'bone') && !x.targets.length).length;
    if (untargeted) return { label: v.label, bad: `${untargeted} step(s) without a target` };
    const r = runMC(trials, v.steps);
    if (!r.ok) return { label: v.label, bad: 'no run could finish' };
    return { label: v.label, r, steps: v.steps.length };
  });
  // Rank on the median - the mean is dragged around by the tail - but only
  // among plans that actually finish. A median measured over the 1% of runs
  // that survived is not a typical cost, it is survivorship bias, so anything
  // below the reliability floor is ranked after the plans that do finish.
  const RELIABLE = 0.9;
  const good = rows.filter(x => x.r).sort((a, b) => {
    const ar = a.r.ok / a.r.trials >= RELIABLE, br = b.r.ok / b.r.trials >= RELIABLE;
    if (ar !== br) return ar ? -1 : 1;
    return a.r.median - b.r.median;
  });
  return { good, bad: rows.filter(x => x.bad) };
}

function drawCompare(res) {
  const box = document.getElementById('cmpout');
  if (!res) { box.innerHTML = ''; return; }
  if (!res.good.length) {
    box.innerHTML = '<div class="mcnote" style="padding:11px 14px">' +
      (res.bad.map(b => esc(b.label) + ': ' + esc(b.bad)).join('<br>') || 'Nothing to compare.') +
      '</div>';
    return;
  }
  const best = res.good[0].r.median;
  box.innerHTML =
    '<table class="mctable cmptable"><thead><tr>' +
    '<th>#</th><th>Plan</th><th class="num">Median</th><th class="num">vs best</th>' +
    '<th class="num">Mean</th><th class="num">p90</th><th class="num">Bricks</th>' +
    '<th class="num">Finished</th></tr></thead><tbody>' +
    res.good.map((x, i) => {
      const d = best ? (x.r.median / best - 1) * 100 : 0;
      const fin = x.r.ok / x.r.trials;
      const shaky = fin < 0.9;
      return '<tr class="' + (i === 0 ? 'winner' : '') + (shaky ? ' shaky' : '') + '">' +
        '<td class="num">' + (i + 1) + '</td>' +
        '<td>' + esc(x.label) + ' <span style="opacity:.5">' + x.steps + ' steps</span>' +
        (shaky ? ' <span class="unrev">rarely finishes</span>' : '') + '</td>' +
        '<td class="num"><b>' + x.r.median + '</b></td>' +
        '<td class="num">' + (i === 0 ? '&mdash;' : (d >= 0 ? '+' : '') + d.toFixed(0) + '%') + '</td>' +
        '<td class="num">' + x.r.mean.toFixed(1) + '</td>' +
        '<td class="num">' + x.r.p90 + '</td>' +
        '<td class="num">' + x.r.meanBricks.toFixed(2) + '</td>' +
        '<td class="num' + (shaky ? ' warnnum' : '') + '">' + (fin * 100).toFixed(1) + '%</td></tr>';
    }).join('') + '</tbody></table>' +
    (res.bad.length ? '<div class="mcnote" style="padding:8px 14px">' +
      res.bad.map(b => esc(b.label) + ': ' + esc(b.bad)).join('<br>') + '</div>' : '') +
    '<div class="mcfoot" style="padding:8px 14px">Ranked by median &mdash; what a typical attempt ' +
    'costs &mdash; but only among plans that finish at least 90% of the time. A plan marked ' +
    '<i>rarely finishes</i> is ranked last no matter how cheap its median looks, because that ' +
    'median is measured over the few runs that survived rather than over what you would actually ' +
    'spend.</div>';
}

const CUR_PRICE_ROWS = [
  ['transmute', 'Orb of Transmutation'], ['aug', 'Orb of Augmentation'], ['regal', 'Regal Orb'],
  ['exalted', 'Exalted Orb'], ['chaos', 'Chaos Orb'], ['alch', 'Orb of Alchemy'],
  ['transmute@II', 'Greater Transmutation'], ['aug@II', 'Greater Augmentation'], ['regal@II', 'Greater Regal Orb'],
  ['exalted@II', 'Greater Exalted Orb'], ['chaos@II', 'Greater Chaos Orb'],
  ['transmute@III', 'Perfect Transmutation'], ['aug@III', 'Perfect Augmentation'], ['regal@III', 'Perfect Regal Orb'],
  ['exalted@III', 'Perfect Exalted Orb'], ['chaos@III', 'Perfect Chaos Orb'],
  ['annul', 'Orb of Annulment'], ['divine', 'Divine Orb'], ['vaal', 'Vaal Orb'],
  ['fracture', 'Fracturing Orb'], ['architect', "Architect's Orb"],
  ['q-weapon', "Blacksmith's Whetstone"], ['q-armour', "Armourer's Scrap"], ['q-caster', "Arcanist's Etcher"],
  ['vinfuse-weapon', "Vaal Blacksmith's Infuser"], ['vinfuse-armour', "Vaal Armourer's Infuser"], ['vinfuse-caster', "Vaal Arcanist's Infuser"],
  ["hinekora", "Hinekora's Lock"],
  ['base', 'Base item (white)'], ['base:exc', 'Exceptional base (3-socket, etc.)'],
];
const ESS_PRICE_ROWS = [
  ['ess:lesser', 'Lesser essences'], ['ess:normal', 'Essences'], ['ess:greater', 'Greater essences'],
  ['ess:perfect', 'Perfect essences'], ['ess:special', 'Essence of the Abyss'],
];
/* Normalise an item name for fuzzy matching: drop the boilerplate words and
   punctuation so "Omen of the Blackblooded" and "blackblooded" collide. */
function normName(x) {
  return String(x).toLowerCase()
    .replace(/omen of the |omen of |orb of /g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\bthe\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
/* Every priceable key paired with the normalised names that should hit it. */
function priceKeyIndex() {
  const idx = [];
  CUR_PRICE_ROWS.forEach(([k, l]) => idx.push([normName(l), k]));
  // short aliases people actually type / poe.ninja uses
  [['transmutation', 'transmute'], ['transmute', 'transmute'], ['augmentation', 'aug'],
   ['augment', 'aug'], ['regal', 'regal'], ['exalted', 'exalted'], ['exalt', 'exalted'],
   ['chaos', 'chaos'], ['annulment', 'annul'], ['annul', 'annul'], ['divine', 'divine'],
   ['vaal', 'vaal'], ['fracturing', 'fracture'], ['fracture', 'fracture'], ['architect', 'architect'],
   ['alchemy', 'alch']].forEach(p => idx.push(p));
  OMENS.forEach(o => idx.push([normName(o.n), 'omen:' + o.i]));
  BONES.forEach(b => idx.push([normName(b.name), b.id]));
  ESS_PRICE_ROWS.forEach(([k, l]) => idx.push([normName(l.replace(/s$/, '')), k]));
  return idx;
}
function matchPriceKey(idx, text) {
  const n = normName(text);
  if (!n) return null;
  const exact = idx.find(([nm]) => nm === n);
  if (exact) return exact[1];
  const cands = idx.filter(([nm]) => nm && (n.includes(nm) || nm.includes(n)))
    .sort((a, b) => b[0].length - a[0].length);
  return cands.length ? cands[0][1] : null;
}
/* Bulk import: each line contributes a value (its first number) to the item its
   text names. A per-line "div"/"ex" word wins; otherwise the dropdown unit is
   used, converting Exalted to Divine at the given rate. */
/* Dump the whole price table as re-importable "name value" lines (in divines). */
function priceExportText() {
  const out = [];
  CUR_PRICE_ROWS.forEach(([k, l]) => out.push(l + '  ' + (PRICES[k] || 0)));
  OMENS.slice().sort((a, b) => a.n.localeCompare(b.n)).forEach(o => out.push(o.n + '  ' + (PRICES['omen:' + o.i] || 0)));
  BONES.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach(b => out.push(b.name + '  ' + (PRICES[b.id] || 0)));
  ESS_PRICE_ROWS.forEach(([k, l]) => out.push(l + '  ' + (PRICES[k] || 0)));
  return out.join('\n');
}
function importPrices() {
  const text = document.getElementById('pitext').value;
  const unit = document.getElementById('piunit').value;
  const rate = parseFloat(document.getElementById('pirate').value) || 1;   // 1 div = rate ex
  const rateC = parseFloat(document.getElementById('piratec').value) || 1; // 1 div = rateC chaos
  const idx = priceKeyIndex();
  let matched = 0; const missed = [];
  for (let line of text.split('\n')) {
    line = line.trim(); if (!line) continue;
    const num = (line.match(/-?\d+(?:\.\d+)?/) || [])[0];
    if (num == null) continue;
    let u = unit;
    if (/\bdiv(ine)?\b/i.test(line)) u = 'div';
    else if (/\bchaos\b|\bc\b/i.test(line)) u = 'c';
    else if (/\bex(alt(ed)?)?\b/i.test(line)) u = 'ex';
    const nameText = line.replace(/-?\d[\d.,%kKmM]*/g, ' ')
      .replace(/\b(div|divine|ex|exalt|exalted|chaos|c)\b/ig, ' ').replace(/[⇄]/g, ' ');
    const key = matchPriceKey(idx, nameText);
    if (!key) { missed.push(nameText.replace(/\s+/g, ' ').trim().slice(0, 22)); continue; }
    const val = u === 'ex' ? parseFloat(num) / rate
              : u === 'c' ? parseFloat(num) / rateC
              : parseFloat(num);
    PRICES[key] = +val.toFixed(4);
    matched++;
  }
  savePrices();
  saveRates(rate, rateC);
  drawPrices();
  const msg = document.getElementById('pimsg');
  if (msg) msg.textContent = `imported ${matched} price${matched === 1 ? '' : 's'}` +
    (missed.length ? ` \u00b7 no match: ${missed.slice(0, 8).join(', ')}${missed.length > 8 ? '\u2026' : ''}` : '');
  if (em && !document.getElementById('emu').classList.contains('hidden')) drawEmu();
}

/* ============================ Desecration view ============================
   A focused workbench for the abyss mechanic: the rules, the bones for this base,
   the abyss omen groups, and the desecrated pool a reveal draws from. */
function drawDesec() {
  const host = document.getElementById('desecview');
  if (!host) return;
  const slug = state.slug;
  const bones = BONES.filter(b => (b.classes || []).includes(slug))
    .sort((a, b) => (a.min || 0) - (b.min || 0) || a.name.localeCompare(b.name));
  const abyss = OMENS.filter(o => /^OmenOnAbyss/.test(o.c || ''));
  const grp = fx => abyss.filter(o => OMENFX[o.c] === fx);
  const lichOf = m => LICHNAME[(m.g2 || []).find(x => /_mod$/.test(x)) || ''] || '';

  // the desecrated pool this base could surface (rare, all slots open)
  const probe = { ...state, rarity: 'rare', affixes: [] };
  const rows = eligible(probe, null, 0, Infinity, DES);
  const fam = new Map();
  for (const e of rows) {
    const k = e.m.g + '|' + e.m.a;
    if (!fam.has(k)) fam.set(k, { m: e.m, lv: e.t[1] });
  }
  const pool = [...fam.values()].sort((a, b) =>
    (lichOf(a.m) || 'zz').localeCompare(lichOf(b.m) || 'zz') || (a.m.n || '').localeCompare(b.m.n || ''));
  const share = pool.length ? 100 / pool.length : 0;

  const rule = (h, b) => `<div class="desrule"><div class="desruleh">${h}</div><div class="desrulep">${b}</div></div>`;
  const omenGroup = (title, list) => list.length ? `<div class="desomgrp">
      <div class="desomk">${title}</div>
      <div class="desomrow">${list.map(o => omenChip(o, false, esc(o.i))).join('')}</div>
    </div>` : '';

  host.innerHTML = `<section class="panel brk desecpanel">
    <h2>Desecration <span class="note">abyssal bones &middot; unrevealed &amp; revealed modifiers</span></h2>
    <div class="desecbody">
      <div class="desrules">
        ${rule('A bone adds an unrevealed modifier',
          'A desecration bone writes a hidden modifier from the abyss onto a Rare item. Its slot is taken, but it grants nothing until you reveal it at the Well of Souls.')}
        ${rule('One per item, always level 65',
          'An item holds only <b>one</b> desecrated modifier at a time. Every desecrated mod sits at modifier level 65 &mdash; a higher bone only raises the floor on the <i>ordinary</i> mods a reveal can also surface.')}
        ${rule('It is fracture-proof',
          'A Fracturing Orb cannot target an unrevealed mod. On a four-mod item with one unrevealed, a Fracture lands <b>1 in 3</b>, not 1 in 4.')}
        ${rule('The reveal is one-shot',
          'The Well of Souls resolves it once and cannot be redone &mdash; Omen of Abyssal Echoes buys a single reroll of the three candidates. To try again, Annul it off and desecrate afresh.')}
      </div>

      <div class="dessec">
        <div class="desk">Bones for ${esc(BASES[slug] ? (BASES[slug].ic || slug) : slug)}
          <span class="desknote">${bones.length} apply &middot; the badge is the mod-level floor</span></div>
        ${bones.length ? `<div class="desbones">${bones.map(b => `
          <div class="desbone" title="${esc(b.name)} — raises the ordinary pool floor to modifier level ${b.min || 0}">
            <span class="bonefloor">${b.min || 0}</span>
            ${ICONS[b.id] ? `<img class="desboneimg" src="${esc(ICONS[b.id])}" alt="" loading="lazy">`
              : `<span class="desbonefb">${esc(b.name[0])}</span>`}
            <span class="desbonen">${esc(b.name)}</span>
          </div>`).join('')}</div>`
          : `<div class="desempty">No desecration bones apply to this base.</div>`}
      </div>

      <div class="dessec">
        <div class="desk">Abyss omens <span class="desknote">shape a bone or the reveal before it is spent</span></div>
        ${omenGroup('Force the side a bone writes on', grp('force'))}
        ${omenGroup('Confine the reveal to one lich', grp('lich'))}
        ${omenGroup('Buy one reroll of the three', grp('reroll'))}
      </div>

      <div class="dessec">
        <div class="desk">Desecrated pool <span class="desknote">what a reveal could surface on this base &mdash;
          ${pool.length} modifiers &middot; uniform, poe2db publishes no abyss weight</span></div>
        <div class="desstblwrap"><table class="desstbl">
          <thead><tr><th>Modifier</th><th>Lich</th><th class="num">Level</th><th class="num">Chance</th></tr></thead>
          <tbody>${pool.map(({ m, lv }) => `<tr>
            <td><span class="aff ${m.a} des"></span>${esc(m.n || m.g)}</td>
            <td class="deslich">${esc(lichOf(m) || '&mdash;')}</td>
            <td class="num">${lv}</td>
            <td class="num deschance">${share ? share.toFixed(1) + '%' : '&mdash;'}</td>
          </tr>`).join('') || `<tr><td colspan="4" class="desempty">No desecrated modifiers for this base.</td></tr>`}</tbody>
        </table></div>
      </div>
    </div>
  </section>`;
}

function drawPrices() {
  const box = document.getElementById('pricebody');
  const savedR = loadRates();
  if (savedR) { const pe = document.getElementById('pirate'), pc = document.getElementById('piratec');
    if (pe && savedR.ex) pe.value = savedR.ex; if (pc && savedR.c) pc.value = savedR.c; }
  if (!box) return;
  const inp = k => `<input type="number" step="0.001" min="0" data-price="${esc(k)}" value="${PRICES[k] ?? 0}">`;
  const rowsOf = list => list.map(([k, label]) =>
    `<label class="pricerow"><span class="pricek">${esc(label)}</span>${inp(k)}</label>`).join('');
  const sec = (title, list) => `<div class="pricesec"><h3 class="priceh">${esc(title)}` +
    `<span class="pricehn">${list.length}</span></h3><div class="pricegrid">${rowsOf(list)}</div></div>`;
  const omenRows = OMENS.slice().sort((a, b) => a.n.localeCompare(b.n)).map(o => ['omen:' + o.i, o.n]);
  const boneRows = BONES.slice().sort((a, b) => a.name.localeCompare(b.name)).map(b => [b.id, b.name]);
  box.innerHTML = sec('Currencies', CUR_PRICE_ROWS) + sec('Omens', omenRows)
    + sec('Desecration bones', boneRows) + sec('Essences (by tier)', ESS_PRICE_ROWS);
  box.querySelectorAll('[data-price]').forEach(i2 => i2.oninput = () => {
    const v = parseFloat(i2.value);
    PRICES[i2.dataset.price] = isFinite(v) && v >= 0 ? v : 0;
    savePrices();
    if (em && !document.getElementById('emu').classList.contains('hidden')) drawEmu();
  });
  const pigo = document.getElementById('pigo');
  if (pigo && !pigo._wired) { pigo._wired = 1;
    pigo.onclick = importPrices;
    document.getElementById('piclear').onclick = () => {
      document.getElementById('pitext').value = ''; document.getElementById('pimsg').textContent = ''; };
    document.getElementById('picopy').onclick = () => {
      const txt = priceExportText(), ta = document.getElementById('pitext');
      ta.value = txt; document.getElementById('piunit').value = 'div';
      ta.focus(); ta.select();
      try { if (navigator.clipboard) navigator.clipboard.writeText(txt); } catch (e) {}
      document.getElementById('pimsg').textContent =
        'current prices dumped to the box (Divine unit) \u2014 select-copy to back up or share';
    };
  }
}

function drawMC(r) {
  const box = document.getElementById('mcout');
  if (!r) { box.innerHTML = ''; mcSampleItems = []; return; }
  mcSampleItems = r.samples || [];
  const pct = n => (n * 100).toFixed(1) + '%';
  const okRate = r.trials ? r.ok / r.trials : 0;

  // histogram over the bulk of the distribution; everything past p99 is one tail bar
  const cut = Math.max(1, Math.ceil(r.p99 || r.max || 1));
  const BINS = 26, w = Math.max(1, cut / BINS);
  const bins = new Array(BINS + 1).fill(0);
  for (const v of r.spends) {
    const i = v >= cut ? BINS : Math.min(BINS - 1, Math.floor(v / w));
    bins[i]++;
  }
  const top = Math.max(...bins, 1);
  const bars = bins.map((c, i) => {
    const lo = Math.round(i * w), hi = Math.round((i + 1) * w);
    const label = i === BINS ? Math.round(cut) + '+ (tail)' : lo + '-' + hi;
    return '<div class="mcbin" title="' + label + ': ' + c + ' of ' + r.ok + ' runs (' +
      pct(c / (r.ok || 1)) + ')"><div class="mcbarv' + (i === BINS ? ' tail' : '') +
      '" style="height:' + (c / top * 100).toFixed(1) + '%"></div></div>';
  }).join('');

  const rows = Object.entries(r.per).filter(([k]) => k !== 'base')
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => '<tr><td>' +
      (ICONS[k] ? '<img class="bico" src="' + ICONS[k] + '" alt="">' : '') + ' ' +
      esc(costLabel(k)) + '</td><td class="num">' + v.toFixed(2) + '</td><td class="num">' +
      fmtDiv(v * curDiv(k)) + '</td></tr>').join('');

  box.innerHTML =
    '<div class="mcstats">' +
      '<div class="stat"><div class="k">Runs that finished</div><div class="v">' + pct(okRate) + '</div></div>' +
      '<div class="stat"><div class="k">Median spend</div><div class="v">' + r.median + '</div></div>' +
      '<div class="stat"><div class="k">Mean spend</div><div class="v">' + r.mean.toFixed(1) + '</div></div>' +
      '<div class="stat"><div class="k">Unlucky 10% pay</div><div class="v">' + r.p90 + '+</div></div>' +
      '<div class="stat"><div class="k">Bricks per finish</div><div class="v">' + r.meanBricks.toFixed(2) + '</div></div>' +
      '<div class="stat"><div class="k">Median cost</div><div class="v">' + fmtDiv(r.costMedian) + ' <span class="unit">div</span></div></div>' +
    '</div>' +
    '<div class="mcchart"><div class="mcbins">' + bars + '</div>' +
      '<div class="mcaxis"><span>0</span><span>currency spent per completed craft</span><span>' +
      Math.round(cut) + '+</span></div></div>' +
    (r.samples && r.samples.length ? '<div class="mcsamples"><div class="mcsamplk">' +
      'Sample outcomes &mdash; hand one to the emulator to craft it further' +
      '</div><div class="mcsamplrow">' + r.samples.map((sm, i) => {
        const mods = sm.item.affixes.filter(a => a.a !== 'c')
          .map(a => '<div class="m"><span class="tb">' + (a.tier ? 'T' + a.tier : '?') +
            '</span><span>' + esc(modText(a)) + '</span></div>').join('') || '<div class="m ghost">bare base</div>';
        const rar = sm.item.corrupted ? 'Corrupted ' + RNAME[sm.item.rarity] : RNAME[sm.item.rarity];
        return '<div class="mcsampl"><div class="mcsamplh"><span class="mcsampltag ' + sm.tag + '">' +
          sm.tag + '</span><span class="mcsamplsp">' + sm.spend + ' spent</span></div>' +
          '<div class="mcsamplr">' + rar + '</div><div class="mcsamplm">' + mods + '</div>' +
          '<button class="ghost mcsamplb" data-emu="' + i + '">&#9654; Emulate this item</button></div>';
      }).join('') + '</div></div>' : '') +
    '<div class="mcgrid">' +
      '<table class="mctable"><thead><tr><th>Currency</th><th class="num">Mean per finish</th><th class="num">Div</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="mcspread">' +
        '<div><span class="k">Luckiest 10%</span><b>' + r.p10 + '</b></div>' +
        '<div><span class="k">Median</span><b>' + r.median + '</b></div>' +
        '<div><span class="k">Unluckiest 10%</span><b>' + r.p90 + '</b></div>' +
        '<div><span class="k">Worst 1%</span><b>' + r.p99 + '</b></div>' +
        '<div><span class="k">Cheapest / dearest seen</span><b>' + r.min + ' / ' + r.max + '</b></div>' +
        (r.stuck ? '<div><span class="k">Runs that could not finish</span><b class="warn">' +
           pct(r.stuck / r.trials) + '</b></div>' : '') +
        '<div class="mcfoot">' + r.ok.toLocaleString() + ' completed runs &middot; ' + r.ms +
          ' ms &middot; the median is what a typical attempt costs; the mean is dragged up by the tail</div>' +
      '</div>' +
    '</div>';
  box.querySelectorAll('[data-emu]').forEach(b => b.onclick = () => {
    const sm = mcSampleItems[+b.dataset.emu];
    if (sm) emStartFrom(sm.item, 'a simulated ' + sm.tag + ' outcome (' + sm.spend + ' spent)');
  });
}



/* ===================== item stat totals =====================
   What the modifiers actually add up to on this base. Local defences on a
   piece of armour work the way the game applies them: flat first, then the
   increases, so (base + flat) x (1 + increased). Everything else is a running
   sum. Lines the parser does not recognise are listed verbatim rather than
   silently dropped, so nothing on the item is unaccounted for. */

const STAT_RULES = [
  // local defences
  [/^\+([\d.]+) to maximum Energy Shield$/,        (m, s) => s.flat.es += +m[1]],
  [/^([\d.]+)% increased Energy Shield$/,          (m, s) => s.inc.es += +m[1]],
  [/^\+([\d.]+) to Armour$/,                       (m, s) => s.flat.ar += +m[1]],
  [/^([\d.]+)% increased Armour$/,                 (m, s) => s.inc.ar += +m[1]],
  [/^\+([\d.]+) to Evasion Rating$/,               (m, s) => s.flat.ev += +m[1]],
  [/^([\d.]+)% increased Evasion Rating$/,         (m, s) => s.inc.ev += +m[1]],
  [/^([\d.]+)% increased Armour and Energy Shield$/,
    (m, s) => { s.inc.ar += +m[1]; s.inc.es += +m[1]; }],
  [/^([\d.]+)% increased Evasion and Energy Shield$/,
    (m, s) => { s.inc.ev += +m[1]; s.inc.es += +m[1]; }],
  [/^([\d.]+)% increased Armour and Evasion$/,
    (m, s) => { s.inc.ar += +m[1]; s.inc.ev += +m[1]; }],
  [/^([\d.]+)% increased (?:Global )?Armour, Evasion and Energy Shield$/,
    (m, s) => { s.inc.ar += +m[1]; s.inc.ev += +m[1]; s.inc.es += +m[1]; }],

  // pools
  [/^\+([\d.]+) to maximum Life$/,                 (m, s) => s.flat.life += +m[1]],
  [/^([\d.]+)% increased maximum Life$/,           (m, s) => s.inc.life += +m[1]],
  [/^\+([\d.]+) to maximum Mana$/,                 (m, s) => s.flat.mana += +m[1]],
  [/^([\d.]+)% increased maximum Mana$/,           (m, s) => s.inc.mana += +m[1]],
  [/^\+([\d.]+) to Spirit$/,                       (m, s) => s.flat.spirit += +m[1]],
  [/^\+([\d.]+) to Stun Threshold$/,               (m, s) => s.flat.stun += +m[1]],

  // resistances
  [/^\+([\d.]+)% to (Fire|Cold|Lightning|Chaos) Resistance$/,
    (m, s) => s.res[m[2].toLowerCase()] += +m[1]],
  [/^\+([\d.]+)% to (Fire|Cold|Lightning|Chaos) and (Fire|Cold|Lightning|Chaos) Resistances$/,
    (m, s) => { s.res[m[2].toLowerCase()] += +m[1]; s.res[m[3].toLowerCase()] += +m[1]; }],
  [/^\+([\d.]+)% to all Elemental Resistances$/,
    (m, s) => { s.res.fire += +m[1]; s.res.cold += +m[1]; s.res.lightning += +m[1]; }],
  [/^\+([\d.]+)% to maximum (Fire|Cold|Lightning|Chaos) Resistance$/,
    (m, s) => s.maxres[m[2].toLowerCase()] += +m[1]],
  [/^\+([\d.]+)% to all maximum Elemental Resistances$/,
    (m, s) => { s.maxres.fire += +m[1]; s.maxres.cold += +m[1]; s.maxres.lightning += +m[1]; }],

  // attributes
  [/^\+([\d.]+) to (Strength|Dexterity|Intelligence)$/,
    (m, s) => s.attr[m[2].slice(0, 3).toLowerCase()] += +m[1]],
  [/^\+([\d.]+) to (Strength|Dexterity|Intelligence) and (Strength|Dexterity|Intelligence)$/,
    (m, s) => { s.attr[m[2].slice(0,3).toLowerCase()] += +m[1];
                s.attr[m[3].slice(0,3).toLowerCase()] += +m[1]; }],
  [/^\+([\d.]+) to all Attributes$/,
    (m, s) => { s.attr.str += +m[1]; s.attr.dex += +m[1]; s.attr.int += +m[1]; }],
];

/* Thrud's Destruction family are meta-mods: "X% increased Explicit <TYPE> Modifier
   magnitudes" scale the VALUES of every explicit mod tagged <TYPE> (by g2). Build a
   scaler once per item; magText() then renders a mod with its values boosted, so the
   totals/DPS see the amplified numbers. Only explicit mods (which carry g2) scale —
   implicits and the magnitude mods themselves are untouched. */
function magnitudeScaler(it) {
  const magByType = {}; const magGroups = new Set();
  for (const a of (it.affixes || [])) {
    const m = String(modText(a)).match(/(\d+(?:\.\d+)?)% increased Explicit (\w+) Modifier magnitudes/i);
    if (m) { const ty = m[2].toLowerCase(); magByType[ty] = (magByType[ty] || 0) + parseFloat(m[1]); magGroups.add(a.g); }
  }
  const has = Object.keys(magByType).length > 0;
  const scaleOf = a => {
    if (!has || !a.g2 || a.g2.length === 0 || (a.g && magGroups.has(a.g))) return 1;
    let add = 0;
    for (const t of a.g2) if (magByType[t]) add += magByType[t];
    return 1 + add / 100;
  };
  return { magByType, magGroups, scaleOf, has };
}
/** modText for a mod with its numbers scaled by the active magnitude meta-mods. */
function magText(a, scaleOf) {
  const scale = scaleOf ? scaleOf(a) : 1;
  if (scale === 1 || !a.x || !a.v) return modText(a);
  return render(a.x, a.v.map(v => typeof v === 'number'
    ? (Number.isInteger(v) ? Math.round(v * scale) : +(v * scale).toFixed(2)) : v));
}

// test seam: the magnitude meta-mods are too rare to land reliably in a UI test,
// so expose the pure calc so a headless test can verify the scaling deterministically
if (typeof window !== 'undefined') window.__calc = { weaponDPS, spellDPS, itemStats,
  magnitudeScaler, magText, modLine: (a) => modLine(a), setDispScale: f => { dispScale = f; } };
function itemStats(it) {
  const { scaleOf, magGroups } = magnitudeScaler(it);
  const s = {
    flat: { es: 0, ar: 0, ev: 0, life: 0, mana: 0, spirit: 0, stun: 0 },
    inc:  { es: 0, ar: 0, ev: 0, life: 0, mana: 0 },
    res:  { fire: 0, cold: 0, lightning: 0, chaos: 0 },
    maxres: { fire: 0, cold: 0, lightning: 0, chaos: 0 },
    attr: { str: 0, dex: 0, int: 0 },
    other: [],
  };
  for (const a of [...it.affixes, ...(it.imp || [])]) {   // implicits count too
    if (a.rand || a.un || a.twice) continue;         // nothing concrete to add up
    if (a.g && magGroups.has(a.g)) continue;         // a magnitude meta-mod: applied, not summed
    for (const line of String(magText(a, scaleOf)).split('\n')) {
      const txt = line.trim();
      if (!txt) continue;
      let hit = false;
      for (const [re, fn] of STAT_RULES) {
        const m = txt.match(re);
        if (m) { fn(m, s); hit = true; break; }
      }
      if (!hit && !a.impl) s.other.push(txt);   // implicits are shown separately, not in "not summed"
    }
  }

  // socketed runes contribute to the totals (armour stats summed; a weapon/caster
   // line is listed under "not summed")
  const cat = runeCat(state.slug);
  for (const rid of (it.sockets || [])) {
    const r = runeById(rid); if (!r || r.special) continue;
    const ap = A2 => {
      for (const k of ['es', 'ar', 'ev', 'life', 'mana', 'stun']) if (A2[k]) s.flat[k] += A2[k];
      if (A2.incDef) { s.inc.ar += A2.incDef; s.inc.ev += A2.incDef; s.inc.es += A2.incDef; }
      for (const rk of ['fire', 'cold', 'lightning', 'chaos']) if (A2[rk]) s.res[rk] += A2[rk];
      for (const ak of ['str', 'dex', 'int']) if (A2[ak]) s.attr[ak] += A2[ak];
      if (A2.other) s.other.push(A2.other + ' (rune)');
    };
    if (r.all || cat === 'armour') ap(r.a);
    else s.other.push(((cat === 'caster' ? r.c : r.w) || r.n) + ' (rune)');
  }
  // the base's own defences, before anything the modifiers do
  const p = (state.base && state.base.p) || {};
  const base = { es: p['Energy Shield'] || 0, ar: p['Armour'] || 0,
                 ev: p['Evasion Rating'] || p['Evasion'] || 0 };
  // quality raises the base's local defences before the modifiers apply; an
  // exceptional base can push it past the usual 20% cap
  const qual = it.quality != null ? it.quality : qCap(it);
  const total = {};
  for (const k of ['es', 'ar', 'ev'])
    total[k] = Math.round((base[k] * (1 + qual / 100) + s.flat[k]) * (1 + s.inc[k] / 100));
  total.quality = qual;
  total.life = Math.round(s.flat.life * (1 + s.inc.life / 100));
  total.mana = Math.round(s.flat.mana * (1 + s.inc.mana / 100));
  total.spirit = s.flat.spirit;
  total.stun = s.flat.stun;
  return { ...s, base, total };
}

/* Weapon DPS the way the trade site shows it: local flat damage and local
   increases (Physical %, Attack Speed, quality) shape the weapon; global mods
   like "increased Elemental Damage" are NOT local, so they do not move these
   numbers. DPS = average hit damage x attacks per second (crit excluded). */
/* Resolve a snapshot's stored base into the context weaponDPS needs. */
function snapBaseCtx(snap) {
  const ctx = snap && snap.ctx; if (!ctx || !BASES[ctx.slug]) return null;
  const src = BASES[ctx.slug];
  return { base: src.b.find(x => x.n === ctx.baseName) || src.b[0],
           classTags: src.ct, exceptional: ctx.exceptional };
}
function weaponDPS(it, B) {
  B = B || { base: state.base, classTags: state.classTags, exceptional: state.exceptional };
  const p = (B.base && B.base.p) || {};
  const bp = p['Physical Damage'] || [0, 0];
  const baseAPS = p['Attacks per Second'] || 1;
  let crit = p['Critical Hit Chance'] || 0;
  const ele = { Fire: [0, 0], Cold: [0, 0], Lightning: [0, 0] };
  ['Fire', 'Cold', 'Lightning'].forEach(e => { const b = p[e + ' Damage'];
    if (b) { ele[e][0] += b[0]; ele[e][1] += b[1]; } });
  let fp = [0, 0], chaos = [0, 0], incPhys = 0, incAS = 0, incCrit = 0,
      acc = 0, critDmg = 0, incEle = 0, incFire = 0, incCold = 0, incLight = 0;
  const q = it.quality != null ? it.quality : qCap(it);
  const { scaleOf } = magnitudeScaler(it);       // Thrud magnitude meta-mods boost the numbers
  for (const a of [...it.affixes, ...(it.imp || [])]) {   // implicits count too
    if (a.rand || a.un || a.twice) continue;
    for (const ln of String(magText(a, scaleOf)).split('\n')) {
      let m;
      if (m = ln.match(/Adds (\d+) to (\d+) Physical Damage/i)) { fp[0] += +m[1]; fp[1] += +m[2]; }
      else if (m = ln.match(/Adds (\d+) to (\d+) (Fire|Cold|Lightning) Damage/i)) {
        const k = m[3][0].toUpperCase() + m[3].slice(1).toLowerCase(); ele[k][0] += +m[1]; ele[k][1] += +m[2]; }
      else if (m = ln.match(/Adds (\d+) to (\d+) Chaos Damage/i)) { chaos[0] += +m[1]; chaos[1] += +m[2]; }
      else if (m = ln.match(/(\d+)% increased Physical Damage/i)) incPhys += +m[1];
      else if (m = ln.match(/(\d+)% increased Attack Speed/i)) incAS += +m[1];
      else if (m = ln.match(/(\d+)% increased Critical Hit Chance/i)) incCrit += +m[1];
      else if (m = ln.match(/(\d+)% to Critical Damage Bonus/i)) critDmg += +m[1];
      else if (m = ln.match(/\+?(\d+) to Accuracy Rating/i)) acc += +m[1];
      else if (m = ln.match(/(\d+)% increased Elemental Damage/i)) incEle += +m[1];
      else if (m = ln.match(/(\d+)% increased Fire Damage/i)) incFire += +m[1];
      else if (m = ln.match(/(\d+)% increased Cold Damage/i)) incCold += +m[1];
      else if (m = ln.match(/(\d+)% increased Lightning Damage/i)) incLight += +m[1];
    }
  }
  // socketed damage runes add to a martial weapon exactly like local affixes
  if ((B.classTags || []).includes('martial')) {
    for (const rid of (it.sockets || [])) {
      const r = runeById(rid); if (!r || !r.wd) continue;
      const w = r.wd;
      if (w.incPhys) incPhys += w.incPhys;
      if (w.acc) acc += w.acc;
      ['fire', 'cold', 'lightning'].forEach(e => { if (w[e]) {
        const K = e[0].toUpperCase() + e.slice(1); ele[K][0] += w[e][0]; ele[K][1] += w[e][1]; } });
    }
  }
  const pm = 1 + (incPhys + q) / 100;
  const pMin = (bp[0] + fp[0]) * pm, pMax = (bp[1] + fp[1]) * pm;
  const aps = baseAPS * (1 + incAS / 100);
  crit *= 1 + incCrit / 100;
  const eA = k => (ele[k][0] + ele[k][1]) / 2;
  const avgP = (pMin + pMax) / 2, avgE = eA('Fire') + eA('Cold') + eA('Lightning'), avgC = (chaos[0] + chaos[1]) / 2;
  const physDPS = avgP * aps, eleDPS = avgE * aps, chaosDPS = avgC * aps;
  const total = physDPS + eleDPS + chaosDPS;
  // effective = physical + elemental scaled by increased-elemental (all + per-element),
  // + chaos, all lifted by the crit factor (base +100% bonus plus local crit damage)
  const incK = { Fire: incEle + incFire, Cold: incEle + incCold, Lightning: incEle + incLight };
  const effEle = ['Fire', 'Cold', 'Lightning'].reduce((z, k) => z + eA(k) * aps * (1 + incK[k] / 100), 0);
  const critFactor = 1 + (crit / 100) * (1 + critDmg / 100);
  const effTotal = (physDPS + effEle + chaosDPS) * critFactor;
  return { aps, crit, critDmg, acc, incEle, incFire, incCold, incLight,
           pMin, pMax, ele, chaos, physDPS, eleDPS, chaosDPS, total, effTotal, critFactor };
}
// Spell-DPS benchmark for caster weapons (wands/staves/sceptres/foci). Caster
// bases carry no damage, cast speed or crit, and PoE2 has no "adds damage to
// spells" modifier - a spell's base damage comes from the gem. So we anchor to a
// fixed benchmark spell (Spark, from poe2db) at gem level 20 and scale it by the
// item's spell modifiers, PER PROJECTILE. Numbers: poe2db.tw/us/Spark.
const SPARK_LVL = { 20:[13,245], 21:[15,277], 22:[16,313], 23:[19,354], 24:[21,399],
                    25:[24,450], 26:[27,508], 27:[30,573], 28:[34,646], 29:[38,729], 30:[43,822] };
const SPARK_CAST = 0.70, SPARK_CRIT = 9;   // base cast time (s), base crit chance (%)

function spellDPS(it) {
  let incSpell = 0, incLight = 0, incEle = 0, extra = 0, incCast = 0, incCrit = 0, critDmg = 0, levels = 0;
  const { scaleOf } = magnitudeScaler(it);       // Thrud magnitude meta-mods boost the numbers
  for (const a of [...it.affixes, ...(it.imp || [])]) {   // implicits count too
    if (a.rand || a.un || a.twice) continue;
    for (const ln of String(magText(a, scaleOf)).split('\n')) {
      let m;
      // increased damage buckets that apply to Spark (a Lightning spell) - all additive.
      // "increased Elemental Damage with Attacks" is attack-only and must NOT count.
      if (/increased Elemental Damage with Attacks/i.test(ln)) { /* skip */ }
      else if (m = ln.match(/(\d+)% increased Spell Damage/i)) incSpell += +m[1];
      else if (m = ln.match(/(\d+)% increased Lightning Damage/i)) incLight += +m[1];
      else if (m = ln.match(/(\d+)% increased Elemental Damage/i)) incEle += +m[1];
      if (m = ln.match(/(\d+)% increased Cast Speed/i)) incCast += +m[1];
      if (m = ln.match(/(\d+)% increased Critical Hit Chance for Spells/i)) incCrit += +m[1];
      if (m = ln.match(/(\d+)% increased Critical Spell Damage Bonus/i)) critDmg += +m[1];
      if (m = ln.match(/Gain (\d+)% of Damage as Extra (?:Fire|Cold|Lightning|Chaos) Damage/i)) extra += +m[1];
      if (m = ln.match(/\+(\d+) to Level of all (?:Lightning Spell|Lightning|Spell) Skills/i)) levels += +m[1];
      else if (m = ln.match(/\+(\d+) to Level of all Skills/i)) levels += +m[1];
    }
  }
  const capped = 20 + levels > 30;
  const gem = Math.max(20, Math.min(30, 20 + levels));
  const [lo, hi] = SPARK_LVL[gem];
  const incMul = 1 + (incSpell + incLight + incEle) / 100;
  const extraMul = 1 + extra / 100;
  const hitLo = lo * incMul * extraMul, hitHi = hi * incMul * extraMul, hitAvg = (hitLo + hitHi) / 2;
  const casts = (1 / SPARK_CAST) * (1 + incCast / 100);
  const crit = Math.min(100, SPARK_CRIT * (1 + incCrit / 100));
  const critFactor = 1 + (crit / 100) * (1 + critDmg / 100);   // base crit = +100% bonus
  const dps = hitAvg * casts * critFactor;
  return { gem, capped, levels, hitLo, hitHi, hitAvg, casts, crit, critDmg, critFactor, dps,
           incPool: incSpell + incLight + incEle, extra, incCast };
}

function drawStats() {
  const box = document.getElementById('emustats');
  if (!box || !em) return;
  const S = itemStats(em);
  const row = (k, v, cls) => v ? `<div class="strow${cls ? ' ' + cls : ''}">
      <span class="stk">${k}</span><span class="stv">${v}</span></div>` : '';

  const defs = [
    S.total.es ? ['Energy Shield', S.total.es, S.base.es, S.flat.es, S.inc.es] : null,
    S.total.ar ? ['Armour', S.total.ar, S.base.ar, S.flat.ar, S.inc.ar] : null,
    S.total.ev ? ['Evasion', S.total.ev, S.base.ev, S.flat.ev, S.inc.ev] : null,
  ].filter(Boolean);

  const resRow = (k, label) => {
    const v = S.res[k], mx = S.maxres[k];
    if (!v && !mx) return '';
    return `<div class="strow"><span class="stk">${label}</span>
      <span class="stv res-${k}">${v ? (v > 0 ? '+' : '') + v + '%' : '&mdash;'}${
        mx ? ` <span class="stmax">max +${mx}%</span>` : ''}</span></div>`;
  };
  const attrRow = (k, label) => S.attr[k]
    ? `<div class="strow"><span class="stk">${label}</span><span class="stv">+${S.attr[k]}</span></div>` : '';

  const caster = (state.classTags || []).includes('caster');   // spell weapon: use Spark benchmark
  const weapon = !caster && (state.classTags || []).includes('weapon');
  const D = weapon ? weaponDPS(em) : null;
  const SD = caster ? spellDPS(em) : null;
  const rnd = x => Math.round(x);
  // what each socketed rune actually adds, shown on the sheet
  const catNow = runeCat(state.slug);
  const fmtRune = r => {
    if (r.special) return r.n + (r.special === 'suffix' ? ' \u2014 +1 suffix cap' : ' \u2014 +1 crafted cap');
    const parts = [];
    if (catNow === 'martial' && r.wd) { const w = r.wd;
      if (w.incPhys) parts.push('+' + w.incPhys + '% Phys');
      ['fire', 'cold', 'lightning'].forEach(e => { if (w[e])
        parts.push('+' + w[e][0] + '\u2013' + w[e][1] + ' ' + e[0].toUpperCase() + e.slice(1)); });
      if (w.acc) parts.push('+' + w.acc + ' Acc');
    } else if (r.a) { const A = r.a;
      if (A.incDef) parts.push('+' + A.incDef + '% Def');
      if (A.life) parts.push('+' + A.life + ' Life'); if (A.mana) parts.push('+' + A.mana + ' Mana');
      if (A.stun) parts.push('+' + A.stun + ' Stun');
      ['fire', 'cold', 'lightning', 'chaos'].forEach(e => { if (A[e])
        parts.push('+' + A[e] + '% ' + e[0].toUpperCase() + e.slice(1) + ' Res'); });
      ['str', 'dex', 'int'].forEach(k => { if (A[k]) parts.push('+' + A[k] + ' ' + k.toUpperCase()); });
      if (A.other) parts.push(A.other);
    }
    return r.n + (parts.length ? ' \u2014 ' + parts.join(', ') : '');
  };
  const runeLines = (em.sockets || []).map(rid => runeById(rid)).filter(Boolean).map(fmtRune);
  let dpsDelta = '';
  if (weapon && emSnaps.length) {
    const last = emSnaps[emSnaps.length - 1], sctx = snapBaseCtx(last);
    if (sctx && (sctx.classTags || []).includes('weapon')) {
      const dv = D.effTotal - weaponDPS(last.item, sctx).effTotal;
      dpsDelta = `<span class="dpsdelta ${dv > 0.5 ? 'good' : dv < -0.5 ? 'bad' : ''}"
        title="Effective DPS change from snapshot #${last.id}">${dv >= 0 ? '+' : '\u2212'}${
        rnd(Math.abs(dv))} vs snap #${last.id}</span>`;
    }
  }
  let sdDelta = '';
  if (caster && emSnaps.length) {
    const last = emSnaps[emSnaps.length - 1], sctx = snapBaseCtx(last);
    if (sctx && (sctx.classTags || []).includes('caster')) {
      const dv = SD.dps - spellDPS(last.item).dps;
      sdDelta = `<span class="dpsdelta ${dv > 0.5 ? 'good' : dv < -0.5 ? 'bad' : ''}"
        title="Spell DPS change from snapshot #${last.id}">${dv >= 0 ? '+' : '\u2212'}${
        rnd(Math.abs(dv))} vs snap #${last.id}</span>`;
    }
  }
  const eleRanges = D ? ['Fire', 'Cold', 'Lightning'].filter(k => D.ele[k][1])
    .map(k => `${k[0]} ${rnd(D.ele[k][0])}\u2013${rnd(D.ele[k][1])}`) : [];
  // damage mods folded into DPS are dropped from the "not summed" list. For
  // spells only pure single-stat lines are dropped (anchored), so a hybrid mod's
  // other half - e.g. the mana on "increased Spell Damage +X Mana" - is not lost.
  const casterFold = [
    /^\d+% increased Spell Damage$/i, /^\d+% increased Lightning Damage$/i,
    /^\d+% increased Elemental Damage$/i, /^\d+% increased Cast Speed$/i,
    /^\d+% increased Critical Hit Chance for Spells$/i, /^\d+% increased Critical Spell Damage Bonus$/i,
    /^Gain \d+% of Damage as Extra (?:Fire|Cold|Lightning|Chaos) Damage$/i,
    /^\+\d+ to Level of all (?:Lightning Spell|Lightning|Spell) Skills$/i, /^\+\d+ to Level of all Skills$/i,
  ];
  const other = caster ? S.other.filter(o => !casterFold.some(re => re.test(o)))
    : weapon ? S.other.filter(o => !/Adds \d+ to \d+ (Physical|Fire|Cold|Lightning|Chaos) Damage|increased (Physical Damage|Attack Speed|Critical Hit Chance)/i.test(o)) : S.other;
  box.innerHTML = `
    <div class="sthead">Item totals <span class="stnote">${caster
      ? 'spell DPS &mdash; Spark benchmark, per projectile (a spell&rsquo;s base damage comes from the gem, not the weapon)'
      : weapon
      ? 'weapon DPS &mdash; local flat &amp; increases; global % (e.g. increased Elemental Damage) is not local'
      : 'base &plus; flat, then increases' + (S.total.quality > 20 ? ' &middot; quality ' + S.total.quality + '%' : '')}</span></div>
    ${caster ? `<div class="stgrid">
      <div class="stbig"><div class="stbigk">Spell DPS</div><div class="stbigv dps-ele">${rnd(SD.dps)}${sdDelta}</div>
        <div class="stcalc">per projectile &middot; Spark lvl ${SD.gem}${SD.capped ? '+' : ''}</div></div>
      <div class="stbig"><div class="stbigk">Spell hit</div><div class="stbigv">${rnd(SD.hitAvg)}</div>
        <div class="stcalc">${rnd(SD.hitLo)}–${rnd(SD.hitHi)} / cast</div></div>
      <div class="stbig"><div class="stbigk">Casts / sec</div><div class="stbigv">${SD.casts.toFixed(2)}</div>
        <div class="stcalc">${(1 / SPARK_CAST).toFixed(2)} base${SD.incCast ? ' &plus;' + SD.incCast + '%' : ''}</div></div>
    </div>
    <div class="stcols"><div>
      ${row('Crit chance', SD.crit.toFixed(2) + '%')}
      ${row('Crit damage', '+' + (100 + SD.critDmg) + '%')}
      ${row('+Skill levels', SD.levels ? '+' + SD.levels + ' &rarr; Spark lvl ' + SD.gem : '')}
    </div><div>
      ${row('Incr. spell dmg', SD.incPool ? '+' + SD.incPool + '%' : '')}
      ${row('Gain as extra', SD.extra ? '+' + SD.extra + '%' : '')}
      ${row('Cast speed', SD.incCast ? '+' + SD.incCast + '%' : '')}
    </div></div>
    <div class="stnote stwnote">Spark benchmark (level 20 &plus; your &plus;skill levels), per projectile. The item scales the gem&rsquo;s base via increased damage (Spell &plus; Lightning &plus; Elemental), gain-as-extra, cast speed and spell crit.${SD.capped ? ' Gem level capped at 30.' : ''}</div>`
    : weapon ? `<div class="stgrid">
      <div class="stbig"><div class="stbigk">Total DPS</div><div class="stbigv">${rnd(D.total)}</div>
        <div class="stcalc">at ${D.aps.toFixed(2)} aps</div></div>
      <div class="stbig"><div class="stbigk">Physical DPS</div><div class="stbigv dps-phys">${rnd(D.physDPS)}</div>
        <div class="stcalc">${rnd(D.pMin)}\u2013${rnd(D.pMax)} / hit</div></div>
      <div class="stbig"><div class="stbigk">Elemental DPS</div><div class="stbigv dps-ele">${rnd(D.eleDPS)}</div>
        <div class="stcalc">${eleRanges.length ? eleRanges.join('  ') : '&mdash;'}</div></div>
    </div>
    <div class="strow steff"><span class="stk">Effective DPS
        <span class="stnote">crit${(D.incEle || D.incFire || D.incCold || D.incLight) ? ' &plus; inc. ele' : ''}</span></span>
      <span class="stv">${rnd(D.effTotal)}${dpsDelta}</span></div>
    <div class="stcols"><div>
      ${row('Attacks / sec', D.aps.toFixed(2))}
      ${row('Crit chance', D.crit.toFixed(2) + '%')}
      ${row('Crit damage', '+' + (100 + D.critDmg) + '%')}
      ${D.chaosDPS ? row('Chaos DPS', rnd(D.chaosDPS)) : ''}
    </div><div>
      ${D.acc ? row('Accuracy', '+' + D.acc) : ''}
      ${D.incEle ? row('Incr. Elemental', '+' + D.incEle + '%') : ''}
      ${D.incFire ? row('Incr. Fire', '+' + D.incFire + '%') : ''}
      ${D.incCold ? row('Incr. Cold', '+' + D.incCold + '%') : ''}
      ${D.incLight ? row('Incr. Lightning', '+' + D.incLight + '%') : ''}
    </div></div>
    <div class="stnote stwnote">Effective folds crit (base &plus;100% bonus) and increased Elemental Damage; accuracy sets hit chance vs enemy evasion (100% assumed).</div>`
    : (defs.length ? `<div class="stgrid">${defs.map(([label, tot, b, f, i]) => `
      <div class="stbig">
        <div class="stbigk">${label}</div>
        <div class="stbigv">${tot}</div>
        <div class="stcalc">(${b}${f ? ' + ' + f : ''})${i ? ` &times; ${(1 + i / 100).toFixed(2)}` : ''}</div>
      </div>`).join('')}</div>` : '')}
    <div class="stcols">
      <div>
        ${row('Life', S.total.life ? '+' + S.total.life : '')}
        ${row('Mana', S.total.mana ? '+' + S.total.mana : '')}
        ${row('Spirit', S.total.spirit ? '+' + S.total.spirit : '')}
        ${row('Stun threshold', S.total.stun ? '+' + S.total.stun : '')}
        ${attrRow('str', 'Strength')}${attrRow('dex', 'Dexterity')}${attrRow('int', 'Intelligence')}
      </div>
      <div>
        ${resRow('fire', 'Fire res')}${resRow('cold', 'Cold res')}
        ${resRow('lightning', 'Lightning res')}${resRow('chaos', 'Chaos res')}
      </div>
    </div>
    ${runeLines.length ? `<div class="strunes"><span class="stk">Socketed runes</span>
      ${runeLines.map(l => `<div>${esc(l)}</div>`).join('')}</div>` : ''}
    ${other.length ? `<div class="stother"><span class="stk">Not summed</span>
      ${other.map(o => `<div>${esc(o)}</div>`).join('')}</div>` : ''}`;
}

/* ===================== craft emulator =====================
   A single real item, crafted roll by roll. Every action runs the same
   mcApply the Monte Carlo uses, so the emulator and the odds can never drift:
   what you see here is one sample from exactly the distribution the graph
   scores. The graph answers "how likely"; this answers "what happened". */

let em = null;              // the live item { rarity, affixes, corrupted }
let emHist = [];            // snapshots for undo
let emLog = [];             // human-readable step log
let emOmen = '';            // an armed omen id, consumed on the next matching use
let emPend = null;          // an in-progress choice: reveal options or essence list
let emFlash = [];           // keys touched by the last action, briefly highlighted
let emCompare = null;       // cached "this run vs Monte Carlo" comparison
let emSunk = {};            // currency banked from undone attempts (real retry cost)
let emBaseCost = null;      // per-craft base item cost in divines (null = use the price table)
let emSim = null;           // last "simulate this step x1000" result
let emLock = false;         // Hinekora's Lock armed: preview the next outcome
let emSweep = false;        // one-shot: play the foresight sweep on the NEXT draw only
let emSnaps = [];           // saved item states you can branch an emulation from
let mcSampleItems = [];     // real outcomes the last simulation surfaced to emulate
let emRepeat = 1;           // bulk-apply count for the next currency click (shift+click)
let emLast = null;          // { opt, omen } of the last standard apply, for "reuse" (R)
let emMacro = [];           // recorded rotation: [{ opt, omen, n }] replayed in a loop
let emRecording = false;    // capture applies into emMacro

/** Currencies that can be spammed / scripted (no picker, can repeat). */
const bulkable = k => k === 'orb' || k === 'annul' || k === 'divine';
/** Is this exact option legal on the item right now? (for bulk / macro guards) */
const optLegal = opt => optionsFor(em, true).some(o => o.kind === opt.kind &&
  o.cur === opt.cur && (o.tier || 'I') === (opt.tier || 'I') && (o.ref || null) === (opt.ref || null));

/**
 * Which modifiers an armed omen is aiming at, so the item can show them before
 * the currency is spent. This is the in-game affordance: a Whittling lights up
 * the modifier it would strip, and you decide whether you still want to press it.
 */
function emOmenTargets(item, omenId) {
  const o = omenId ? omenById(omenId) : null;
  const fx = omenFx(o);
  if (!fx) return { keys: new Set(), note: '' };
  const k = a => a.g + '|' + a.a;
  const free = item.affixes.filter(a => !a.fx);
  if (fx === 'desec') {
    const hit = free.filter(a => a.cat === 'desecrated');
    return { keys: new Set(hit.map(k)),
             note: hit.length ? 'this omen removes the desecrated modifier'
                              : 'no desecrated modifier to remove' };
  }
  if (fx === 'force') {
    const side = o.f === 'prefix' ? 'p' : 's';
    // on a removal currency the omen picks from that side; on an adding one it
    // constrains what gets written, so there is nothing on the item to point at
    const hit = free.filter(a => a.a === side);
    return { keys: new Set(hit.map(k)),
             note: `restricted to ${o.f}es`.replace('prefixes', 'prefixes') };
  }
  if (fx === 'lowest') {
    const worst = lowestMod(free);
    return { keys: new Set(worst ? [k(worst)] : []),
             note: worst ? `targets the lowest-level modifier on the item ` +
                           `(mod level ${modLevel(worst)}, T${worst.tier})` : '' };
  }
  if (fx === 'lich')
    return { keys: new Set(), note: `guarantees a ${LICHNAME[LICHTAG[o.c]] || 'lich'} modifier` };
  if (fx === 'reroll') return { keys: new Set(), note: 'rerolls the reveal options once' };
  if (fx === 'two') return { keys: new Set(), note: 'acts on two modifiers' };
  if (fx === 'blessed') {
    const has = item.imp && item.imp.length;
    return { keys: new Set(), impl: true,
             note: has ? "rerolls only the implicit modifiers' values"
                       : 'this base has no implicit to reroll' };
  }
  return { keys: new Set(), note: '' };
}

function emSnap() {
  return { rarity: em.rarity, corrupted: em.corrupted, sanctified: em.sanctified, quality: em.quality, exc: em.exc,
           sockets: (em.sockets || []).slice(), imp: (em.imp || []).map(a => ({ ...a })),
           affixes: em.affixes.map(a => ({ ...a })), log: emLog.length };
}
function emItem() { return { slug: state.slug, base: state.base, classTags: state.classTags,
                             ilvl: state.ilvl, rarity: em.rarity, affixes: em.affixes, imp: em.imp,
                             corrupted: em.corrupted, sanctified: em.sanctified }; }

// Implicit modifiers live on the base item type (not prefixes/suffixes). Roll a
// concrete value for each, like the game would when the base drops.
function rollImp(base) {
  const imp = base && base.imp;
  return imp ? imp.map(im => ({ g: 'implicit', a: 'i', impl: true,
                                x: im.x, v: (im.v || []).map(r => rint(r[0], r[1])) })) : [];
}

function emStart(fresh) {
  if (fresh || !em) { em = mcFresh(); em.quality = 20; em.imp = rollImp(state.base); emHist = []; emLog = []; emOmen = ''; emPend = null; emCompare = null; emSunk = {}; emLock = false; }
  document.getElementById('emu').classList.remove('hidden');
  drawEmu();
}
function emCloseModal() {
  document.getElementById('emu').classList.add('hidden');
  syncHeaderRunes();                       // the graph's caps come from the header chips again
  if (view === 'graph') drawPlan();
}
/* One <select> per socket; picking a rune stores it on em.sockets and re-totals. */
function drawEmuRunes() {
  const box = document.getElementById('emurunes'); if (!box) return;
  const sk = maxSockets(em);
  if (!sk) { box.innerHTML = ''; return; }
  em.sockets = (em.sockets || []).slice(0, sk);
  const cat = runeCat(state.slug);
  const usable = RUNES.filter(r => r.req <= state.ilvl);
  const sbFit = SBRUNES.filter(r => r.fits(state.slug));   // socket-bound runes for this base
  const filled = em.sockets.filter(Boolean).length;
  const opt = (r, cur) => `<option value="${esc(r.i)}"${cur === r.i ? ' selected' : ''}>${esc(r.n)}</option>`;
  const curExc = itemExc(em), qc = qCap(em), qv = (em.quality != null) ? em.quality : qc;
  box.innerHTML = `<div class="emurunehead">Runes &middot; ${filled}/${sk} socketed
      <span class="emurunecat">${cat}</span>
      <select class="excsel" id="emexcsel"
        title="An exceptional base drops with one extra socket, or extra quality, over the normal cap">
        <option value=""${curExc === '' ? ' selected' : ''}>Normal base</option>
        <option value="socket"${curExc === 'socket' ? ' selected' : ''}>Exceptional (+1 socket)</option>
        <option value="quality"${curExc === 'quality' ? ' selected' : ''}>Exceptional (+quality)</option>
      </select>
      <label class="qualbox" title="Item quality: +1% Physical (weapons) or +1% Defence (armour) per 1%">Quality
        <input type="number" id="emqual" min="0" max="30" value="${qv}">%</label></div>` +
    // socket-bound Augment runes that fit this base become extra rune options
    Array.from({ length: sk }, (_, i) => {
      const cur = em.sockets[i] || '';
      if (cur && isBoundRune(cur)) {                 // permanent once placed: show it locked
        const rn = runeById(cur) || SBRUNE_BY_ID[cur];
        const label = rn ? (rn.n || rn.name) : cur;
        const fam = SBRUNE_BY_ID[cur] ? ' &middot; ' + esc(SBRUNE_BY_ID[cur].family) : '';
        return `<div class="runesel bound" title="socket-bound &mdash; permanent once placed (Reset item to clear)">
          <span class="sblock">&#128274;</span> ${esc(label)}${fam}</div>`;
      }
      // exclude bound runes already placed elsewhere (each is limited to one)
      const elsewhere = new Set(em.sockets.filter((x, j) => j !== i && x && isBoundRune(x)));
      const sbOpts = sbFit.filter(r => !elsewhere.has(r.id))
        .map(r => `<option value="${esc(r.id)}"${cur === r.id ? ' selected' : ''}>${esc(r.name)} &mdash; ${esc(r.family)}</option>`).join('');
      return `<select class="runesel${cur ? ' filled' : ''}" data-sock="${i}">
        <option value="">&mdash; empty socket &mdash;</option>
        ${usable.filter(r => !(isBoundRune(r.i) && elsewhere.has(r.i))).map(r => opt(r, cur)).join('')}
        ${sbFit.length ? `<optgroup label="Socket-bound (permanent)">${sbOpts}</optgroup>` : ''}
      </select>`;
    }).join('') +
    // bonded bonuses + unlocked families for any socket-bound rune in the item
    (() => {
      const on = em.sockets.filter(id => id && SBRUNE_BY_ID[id]).map(id => SBRUNE_BY_ID[id]);
      if (!on.length) return '';
      return `<div class="sbbonded">${on.map(r => `<div class="sbrow">
          <span class="sbfam">&#128274; ${esc(r.family)} modifiers unlocked</span>
          <span class="sbbonus">bonded &middot; ${esc(render(r.bonded.x, (r.bonded.vr || []).map(v => v[0])))}</span>
        </div>`).join('')}</div>`;
    })();
  box.querySelectorAll('[data-sock]').forEach(sel => sel.onchange = () => {
    const i = +sel.dataset.sock, v = sel.value;
    // stat runes stack freely; the Aldur cap-runes and socket-bound Augment runes
    // are limited to one each (and bound ones then lock their socket)
    const rn = runeById(v);
    if (v && ((rn && rn.special) || isBoundRune(v)))
      em.sockets = em.sockets.map((x, j) => x === v && j !== i ? '' : x);
    em.sockets[i] = v;
    syncEmRunes(); drawEmu();
  });
  const ex = document.getElementById('emexcsel');
  if (ex) ex.onchange = () => { em.exc = ex.value;
    if (em.quality != null) em.quality = Math.min(em.quality, qCap(em));
    syncEmRunes(); drawEmu(); };
  const qi = document.getElementById('emqual');
  if (qi) qi.oninput = () => { let v = parseInt(qi.value, 10);
    em.quality = Math.max(0, Math.min(30, isFinite(v) ? v : 0)); drawEmu(); };
}

/** A deep, emulator-shaped copy of an item state. */
function emCopyItem(it) {
  return { rarity: it.rarity, corrupted: !!it.corrupted, sanctified: !!it.sanctified, socketBonus: it.socketBonus || 0,
           corruptDid: it.corruptDid || null, lastCorrupt: it.lastCorrupt || null,
           quality: it.quality, exc: it.exc,
           sockets: (it.sockets || []).slice(),
           imp: (it.imp || []).map(a => ({ ...a })),
           affixes: (it.affixes || []).map(a => ({ ...a })) };
}

/** Open the emulator seeded with a given item - the bridge from the simulator. */
/* Switch the whole app to a given base (slug/base/ilvl/exceptional). Used when a
   snapshot from another item class is emulated, so its mods stay legal - otherwise
   an armour snapshot would carry "increased Energy Shield" onto a spear. */
function restoreBase(ctx) {
  if (!ctx || !ctx.slug || !BASES[ctx.slug]) return false;
  const cls = document.getElementById('cls'), bs = document.getElementById('base');
  cls.value = ctx.slug; fillBases();
  if (ctx.baseName && [...bs.options].some(o => o.value === ctx.baseName)) bs.value = ctx.baseName;
  if (ctx.exceptional !== undefined) exceptional = ctx.exceptional || null;
  document.querySelectorAll('#excpick button').forEach(x =>
    x.setAttribute('aria-pressed', String((x.dataset.exc || '') === (exceptional || ''))));
  state = newItem();
  if (ctx.ilvl) { state.ilvl = ctx.ilvl; document.getElementById('ilvl').value = ctx.ilvl; }
  plan = []; selStep = null;            // the plan belonged to the old base
  syncRunes();
  return true;
}
function emStartFrom(item, label, ctx) {
  const switched = ctx && ctx.slug && ctx.slug !== state.slug && restoreBase(ctx);
  em = emCopyItem(item);
  if (!em.imp || !em.imp.length) em.imp = rollImp(state.base);   // older snapshots carry none
  emHist = []; emLog = []; emOmen = ''; emPend = null; emCompare = null; emSunk = {}; emSim = null;
  if (switched) emLog.push({ label: '', detail: 'switched base to ' + esc(BASES[state.slug].ic || state.slug) +
                             ' to match this snapshot', note: true });
  if (label) emLog.push({ label: '', detail: 'seeded from ' + label, note: true });
  document.getElementById('emu').classList.remove('hidden');
  setView('graph');
  drawEmu();
}

/* ---- "Emulate from your item": enter the mods you already have, then roll the
   rest with the currency tally starting from that state. ---- */
let startAffixes = [];   // [{ m, t }] chosen mod record + tier tuple
let startRar = 'rare';

function openStartEdit() {
  startAffixes = []; startRar = 'rare';
  document.getElementById('startedit').classList.remove('hidden');
  drawStartEdit();
}
function closeStartEdit() { document.getElementById('startedit').classList.add('hidden'); }

// a light item used only to ask eligible() what can still be added
function startProbe() {
  return { slug: state.slug, base: state.base, ilvl: state.ilvl, rarity: startRar,
           affixes: startAffixes.map(x => ({ g: x.m.g, a: x.m.a })) };
}
// one emulator-shaped affix from a chosen mod + tier tuple (values rolled in-tier)
function startAffix(m, t) {
  return { id: m.i, g: m.g, a: m.a, tier: t[0], ml: t[1], name: m.n, x: m.x,
           v: t[2].map(r => rint(r[0], r[1])), tname: t[4] || null, g2: m.g2 };
}

function drawStartEdit() {
  document.getElementById('startbasen').textContent = (state.base && state.base.n) || state.slug;
  document.getElementById('startilvl').textContent = state.ilvl;
  document.querySelectorAll('#startrar .chip').forEach(c => {
    c.setAttribute('aria-pressed', String(c.dataset.rar === startRar));
    c.onclick = () => {
      startRar = c.dataset.rar;
      const cap = LIM(startRar), kept = { p: 0, s: 0 };      // trim to the new caps
      startAffixes = startAffixes.filter(x => ++kept[x.m.a] <= (x.m.a === 'p' ? cap.p : cap.s));
      drawStartEdit();
    };
  });

  const box = document.getElementById('startmods');
  box.innerHTML = startAffixes.length
    ? startAffixes.map((x, i) => {
        const tiers = x.m.t.filter(t => t[1] <= state.ilvl);
        const tsel = tiers.length > 1
          ? `<select class="starttier" data-ti="${i}">${tiers.map(t =>
              `<option value="${t[0]}"${t[0] === x.t[0] ? ' selected' : ''}>T${t[0]}${t[4] ? ' · ' + esc(t[4]) : ''}</option>`).join('')}</select>`
          : '';
        return `<div class="startchip ${x.m.a === 'p' ? 'pre' : 'suf'}">
          <span class="startk">${x.m.a === 'p' ? 'prefix' : 'suffix'}</span>
          <b>${esc(render(x.m.x, x.t[2].map(r => r[0] === r[1] ? String(r[0]) : r[0] + '–' + r[1])))}</b>
          ${tsel}<button class="startx" data-del="${i}" title="remove">&times;</button></div>`;
      }).join('')
    : '<div class="startempty">No modifiers yet &mdash; add the prefixes and suffixes your item already has.</div>';
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { startAffixes.splice(+b.dataset.del, 1); drawStartEdit(); });
  box.querySelectorAll('[data-ti]').forEach(sel => sel.onchange = () => {
    const x = startAffixes[+sel.dataset.ti], t = x.m.t.find(tt => tt[0] === +sel.value);
    if (t) x.t = t; drawStartEdit();
  });

  const probe = startProbe();
  const fill = (side, selId) => {
    const sel = document.getElementById(selId), seen = new Map();
    for (const e of eligible(probe, side, 0, Infinity, MODS)) {
      const cur = seen.get(e.m.g);
      if (!cur) seen.set(e.m.g, { m: e.m, best: e.t });
      else if (e.t[0] < cur.best[0]) cur.best = e.t;
    }
    const opts = [...seen.values()].sort((a, b) => a.m.n.localeCompare(b.m.n));
    sel.innerHTML = `<option value="">${opts.length ? 'choose a modifier…' : 'no open slot'}</option>` +
      opts.map((o, i) => `<option value="${i}">${esc(o.m.n)} (best T${o.best[0]})</option>`).join('');
    sel.disabled = !opts.length;
    sel.onchange = () => { if (sel.value !== '') { startAffixes.push({ m: opts[+sel.value].m, t: opts[+sel.value].best }); drawStartEdit(); } };
  };
  fill('p', 'startaddp');
  fill('s', 'startadds');
  const note = document.getElementById('startnote'); if (note) note.textContent = '';
}

function startEmulate() {
  const affixes = startAffixes.map(x => startAffix(x.m, x.t));
  const item = { rarity: startRar, affixes, quality: 20, exc: state.exceptional || '',
                 sockets: [], corrupted: false, sanctified: false };
  const ctx = { slug: state.slug, baseName: state.base && state.base.n,
                ilvl: state.ilvl, exceptional: state.exceptional };
  closeStartEdit();
  emStartFrom(item, `your item (${affixes.length} mod${affixes.length === 1 ? '' : 's'})`, ctx);
}

/** Save the current item so a later run can branch or re-roll from this point. */
function emSnapshot() {
  if (!em) return;
  const nMods = em.affixes.filter(a => a.a !== 'c').length;
  emSnaps.push({ id: emSnaps.length + 1,
                 label: `${em.corrupted ? 'corrupted ' : ''}${RNAME[em.rarity]} \u00b7 ${nMods} mod${nMods === 1 ? '' : 's'}`,
                 item: emCopyItem(em),
                 ctx: { slug: state.slug, baseName: state.base && state.base.n,
                        ilvl: state.ilvl, exceptional: state.exceptional } });
  drawEmu();
}

function drawSnaps() {
  const box = document.getElementById('emusnaps');
  if (!box) return;
  if (!emSnaps.length && !mcSampleItems.length) { box.innerHTML = ''; return; }
  const chip = (label, kind, i, sub) =>
    `<span class="snapchip ${kind}"><b>${esc(label)}</b>${sub ? `<span class="snapsub">${esc(sub)}</span>` : ''}
       <button class="snapemu" data-snapemu="${kind}:${i}" title="Emulate from this state">&#9654; emulate</button>${
       kind === 'snap' ? `<button class="snapx" data-snapdel="${i}" title="remove">&times;</button>` : ''}</span>`;
  const snaps = emSnaps.map((sn, i) => chip('#' + sn.id + ' ' + sn.label, 'snap', i)).join('');
  const samples = mcSampleItems.map((sm, i) =>
    chip(sm.tag, 'sample', i, sm.spend + ' spent')).join('');
  box.innerHTML =
    (emSnaps.length ? `<span class="snapk">snapshots</span>${snaps}` : '') +
    (mcSampleItems.length ? `<span class="snapk">from simulation</span>${samples}` : '');
  box.querySelectorAll('[data-snapemu]').forEach(b => b.onclick = () => {
    const [kind, i] = b.dataset.snapemu.split(':');
    if (kind === 'snap') { const sn = emSnaps[+i]; emStartFrom(sn.item, 'snapshot #' + sn.id, sn.ctx); }
    else { const sm = mcSampleItems[+i]; emStartFrom(sm.item, 'a simulated ' + sm.tag + ' outcome (' + sm.spend + ' spent)'); }
  });
  box.querySelectorAll('[data-snapdel]').forEach(b => b.onclick = () => {
    emSnaps.splice(+b.dataset.snapdel, 1); drawEmu();
  });
}

/** Describe what one action did by diffing the item before and after. */
function emDescribe(before, after, label) {
  const key = a => a.g + '|' + a.a + '|' + (a.tier || 0) + '|' + (a.name || '') +
                   '|' + (a.v ? a.v.join(',') : '');
  // multiset diff: what is on `after` that was not on `before`, and vice versa
  const bcount = {};
  before.forEach(a => { const k = key(a); bcount[k] = (bcount[k] || 0) + 1; });
  const added = [];
  after.forEach(a => { const k = key(a); if ((bcount[k] || 0) > 0) bcount[k]--; else added.push(a); });
  const acount = {};
  after.forEach(a => { const k = key(a); acount[k] = (acount[k] || 0) + 1; });
  const removed = [];
  before.forEach(a => { const k = key(a); if ((acount[k] || 0) > 0) acount[k]--; else removed.push(a); });
  const nm = a => a.twice ? 'Twice Corrupted'
    : a.rand ? (a.a === 'c' ? 'a corrupted modifier' : 'a random modifier')
    : modText(a);
  const parts = [];
  added.forEach(a => parts.push('+ ' + nm(a)));
  removed.forEach(a => parts.push('&minus; ' + nm(a)));
  return { label, detail: parts.length ? parts.join(', ') : 'no visible change',
           addedKeys: added.map(a => a.g + '|' + a.a) };
}

/** Value changes between two implicit snapshots, as "old -> new" phrases. */
function emImpDiff(before, after) {
  const parts = [];
  (after || []).forEach((a, i) => {
    const b = before[i];
    if (b && a.v && b.v && a.v.join(',') !== b.v.join(','))
      parts.push(render(a.x, b.v) + ' → ' + render(a.x, a.v));
  });
  return parts;
}

/** Build the transient step object an action needs, honouring an armed omen. */
function emStep(opt) {
  const s = { id: -1, kind: opt.kind, cur: opt.cur, tier: opt.tier || 'I',
              ref: opt.ref || null, targets: [], mode: 'either', omen: '' };
  if (emOmen) {
    const arm = stepOmens(s).some(o => o.i === emOmen);
    if (arm) s.omen = emOmen;
  }
  return s;
}

const emDeepCopy = it => ({ rarity: it.rarity, corrupted: it.corrupted, sanctified: it.sanctified, quality: it.quality, exc: it.exc,
  imp: (it.imp || []).map(a => ({ ...a })),
  socketBonus: it.socketBonus || 0, corruptDid: it.corruptDid || null, lastCorrupt: it.lastCorrupt || null,
  sockets: (it.sockets || []).slice(), affixes: it.affixes.map(a => ({ ...a })) });

/* Hinekora's Lock: roll the next currency on a COPY and show what it WOULD do.
   Commit to keep that exact outcome (and spend the Lock), or Cancel to keep it. */
// A small seeded PRNG so Hinekora's Lock foresight is deterministic per item
// quality: the same quality always shows the same outcome, and changing quality
// (an infuser) re-seeds it - exactly the in-game "quality is the seed" behaviour.
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashStr(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// Seed = quality + which currency + the item itself. Same three => same foresight.
function hinekoraSeed(opt) {
  const q = em.quality != null ? em.quality : 20;
  const sig = em.affixes.map(a => a.g + ':' + a.tier + ':' + ((a.v || []).join(','))).join('|');
  return hashStr(q + '#' + (opt.cur || opt.kind) + '#' + em.rarity + '#' + sig);
}

function emPreview(opt) {
  const s = emStep(opt), D = stepDef(s);
  const copy = emDeepCopy(em);
  const before = em.affixes.map(a => ({ ...a }));
  const lockedBefore = new Set(em.affixes.filter(a => a.fx).map(a => a.g + '|' + a.a));
  let res = 'ok', detail, cur;
  // Freeze the roll to the quality seed for the length of this foresight.
  const rnd0 = Math.random;
  Math.random = mulberry32(hinekoraSeed(opt));
  try {
    if (opt.kind === 'quality') { const b = copy.quality != null ? copy.quality : qCap(copy);
      copy.quality = qCap(copy); detail = `quality ${b}% \u2192 ${copy.quality}%`; cur = opt.cur; }
    else if (opt.kind === 'vaalinfuse') { const b = copy.quality != null ? copy.quality : 20;
      copy.quality = Math.min(30, b + (Math.random() < 0.5 ? 1 : 2));
      detail = `quality ${b}% \u2192 ${copy.quality}%`; cur = opt.cur;
      if (Math.random() < 0.20) { copy.corrupted = true; res = 'corrupt'; detail += ' \u2014 WOULD CORRUPT the item'; } }
    else if (!D) return;
    else {
      res = mcApply(copy, s, D); cur = costKey(s);
      if (res === 'destroyed') detail = 'the item would be DESTROYED';
      else if (opt.kind === 'fracture') { const h = copy.affixes.find(a => a.fx && !lockedBefore.has(a.g + '|' + a.a));
        detail = h ? 'would lock ' + (h.name || h.g) : 'nothing could be locked'; }
      else { const d = emDescribe(before, copy.affixes, ''); detail = d.detail;
        if (opt.kind === 'vaal' || opt.kind === 'architect') { const o = copy.lastCorrupt, tw = opt.kind === 'architect';
          if (o === 'none' || o === 'socket' || o === 'reroll') detail = (tw ? '+ Twice Corrupted \u2014 ' : '') + corruptOutcomeNote(o);
          else if (tw) detail += ' (corruption enchant)'; } }
    }
  } finally { Math.random = rnd0; }
  // the exact modifier the next currency would roll (new or value-changed), so the
  // Foreseen panel can show it on a side-bar with its tier window
  const bkeys = new Set(before.map(a => a.g + '|' + a.a + '|' + (a.v || []).join(',')));
  const rolled = res === 'ok'
    ? copy.affixes.find(a => !a.impl && !bkeys.has(a.g + '|' + a.a + '|' + (a.v || []).join(','))) : null;
  emPend = { kind: 'preview', copy, cur, res, omen: s.omen, seeded: true, rolled,
             icon: opt.icon, curdesc: (D ? D.blurb : '') || curDescOf(opt) || '',
             label: (s.omen ? omenById(s.omen).n + ' + ' : '') + (D ? D.name : opt.label), detail };
  drawEmu();
}
// Tier-window bar for the Foreseen panel — the desecration reveal component, retinted.
function hkTierBar(r) {
  let slot = -1;
  for (let i = 0; i < r.ranges.length; i++) if (r.ranges[i][0] !== r.ranges[i][1]) { slot = i; break; }
  if (slot < 0) return `<div class="wellbar hkbar nobar"><div class="wellfixed">fixed value &middot; no roll range to grade</div></div>`;
  const [lo, hi] = r.ranges[slot], cur = r.cur ? r.cur[slot] : null;
  const pct = cur != null && hi > lo ? Math.max(0, Math.min(100, Math.round((cur - lo) / (hi - lo) * 100))) : 0;
  const where = pct <= 15 ? 'bottom of the window' : pct >= 85 ? 'top of the window' : 'middle of the window';
  return `<div class="wellbar hkbar">
      <div class="wellbarlbl"><span>${lo}</span><span class="wellbark">tier window</span><span>${hi}</span></div>
      <div class="wellbartrack"><i style="width:${pct}%"></i><b style="left:${pct}%"></b></div>
      <div class="wellbarnow">rolled <b>${cur}</b> &middot; ${where}</div></div>`;
}
function emCommitPreview() {
  if (!emPend || emPend.kind !== 'preview') return;
  const p = emPend;
  emHist.push(emSnap());
  em = p.copy;
  if (p.res === 'destroyed') {
    emLog.push({ label: 'Hinekora + ' + p.label, cur: p.cur, hinekora: 1, detail: 'the item was DESTROYED', dead: true });
    em = mcFresh(); em.quality = 20; em.imp = rollImp(state.base);
    emLog.push({ label: '', detail: 'started a fresh base', note: true });
  } else emLog.push({ label: 'Hinekora + ' + p.label, cur: p.cur, omen: p.omen || undefined,
                      hinekora: 1, detail: p.detail, dead: p.res === 'corrupt' });
  emLock = false; emPend = null; emSim = null; emCompare = null;
  drawEmu();
}
function emCancelPreview() {
  if (!emPend || emPend.kind !== 'preview') return;
  const p = emPend;
  // Walking away still SPENDS the Lock — the foresight was the cost. Nothing is
  // applied to the item, but the ~1200 div Lock is tallied and the lock drops;
  // foreseeing again needs a fresh Hinekora's Lock.
  emLog.push({ label: "Hinekora's Lock", hinekora: 1,
               detail: 'foresaw ' + p.label + ' — walked away, nothing applied' });
  emLock = false; emPend = null; emSim = null; emCompare = null;
  drawEmu();
}

function emApply(opt) {
  if (emPend) return;                 // a reveal or essence choice must be resolved first
  if (em.sanctified) return;                    // Sanctified: nothing more can be applied
  if (em.corrupted && opt.kind !== 'architect') return;
  if (opt.kind === 'hinekora') {          // Hinekora's Lock now lives in the rail: arm/disarm
    emLock = !emLock; emPend = null; emSim = null;
    emSweep = emLock;                     // arming plays the foresight sweep once
    drawEmu(); return;
  }
  // A quality change (infuser) is NOT captured by the Lock - it applies and
  // re-seeds the next foresight, so changing quality shows a different outcome.
  if (emLock && opt.kind !== 'essence' && opt.kind !== 'reveal'
      && opt.kind !== 'quality' && opt.kind !== 'vaalinfuse') return emPreview(opt);
  // An essence is chosen before it exists as a step: the rail offers a generic
  // "Essence" with no ref, which stepDef cannot resolve, so the picker has to
  // come first.
  if (opt.kind === 'essence') return emOpenEssence();
  if (opt.kind === 'quality') {
    emHist.push(emSnap());
    const before = em.quality != null ? em.quality : qCap(em);
    em.quality = qCap(em);
    emLog.push({ label: opt.label, cur: opt.cur, detail: `quality ${before}% \u2192 ${em.quality}%` });
    emSim = null; emPend = null; drawEmu();
    return;
  }
  if (opt.kind === 'vaalinfuse') {
    emHist.push(emSnap());
    const before = em.quality != null ? em.quality : 20;
    em.quality = Math.min(30, before + (Math.random() < 0.5 ? 1 : 2));   // +1 or +2%
    // ASSUMPTION: ~20% corruption chance per use - GGG hasn't published the exact rate
    let detail = `quality ${before}% \u2192 ${em.quality}%`, dead = false;
    if (Math.random() < 0.20) { em.corrupted = true; dead = true; detail += ' \u2014 the Vaal corrupted the item'; }
    emLog.push({ label: opt.label, cur: opt.cur, detail, dead });
    emSim = null; emPend = null; drawEmu();
    return;
  }
  const s = emStep(opt), D = stepDef(s);
  if (!D) return;
  if (opt.kind === 'reveal') return emOpenReveal(s, D);

  emHist.push(emSnap());
  const before = em.affixes.map(a => ({ ...a }));
  const impBefore = (em.imp || []).map(a => ({ x: a.x, v: (a.v || []).slice() }));
  const lockedBefore = new Set(em.affixes.filter(a => a.fx).map(a => a.g + '|' + a.a));
  const res = mcApply(em, s, D);
  const label = (s.omen ? omenById(s.omen).n + ' + ' : '') + D.name;
  const cur = costKey(s), omenU = s.omen || undefined;
  if (res === 'destroyed') {
    emLog.push({ label, detail: 'the item was DESTROYED', dead: true, cur, omen: omenU, brick: true });
    em = mcFresh(); em.imp = rollImp(state.base);
    emLog.push({ label: '', detail: 'started a fresh base', note: true });
  } else if (opt.kind === 'fracture') {
    // locking changes no modifier, so a plain diff would report nothing
    const hit = em.affixes.find(a => a.fx && !lockedBefore.has(a.g + '|' + a.a));
    emLog.push({ label, cur, omen: omenU, detail: hit ? 'locked ' + (hit.name || hit.g) : 'nothing could be locked' });
    emFlash = hit ? [hit.g + '|' + hit.a] : [];
  } else {
    const d = emDescribe(before, em.affixes, label);
    d.cur = cur; d.omen = omenU;
    // a corruption's real outcome is often invisible to a before/after diff
    // (a socket, a value reroll, or nothing at all): state it outright, exactly
    // as the Vaal Orb's outcomes are already shown.
    if (opt.kind === 'vaal' || opt.kind === 'architect') {
      const o = em.lastCorrupt, twice = opt.kind === 'architect';
      if (o === 'none' || o === 'socket' || o === 'reroll')
        d.detail = (twice ? '+ Twice Corrupted \u2014 ' : '') + corruptOutcomeNote(o);
      else if (twice)
        d.detail += ' (corruption enchant)';  // the diff already names the implicit
    }
    // Divine (and Omen of the Blessed) can shift implicit values; surface them,
    // since the explicit diff alone would read "no visible change" for a Blessed.
    if (opt.kind === 'divine') {
      const ic = emImpDiff(impBefore, em.imp || []);
      if (ic.length) {
        const impTxt = 'implicit ' + ic.join(', ');
        d.detail = (d.detail && d.detail !== 'no visible change')
          ? d.detail + ' · ' + impTxt : impTxt;
      }
    }
    emLog.push(d);
    emFlash = d.addedKeys || [];
  }
  // remember this action for "reuse last" (R) and macro recording
  if (res !== 'destroyed') {
    emLast = { opt: { ...opt }, omen: s.omen || '' };
    if (emRecording && bulkable(opt.kind)) emMacro.push({ opt: { ...opt }, omen: s.omen || '', n: 1 });
  }
  if (s.omen) emOmen = '';            // an omen is consumed on use
  emPend = null; emSim = null;
  drawEmu();
}

/** Reuse the last currency (keyboard R / Cmd+D): re-arm its omen if still valid. */
function emReuse() {
  if (!emLast || !em || em.corrupted || em.sanctified || emPend) return;
  if (!optLegal(emLast.opt)) return;
  if (emLast.omen) {
    const probe = { kind: emLast.opt.kind, cur: emLast.opt.cur,
                    tier: emLast.opt.tier || 'I', ref: emLast.opt.ref };
    if (stepOmens(probe).some(o => o.i === emLast.omen)) emOmen = emLast.omen;
  }
  emApply(emLast.opt);
}

/** Apply one currency n times as a SINGLE undo/log unit (shift-click a currency,
 *  or the bulk-count chips). Stops early if the item can no longer take it. */
function emBulk(opt, n) {
  if (!em || emPend || em.corrupted || em.sanctified) return;
  if (!bulkable(opt.kind) || n <= 1) return emApply(opt);
  emHist.push(emSnap());
  const before = em.affixes.map(a => ({ ...a }));
  const s0 = emStep(opt);                       // resolves the armed omen (first use only)
  const cur = costKey(s0), usedOmen = s0.omen || '';
  let done = 0, destroyed = false;
  for (let i = 0; i < n; i++) {
    if (em.corrupted || em.sanctified || !optLegal(opt)) break;
    const s = i === 0 ? s0 : emStep(opt), D = stepDef(s);
    if (!D) break;
    const res = mcApply(em, s, D);
    if (s.omen) emOmen = '';
    if (res === 'destroyed') { em = mcFresh(); em.imp = rollImp(state.base); done++; destroyed = true; break; }
    if (res === 'dead') break;
    done++;
  }
  if (!done) { emHist.pop(); return; }
  const d = emDescribe(before, em.affixes, opt.label + ' ×' + done);
  d.cur = cur; d.count = done; d.omen = usedOmen || undefined;
  if (destroyed) { d.detail += ' — item DESTROYED, restarted'; d.brick = true; }
  emLog.push(d);
  emLast = { opt: { ...opt }, omen: usedOmen };
  if (emRecording) emMacro.push({ opt: { ...opt }, omen: usedOmen, n: done });
  emFlash = d.addedKeys || [];
  emPend = null; emSim = null; drawEmu();
}

/** Replay the recorded rotation k full loops, as one undo/log unit. Stops the
 *  moment a step becomes illegal (e.g. Transmutation once the item is Magic). */
function emRunMacro(k) {
  if (!emMacro.length || !em || emPend || em.corrupted || em.sanctified) return;
  emHist.push(emSnap());
  const before = em.affixes.map(a => ({ ...a }));
  const costs = {};
  let loops = 0;
  loop: for (let r = 0; r < k; r++) {
    for (const ent of emMacro) {
      for (let i = 0; i < (ent.n || 1); i++) {
        if (em.corrupted || em.sanctified || !optLegal(ent.opt)) break loop;
        if (i === 0 && ent.omen) {
          const probe = { kind: ent.opt.kind, cur: ent.opt.cur,
                          tier: ent.opt.tier || 'I', ref: ent.opt.ref };
          if (stepOmens(probe).some(o => o.i === ent.omen)) emOmen = ent.omen;
        }
        const s = emStep(ent.opt), D = stepDef(s);
        if (!D) break loop;
        const om = s.omen, key = costKey(s);
        const res = mcApply(em, s, D);
        if (s.omen) emOmen = '';
        costs[key] = (costs[key] || 0) + 1;
        if (om) costs['omen:' + om] = (costs['omen:' + om] || 0) + 1;
        if (res === 'destroyed') { em = mcFresh(); em.imp = rollImp(state.base); break loop; }
        if (res === 'dead') break loop;
      }
    }
    loops++;
  }
  if (!Object.keys(costs).length) { emHist.pop(); return; }
  const names = emMacro.map(e => e.opt.label.replace(/^Orb of /, '') + (e.n > 1 ? '×' + e.n : '')).join(' → ');
  const d = emDescribe(before, em.affixes, `Macro ×${loops} (${names})`);
  d.costs = costs;
  emLog.push(d);
  emLast = null; emSim = null; emPend = null; drawEmu();
}

/** Draw three distinct candidates from a reveal pool. */
function emDrawReveal(c) {
  const opts = [];
  for (let g = 0; opts.length < REVEAL_OPTS && g < REVEAL_OPTS * 20; g++) {
    const e = mcRoll(c);
    if (e && !opts.some(o => o.e.m.g === e.m.g && o.e.m.a === e.m.a))
      opts.push({ e, v: rollVals(e.t[2]) });      // rolled up front, as the game shows them
  }
  return opts;
}

/**
 * A reveal resolves the unrevealed modifier once - it cannot be spammed. Arming
 * Omen of Abyssal Echoes BEFORE the reveal buys exactly one reroll of the three
 * candidates; the omen is spent the instant the reveal happens, whether or not
 * the reroll is used, and then one of the shown options must be kept. To try
 * again you have to Annul the desecrated modifier off (guaranteed with Omen of
 * Light) and desecrate afresh.
 */
function emOpenReveal(s, D) {
  const idx = em.affixes.findIndex(a => a.un);
  if (idx < 0) return;
  const held = em.affixes[idx];
  const c = revealCandidates(em, held);
  if (!c.tot) return;
  const echoOmen = (emOmen && omenFx(omenById(emOmen)) === 'reroll') ? emOmen : '';
  if (echoOmen) emOmen = '';          // Abyssal Echoes is consumed on the reveal
  emPend = { kind: 'reveal', idx, opts: emDrawReveal(c), omened: c.omened,
             cand: c, echo: !!echoOmen, rerolled: false, echoOmen };
  drawEmu();
}

/** Spend the one Abyssal Echoes reroll: a fresh, independent set of three. */
function emRerollReveal() {
  if (!emPend || emPend.kind !== 'reveal' || !emPend.echo || emPend.rerolled) return;
  emPend.opts = emDrawReveal(emPend.cand);
  emPend.rerolled = true;
  drawEmu();
}
function emTakeReveal(j) {
  const { idx, opts } = emPend, { e, v } = opts[j];
  emHist.push(emSnap());
  const before = em.affixes.map(a => ({ ...a }));
  em.affixes[idx] = { id: e.m.i, g: e.m.g, a: e.m.a, tier: e.t[0], name: e.m.n,
                      ml: e.t[1], cat: 'desecrated', g2: e.m.g2, x: e.m.x, v,
                      tname: e.t[4] || null };
  const d = emDescribe(before, em.affixes, 'Reveal Desecrated');
  d.cur = 'reveal'; if (emPend.echoOmen) d.omen = emPend.echoOmen;
  emLog.push(d); emFlash = d.addedKeys || [];
  emPend = null;
  drawEmu();
}
function emCloseReveal() {           // back out without revealing (keeps the unrevealed mod)
  if (emPend && emPend.kind === 'reveal') { emPend = null; drawEmu(); }
}
/** Jump straight into the reveal from the "Well of Souls" instruction link. */
function emGoReveal() {
  if (!em || emPend) return;
  const opt = optionsFor(em, true).find(o => o.kind === 'reveal');
  if (opt) emApply(opt);
}

/**
 * The Well of Souls: the one-shot desecrated reveal as a full takeover. Three
 * candidate slabs, pool-coloured (acid = actually desecrated, blue = an ordinary
 * mod a bone can also surface). The tier-window bar branches — a fixed modifier
 * has no roll to grade, so it shows no bar (a full bar would say the opposite).
 */
function drawWell() {
  const well = document.getElementById('well');
  if (!emPend || emPend.kind !== 'reveal') { well.classList.add('hidden'); return; }
  if (emPend.sel == null) emPend.sel = 0;
  const isDes = m => m.i && String(m.i).indexOf('des:') === 0;
  const held = em.affixes[emPend.idx];
  const sideWord = held && held.a === 'p' ? 'Prefix' : 'Suffix';
  const itemName = (state.base && state.base.n) || BASES[state.slug].ic || state.slug;
  const slabs = emPend.opts.map((o, j) => {
    const des = isDes(o.e.m);
    const lich = des ? (LICHNAME[(o.e.m.g2 || []).find(x => /_mod$/.test(x)) || ''] || '') : '';
    const ranges = o.e.t[2] || [];
    const hasWindow = ranges.some(r => r[0] !== r[1]);
    const li = ranges.length - 1;
    const lo = ranges[li] ? ranges[li][0] : 0, hi = ranges[li] ? ranges[li][1] : 0, cur = o.v[li];
    const pct = hi > lo ? Math.max(0, Math.min(100, Math.round((cur - lo) / (hi - lo) * 100))) : 0;
    const where = pct >= 67 ? 'upper third of the window' : pct >= 34 ? 'middle of the window' : 'lower third of the window';
    const bar = hasWindow
      ? `<div class="wellbar">
           <div class="wellbarlbl"><span>${lo}</span><span class="wellbark">tier window</span><span>${hi}</span></div>
           <div class="wellbartrack"><i style="width:${pct}%"></i><b style="left:${pct}%"></b></div>
           <div class="wellbarnow">rolled <b>${cur}</b> &middot; ${where}</div>
         </div>`
      : `<div class="wellbar nobar"><div class="wellfixed">fixed value &middot; no roll range to grade</div></div>`;
    return `<button class="wellslab ${des ? 'des' : 'norm'}${emPend.sel === j ? ' sel' : ''}" data-rev="${j}">
      <div class="wellhdr">
        <span class="wellpool ${des ? 'des' : 'norm'}">${des ? 'desecrated' : 'normal'}</span>
        <span class="welllich">${des ? esc(lich || '—') : '&mdash;'}</span>
        <span class="welltier">T${o.e.t[0]}</span>
      </div>
      <div class="wellmodwrap"><div class="wellmod ${des ? 'des' : 'norm'}">${esc(render(o.e.m.x, o.v))}</div></div>
      ${bar}
      <div class="wellfoot">
        <div class="wellconseq"><span>${sideWord} slot</span><b>${des ? 'desecrated' : 'ordinary'}</b></div>
        <div class="wellnote">${des
          ? 'A genuinely desecrated modifier &mdash; acid green means desecrated, nothing else.'
          : 'An ordinary modifier, surfaced because no faction omen was spent.'}</div>
      </div>
    </button>`;
  }).join('');
  const reroll = emPend.echo
    ? (emPend.rerolled
        ? '<span class="wellreroll spent">&#10003; Abyssal Echoes reroll spent &mdash; keep one</span>'
        : '<button class="wellreroll" data-wellreroll>&#8635; Reroll once &middot; Abyssal Echoes</button>')
    : '<span class="wellreroll note">one reveal, no retry &mdash; Annul it off to try again</span>';
  well.innerHTML = `<div class="wellbg"></div><div class="wellbloom"></div>
    <div class="wellbox">
      <div class="wellhead">
        <div><div class="welltitle">The Well of Souls</div>
          <div class="wellsub">one modifier resolves, once &mdash; three candidates, keep one</div></div>
        <span class="wellchip">${esc(itemName)} &middot; ${sideWord} slot</span>
        <button class="wellx" data-wellclose title="back out (keeps it unrevealed)">&times;</button>
      </div>
      <div class="wellslabs">${slabs}</div>
      <div class="wellactions">${reroll}
        <button class="wellconfirm" data-wellconfirm>Confirm</button></div>
    </div>`;
  well.classList.remove('hidden');
  well.querySelectorAll('[data-rev]').forEach(b => b.onclick = () => { emPend.sel = +b.dataset.rev; drawWell(); });
  const cf = well.querySelector('[data-wellconfirm]'); if (cf) cf.onclick = () => emTakeReveal(emPend.sel);
  const rr = well.querySelector('[data-wellreroll]'); if (rr) rr.onclick = emRerollReveal;
  const xb = well.querySelector('[data-wellclose]'); if (xb) xb.onclick = emCloseReveal;
  well.querySelector('.wellbg').onclick = emCloseReveal;
}

/** An essence: pick which one, then apply it. */
function emOpenEssence() {
  const o = emOmen ? omenById(emOmen) : null;
  const side = omenFx(o) === 'essside' ? ESSSIDE[o.c] : null;
  const rows = ESS.filter(e => {
    if (!e.c.includes(state.slug) || e.rl > state.ilvl) return false;
    const needRare = e.ti === 'perfect' || e.ti === 'special';
    if (countCat(em.affixes, 'crafted') >= maxCrafted()) return false;
    if (!(needRare ? em.rarity === 'rare' : em.rarity === 'magic')) return false;
    if (em.affixes.some(a => a.g === e.g && a.a === e.a)) return false;
    // The Abyss essence's side is chosen by the Crystallisation omen; both variants
    // otherwise show so the side can be picked directly. Ordinary perfect essences
    // are still filtered to the omen's side when one is armed.
    if (isAbyssEss(e)) {
      // cannot apply while any desecrated modifier is already present
      if (em.affixes.some(a => a.cat === 'desecrated' || a.un || a.mark)) return false;
      const ms = side || e.a;
      if (side && e.a !== side) return false;      // keep just the matching variant
      return em.affixes.some(a => !a.fx && !a.un && a.a === ms);
    }
    if (side && !(needRare && e.a === side)) return false;
    // perfect essences replace; lesser/greater need an open slot on their side
    if (isPerfectEss(e)) return essReplacePool(em.affixes, e.a, side === e.a ? side : null).length > 0;
    return em.affixes.length < effLimit('total') &&
           em.affixes.filter(a => a.a === e.a).length < effLimit(e.a);
  });
  emPend = { kind: 'essence', rows, side,
             full: em.affixes.length >= effLimit('total'),
             hasDesec: em.affixes.some(a => a.cat === 'desecrated' || a.un || a.mark) };
  drawEmu();
}
function emTakeEssence(id) {
  const cryst = emOmen && omenFx(omenById(emOmen)) === 'essside' ? emOmen : '';
  const s = { id: -1, kind: 'essence', ref: id, tier: 'I', targets: [], omen: cryst };
  const D = stepDef(s);
  emHist.push(emSnap());
  const before = em.affixes.map(a => ({ ...a }));
  const lbl = (emOmen && omenFx(omenById(emOmen)) === 'essside'
    ? omenById(emOmen).n + ' + ' : '') + D.name;
  mcApply(em, s, D);
  const d = emDescribe(before, em.affixes, lbl);
  d.cur = costKey(s); if (s.omen) d.omen = s.omen;
  emLog.push(d);
  emFlash = d.addedKeys || [];
  if (emOmen && omenFx(omenById(emOmen)) === 'essside') emOmen = '';   // consumed
  emPend = null;
  drawEmu();
}

/* Give up on this item, buy a fresh base, and keep counting: the whole current
   attempt (base + currencies + omens + bricks) is banked as sunk cost, then a new
   base of the same kind is started and re-priced. The classic fracture-strat loop. */
function emRestartKeepCost() {
  if (!em) return;
  const t = emTally();
  for (const k in t.use) emSunk[k] = (emSunk[k] || 0) + t.use[k];
  const exc = em.exc;
  em = mcFresh(); em.exc = exc; em.quality = 20;   // same base type, standard 20% quality
  emHist = []; emLog = []; emOmen = ''; emPend = null; emSim = null; emCompare = null;
  emLog.push({ label: '', note: true,
               detail: 'new base \u2014 ' + fmtDiv(t.grandDiv) + ' div carried over' });
  drawEmu();
}
function emUndo() {
  if (!emHist.length) return;
  const snap = emHist.pop();
  // the attempts being undone were really spent - bank them as sunk cost so the
  // "undo, try again until it hits" loop reflects the true price of the strat
  for (const e of emLog.slice(snap.log)) {
    if (e.cur) emSunk[e.cur] = (emSunk[e.cur] || 0) + 1;
    if (e.omen) { const k = 'omen:' + e.omen; emSunk[k] = (emSunk[k] || 0) + 1; }
    if (e.hinekora) emSunk.hinekora = (emSunk.hinekora || 0) + e.hinekora;   // a spent Lock is not refunded
    if (e.brick) emSunk.base = (emSunk.base || 0) + 1;
  }
  em = { rarity: snap.rarity, corrupted: snap.corrupted, sanctified: snap.sanctified, quality: snap.quality, exc: snap.exc,
         sockets: (snap.sockets || []).slice(), imp: (snap.imp || []).map(a => ({ ...a })),
         affixes: snap.affixes.map(a => ({ ...a })) };
  emLog = emLog.slice(0, snap.log);
  emPend = null; emSim = null;
  emCompare = null;                    // the tally comparison no longer applies
  drawEmu();
}

/* Roll the emulator's log up into a currency count: the starting base, one of
   each currency spent, and a fresh base for every item that bricked. Derived
   from emLog so Undo corrects it for free. */
function emTally() {
  const use = { base: 1 };
  const bump = (k, v = 1) => { if (k) use[k] = (use[k] || 0) + v; };
  let bricks = 0;
  for (const e of emLog) {
    if (e.costs) { for (const k in e.costs) bump(k, e.costs[k]); }   // a macro run
    else { bump(e.cur, e.count || 1); if (e.omen) bump('omen:' + e.omen); }
    if (e.hinekora) bump('hinekora');
    if (e.brick) { bricks++; bump('base'); }
  }
  const total = Object.keys(use).reduce((a, k) => a + (k === 'base' ? 0 : use[k]), 0);
  const priceOf = k => (k === 'base' && emBaseCost != null) ? emBaseCost : curDiv(k);
  const div = Object.keys(use).reduce((a, k) => a + use[k] * priceOf(k), 0);
  const sunkDiv = Object.keys(emSunk).reduce((a, k) => a + emSunk[k] * priceOf(k), 0);
  const sunkTotal = Object.keys(emSunk).reduce((a, k) => a + (k === 'base' ? 0 : emSunk[k]), 0);
  return { use, bricks, total, div, sunk: emSunk, sunkDiv, sunkTotal,
           grandDiv: div + sunkDiv, grandTotal: total + sunkTotal };
}

const RGROUP = (g, a) => { const m = MODS.find(x => x.g === g && x.a === a)
  || DES.find(x => x.g === g && x.a === a) || COR.find(x => x.g === g)
  || SBMODS_ALL.find(x => x.g === g); return m ? m.n : g; };
function simLabel(k) {
  const i = k.indexOf(':');
  if (i > 0) { const pre = k.slice(0, i), key = k.slice(i + 1), [g, a] = key.split('|');
    return (pre === 'lock' ? 'lock ' : pre === 'add' ? '+ ' : '\u2212 ') + RGROUP(g, a); }
  return { none: 'no change', gain: '+ corrupted mod', reroll: 'reroll values', socket: '+1 socket',
    destroyed: 'item DESTROYED', change: 'values changed' }[k] || k;
}
/* Run one currency N times on the live item and tally what happens - the fracture
   example: "1 in 3 locks the mod you want, ~30 div to land". Uses the armed omen. */
function emSimStep(opt, n) {
  const s0 = emStep(opt), D = stepDef(s0); if (!D) return null;
  const tally = {}; const bump = k => { tally[k] = (tally[k] || 0) + 1; };
  let dead = 0;
  const stepDiv = curDiv(costKey(s0)) + (s0.omen ? curDiv('omen:' + s0.omen) : 0);
  for (let i = 0; i < n; i++) {
    const it = { rarity: em.rarity, corrupted: em.corrupted, sanctified: em.sanctified, socketBonus: em.socketBonus || 0,
                 sockets: (em.sockets || []).slice(), affixes: em.affixes.map(a => ({ ...a })) };
    const s = emStep(opt);
    const lockBefore = new Set(it.affixes.filter(a => a.fx).map(a => a.g + '|' + a.a));
    const before = it.affixes.map(a => a.g + '|' + a.a);
    const res = mcApply(it, s, D);
    if (res === 'dead') { dead++; continue; }
    if (res === 'destroyed') { bump('destroyed'); continue; }
    if (opt.kind === 'fracture') {
      const h = it.affixes.find(a => a.fx && !lockBefore.has(a.g + '|' + a.a));
      bump(h ? 'lock:' + h.g + '|' + h.a : 'none');
    } else if (opt.kind === 'vaal' || opt.kind === 'architect') {
      bump(it.lastCorrupt || 'gain');
    } else {
      const added = it.affixes.map(a => a.g + '|' + a.a).filter(k => !before.includes(k));
      bump(added.length ? 'add:' + added[0] : 'change');
    }
  }
  return { n, dead, tally, stepDiv,
           label: (s0.omen ? omenById(s0.omen).n + ' + ' : '') + D.name };
}
function renderSim(r) {
  if (!r) return '';
  // Show every outcome that occurred, not just the top few - the mods players
  // most want (attack speed, crit, +levels) are low-weight and would be cut off.
  const all = Object.entries(r.tally).sort((a, b) => b[1] - a[1]);
  const CAP = 40;
  const rows = all.slice(0, CAP);
  const hidden = all.length - rows.length;
  return `<div class="emsimres"><div class="emsimn">${r.n} runs of ${esc(r.label)}${
      r.dead ? ` \u00b7 ${r.dead} could not apply` : ''}${
      r.stepDiv ? ` \u00b7 ${fmtDiv(r.stepDiv)} div/try` : ''}</div>` +
    `<div class="emsimlist">` + rows.map(([k, c]) => {
      const p = c / r.n, pct = (100 * p).toFixed(1);
      const land = p && r.stepDiv ? ` \u00b7 &asymp;${fmtDiv(r.stepDiv / p)} div to land` : '';
      const one = p ? ` \u00b7 1 in ${(1 / p).toFixed(p < 0.1 ? 0 : 1)}` : '';
      return `<div class="emsimrow"><span class="emsimpct">${pct}%</span>
        <span class="emsimk">${esc(simLabel(k))}</span><span class="emsimc">${one}${land}</span></div>`;
    }).join('') + `</div>` +
    (hidden > 0 ? `<div class="emsimmore">+ ${hidden} rarer outcome${hidden === 1 ? '' : 's'} not shown</div>` : '') +
    `</div>`;
}

/* Where this run's total currency spend falls in the current plan's Monte Carlo
   distribution. The emulator is freeform, so this reads the plan as the goal the
   run was aiming at; it is a rough compass, not a verdict, and says so. */
function emRunCompare() {
  const { grandTotal: total, grandDiv: div } = emTally();
  if (!plan.length) return { total, div, mc: null, why: 'no-plan' };
  const untargeted = plan.filter(x =>
    (x.kind === 'orb' || x.kind === 'bone') && !x.targets.length).length;
  if (untargeted) return { total, div, mc: null, why: 'untargeted' };
  const mc = runMC(2500, plan, emBaseCost);
  if (!mc.ok) return { total, div, mc: null, why: 'never-finishes' };
  let below = 0; for (const v of mc.spends) if (v <= total) below++;
  const pct = below / mc.spends.length;
  let cbelow = 0; for (const c of mc.costs) if (c <= div) cbelow++;
  const costPct = mc.costs.length ? cbelow / mc.costs.length : 0;
  const varr = mc.spends.reduce((a, v) => a + (v - mc.mean) * (v - mc.mean), 0) / mc.spends.length;
  const sd = Math.sqrt(varr);
  const cvar = mc.costs.reduce((a, c) => a + (c - mc.costMean) * (c - mc.costMean), 0) / mc.costs.length;
  const costSd = Math.sqrt(cvar);
  return { total, div, mc, pct, sd, z: sd ? (total - mc.mean) / sd : 0,
           costPct, costSd, costZ: costSd ? (div - mc.costMean) / costSd : 0 };
}

function drawTally() {
  const box = document.getElementById('emutally');
  if (!box || !em) return;
  const { use, bricks, total, div, sunkDiv, sunkTotal, grandDiv } = emTally();
  if (total === 0 && bricks === 0) { box.innerHTML = ''; return; }

  // order the rows by divine value where known, otherwise by count
  const keys = Object.keys(use).filter(k => k !== 'base' && use[k] > 0)
    .sort((a, b) => (use[b] * curDiv(b)) - (use[a] * curDiv(a)) || use[b] - use[a]);
  const rows = keys.map(k =>
    `<div class="tlyrow"><span class="tlyn">${use[k]}&times;</span>
       <span class="tlyk">${esc(costLabel(k))}</span>
       <span class="tlyd">${curDiv(k) ? fmtDiv(use[k] * curDiv(k)) + ' div' : ''}</span></div>`).join('');
  const finished = em.corrupted || em.sanctified;
  const cmp = emCompare;
  let cmpHtml = '';
  if (cmp) {
    if (!cmp.mc) {
      const msg = cmp.why === 'no-plan'
          ? 'Build a targeted plan in the graph, then compare this run against its simulation.'
        : cmp.why === 'untargeted'
          ? 'Give every orb/bone step a target in the plan to enable the comparison.'
          : 'The current plan almost never finishes, so there is no distribution to compare against.';
      cmpHtml = `<div class="tlynote">${msg}</div>`;
    } else {
      const m = cmp.mc, pctMore = Math.round((1 - cmp.pct) * 100);
      const verdict = Math.abs(cmp.z) < 0.5
          ? `about average &mdash; this run sat near the middle of the distribution`
        : cmp.total < m.median
          ? (pctMore >= 99 ? `a very lucky run &mdash; cheaper than almost every simulated attempt`
                           : `a lucky run &mdash; cheaper than ${pctMore}% of simulated attempts`)
          : (pctMore <= 1 ? `a very expensive run &mdash; almost every attempt came in cheaper`
                          : `an expensive run &mdash; ${100 - pctMore}% of attempts came in cheaper`);
      const cPricier = Math.round((1 - cmp.costPct) * 100);   // % of runs pricier than yours
      const costVerdict = Math.abs(cmp.costZ) < 0.5 ? 'an average-cost run in divines'
        : cmp.div < m.costMedian
          ? (cPricier >= 99 ? 'a very cheap run in divines' : `cheaper in divines than ${cPricier}% of runs`)
          : (cPricier <= 1 ? 'a very expensive run in divines' : `pricier in divines than ${100 - cPricier}% of runs`);
      cmpHtml = `<div class="tlycmp">
        <div class="tlycmph">This run vs simulation
          <span data-tipname="How this is made" data-tip="A robot plays your current plan ${m.trials} times from scratch - rolling, missing, retrying, bricking - and records what each full attempt cost. These numbers describe that pile of ${m.trials} runs. Hover any number.">${m.trials.toLocaleString()} trials of the current plan</span></div>
        <div class="tlycmpg">
          <div data-tipname="Your spend" data-tip="How many currency items your real run used - every orb, omen, bone and essence counts as one.">
            <b>${cmp.total}</b><span>your spend</span></div>
          <div data-tipname="Median (items)" data-tip="The middle run: line up all ${m.trials} simulated runs by item count; half used fewer, half used more. The typical count.">
            <b>${m.median}</b><span>median</span></div>
          <div data-tipname="Mean (items)" data-tip="The plain average item count across all runs. It sits above the median because a few unlucky runs use a lot.">
            <b>${m.mean.toFixed(1)}</b><span>mean</span></div>
          <div data-tipname="Std dev (items)" data-tip="How much the item count swings from run to run. Bigger = more of a gamble.">
            <b>&plusmn;${cmp.sd.toFixed(1)}</b><span>std dev</span></div>
        </div>
        <div class="tlycmpsub">cost in divines &mdash; the variance that matters</div>
        <div class="tlycmpg">
          <div data-tipname="Your cost" data-tip="What your run cost in divines - every currency priced from the Currency tab, including undone retries and the base.">
            <b>&asymp;${fmtDiv(cmp.div)}</b><span>your cost</span></div>
          <div data-tipname="Median cost" data-tip="The middle run's divine cost: half of simulated runs cost less, half cost more. The typical price to expect.">
            <b>${fmtDiv(m.costMedian)}</b><span>median</span></div>
          <div data-tipname="Mean cost" data-tip="The average divine cost. It sits above the median because rare, very unlucky runs cost a fortune and drag the average up.">
            <b>${fmtDiv(m.costMean)}</b><span>mean</span></div>
          <div data-tipname="Std dev (cost)" data-tip="How wildly the divine cost swings from run to run. A big number means feast or famine - some cheap, some brutal.">
            <b>&plusmn;${fmtDiv(cmp.costSd)}</b><span>std dev</span></div>
        </div>
        <div class="tlyverdict ${cmp.div < m.costMedian ? 'good' : Math.abs(cmp.costZ) < 0.5 ? '' : 'bad'}">${costVerdict}.</div>
        <div class="tlynote"><span class="tlyhint" data-tipname="p10 to p90 (normal range)" data-tip="The normal range: 10% of runs were cheaper than the low number, 10% pricier than the high number, and the middle 80% landed in between.">cost p10&ndash;p90 ${fmtDiv(m.costP10)}&ndash;${fmtDiv(m.costP90)} div</span> &middot;
          <span class="tlyhint" data-tipname="Sigma from the mean" data-tip="Sigma is the swing (std dev) used as a ruler. This says how many rulers your run sat from the average. Minus = cheaper than average; within about 1 ruler is a normal roll of the dice.">your run is ${(cmp.costZ >= 0 ? '+' : '') + cmp.costZ.toFixed(1)}&sigma; from the mean</span> &middot; spend ${cmp.total} vs median ${m.median} items${
          m.meanBricks > 0.05 ? ' &middot; ' + m.meanBricks.toFixed(1) + ' bricks/goal' : ''}<br>
          Reads the current plan as the goal &mdash; a rough compass if this run followed a different path.</div>
      </div>`;
    }
  }
  box.innerHTML = `<div class="tlyhead">Currency used
      <span class="tlysum">${total} item${total === 1 ? '' : 's'} &middot; &asymp; ${fmtDiv(div)} div${
        bricks ? ' &middot; ' + bricks + ' brick' + (bricks === 1 ? '' : 's') : ''}</span></div>
    <label class="tlybase">Base item cost
      <input type="number" id="embasecost" min="0" step="0.1"
        value="${emBaseCost != null ? emBaseCost : (curDiv('base') || 0)}"> div
      <span class="tlybasenote">counted once at the start${bricks ? ' + per brick' : ''}</span></label>
    <div class="tlygrid">${rows || '<span class="tlynote">nothing spent yet</span>'}</div>
    ${sunkDiv > 0 ? `<div class="tlyretry">&#8630; ${fmtDiv(sunkDiv)} div sunk in ${sunkTotal} undone
        attempt${sunkTotal === 1 ? '' : 's'} &nbsp;&rarr;&nbsp; <b>true cost &asymp; ${fmtDiv(grandDiv)} div</b>
        <button class="tlyclear" id="emuclearsunk">reset retries</button></div>` : ''}
    <button class="ghost tlybtn" id="emucmp">${finished ? '&#9654; ' : '&#8635; '}${
      cmp ? 'Recompute vs simulation' : 'Compare vs simulation'}</button>
    ${cmpHtml}`;
  const btn = document.getElementById('emucmp');
  if (btn) btn.onclick = () => { emCompare = emRunCompare(); drawEmu(); };
  const cs = document.getElementById('emuclearsunk');
  if (cs) cs.onclick = () => { emSunk = {}; emCompare = null; drawEmu(); };
  const bc = document.getElementById('embasecost');
  if (bc) bc.oninput = () => { const v = parseFloat(bc.value);
    emBaseCost = isFinite(v) && v >= 0 ? v : 0; emCompare = null; drawEmu(); };
}

function drawEmu() {
  if (!em) return;
  const rc = em.sanctified ? 'var(--accent)' : em.corrupted ? 'var(--brick)'
    : em.rarity === 'rare' ? 'var(--rare)' : em.rarity === 'magic' ? 'var(--magic)' : 'var(--ink)';
  const sk = maxSockets(em);
  const sockets = sk > 0
    ? `<span class="emusock" title="${sk} socket${sk === 1 ? '' : 's'}">${
        '\u25c8'.repeat(sk)}</span>` : '';
  const _bart = baseArt();
  document.getElementById('emuname').innerHTML =
    `${_bart ? `<div class="emuartbig"><img src="${esc(_bart)}" alt="" loading="lazy"></div>` : ''}
     <div class="emubanner">
       <span class="emuiname" style="color:${rc}">${esc((state.base && state.base.n) || BASES[state.slug].ic || state.slug)}</span>
       <span class="emurar">${em.sanctified ? 'Sanctified ' : em.corrupted ? 'Corrupted ' : ''}${RNAME[em.rarity]}
         &middot; ilvl ${state.ilvl} ${sockets}</span>
     </div>`;

  // a stable reading order: prefixes, then suffixes, then the corrupted lines.
  // Without this a Chaos Orb looks like it rewrote the whole item when it only
  // swapped one line and the list resequenced underneath.
  const rank = a => a.a === 'p' ? 0 : a.a === 's' ? 1 : 2;
  const ordered = em.affixes.map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map(x => x.a);
  const tgt = emOmenTargets(em, emOmen);
  TIP_REG = []; EMU_RENDER = true;                  // collect hover ranges for this render
  dispScale = magnitudeScaler(em).scaleOf;          // show magnitude-boosted values on the lines
  const hkOn = emLock && !em.corrupted && !em.sanctified;   // Hinekora armed: foresight state
  hkWin = hkOn;                                     // grow each numeric mod's roll window
  const mods = ordered.length
    ? ordered.map(a => {
        const key = a.g + '|' + a.a;
        const cls = (emFlash.includes(key) ? ' flash' : '') + (tgt.keys.has(key) ? ' omtarget' : '');
        return cls ? modLine(a).replace('class="m', 'class="m' + cls) : modLine(a);
      }).join('')
    : '<div class="m ghost">a bare base &mdash; no modifiers yet</div>';
  // implicit modifiers sit above the explicit block, separated by a rule (as in game)
  const implCls = 'm impl' + (tgt.impl ? ' omtarget' : '');
  const implHTML = (em.imp && em.imp.length)
    ? em.imp.map(im => `<div class="${implCls}"${tipAttr(im)} title="implicit modifier (from the base item)">${esc(modText(im))}</div>`).join('')
      + '<div class="implrule"></div>'
    : '';
  EMU_RENDER = false; dispScale = null; hkWin = false;
  // the game's own instruction when an unrevealed desecrated modifier is present.
  // "Well of Souls" is a live shortcut straight into the reveal.
  const echoArmed = emOmen && omenFx(omenById(emOmen)) === 'reroll';
  const unrevHint = em.affixes.some(a => a.un)
    ? `<div class="revealhint">
        <div>Take this item to the <button class="wellbtn" data-wellgo
            title="open the reveal">Well of Souls</button> to reveal the
          <span class="desecword">Desecrated Modifier</span></div>
        <div class="revealtip${echoArmed ? ' armed' : ''}">${echoArmed
          ? '&#9679; Omen of Abyssal Echoes armed &mdash; you&rsquo;ll get one reroll of the three'
          : 'Tip: arm <b>Omen of Abyssal Echoes</b> first for one reroll of the three candidates'}</div>
      </div>` : '';
  document.getElementById('emumods').innerHTML = implHTML + mods + unrevHint;
  const wgo = document.querySelector('#emumods [data-wellgo]');
  if (wgo) wgo.onclick = emGoReveal;

  // Hinekora foresight: magenta glow on the item, the sigil + lock text at the foot,
  // and — only on the draw that armed it — the one-shot sweep animation.
  const playSweep = emSweep && hkOn; emSweep = false;
  const item = document.querySelector('.emuitem');
  item.classList.toggle('hklock', hkOn);
  item.classList.toggle('hksweep', playSweep);
  const sweep = document.getElementById('emusweep');
  sweep.classList.toggle('hidden', !playSweep);
  sweep.innerHTML = playSweep
    ? '<div class="hk-ignite"></div><div class="hk-blend"><div class="hk-band"></div></div>' : '';
  document.getElementById('emuhk').innerHTML = hkOn
    ? `<div class="hk-sigilwrap"><div class="hk-bloom"></div>`
      + `<img class="hk-sigil" src="${ICONS.hinekora}" alt="Hinekora's Lock sigil" draggable="false"></div>`
      + `<div class="hk-locktext"><i>Hinekora's Lock allows you to forsee the result of the next `
      + `Currency Item used on this item. The Lock is removed when this item is modified.</i></div>`
    : '';
  bindEmuTip();
  syncEmRunes();
  document.getElementById('emucap').innerHTML = em.corrupted || em.sanctified ? '' : capacity(em);
  { const lk = document.getElementById('emulock'); if (lk) lk.classList.toggle('on', emLock); }
  drawEmuRunes();
  drawSnaps();

  // the pending-choice tray: reveal options or an essence list
  const pick = document.getElementById('emupick');
  document.getElementById('well').classList.toggle('hidden', !(emPend && emPend.kind === 'reveal'));
  if (emPend && emPend.kind === 'reveal') {
    pick.innerHTML = '';        // the reveal takes over the Well of Souls modal instead
    drawWell();
  } else if (emPend && emPend.kind === 'essence') {
    const esub = [];
    if (emPend.side) esub.push(`${emPend.side === 'p' ? 'prefix' : 'suffix'}-only \u2014 Crystallisation armed (disarm to see both sides)`);
    if (emPend.full) esub.push('item is full \u2014 only perfect/special essences (which replace a mod) can apply');
    if (emPend.hasDesec) esub.push('a desecrated mod is present \u2014 Essence of the Abyss is unavailable');
    pick.innerHTML = `<div class="emupickhead">Choose an essence</div>` +
      (esub.length ? `<div class="emupicksub">${esub.join(' &middot; ')}</div>` : '') +
      (emPend.rows.length ? emPend.rows.map(e => `<button class="emuopt" data-ess="${esc(e.i)}">
        ${e.img ? `<img class="essicon" src="${esc(e.img)}" alt="" loading="lazy">` : ''}
        <span class="tag ${e.a}">${e.a === 'p' ? 'P' : 'S'}</span>
        <span>${esc(e.n)}</span>
        <span class="emuoptt">${esc(renderRange(e.x, e.v))}</span>
      </button>`).join('') : '<div class="m ghost">no essence applies to this item</div>') +
      `<div class="emupbtns"><button class="emuopt cancel" data-esscancel>&times; Cancel &mdash; do something else</button></div>`;
    pick.querySelectorAll('[data-ess]').forEach(b => b.onclick = () => emTakeEssence(b.dataset.ess));
    pick.querySelector('[data-esscancel]').onclick = () => { emPend = null; drawEmu(); };
  } else if (emPend && emPend.kind === 'preview') {
    const p = emPend, dead = p.res === 'corrupt' || p.res === 'destroyed';
    const cost = PRICES[p.cur];
    const costTxt = cost != null && cost > 0 ? (+cost.toFixed(3)) + ' div' : '';
    const short = p.label.replace(/\s*Orb of\s*/i, '').replace(/\s*Orb\b/i, '').trim() || p.label;
    const r = p.rolled ? modRanges(p.rolled) : null;
    const rollBlock = p.rolled
      ? `<div class="hkflabel">It would roll</div>
         <div class="hkroll${dead ? ' dead' : ''}">
           <span class="tb">${p.rolled.tier ? 'T' + p.rolled.tier
              : p.rolled.a === 'p' ? 'P' : p.rolled.a === 's' ? 'S' : '&mdash;'}</span>
           <span class="rt">${esc(modText(p.rolled))}</span></div>
         ${r ? hkTierBar(r) : ''}`
      : `<div class="hkflabel">Outcome</div>
         <div class="hkfnote">${esc(p.detail || 'no visible change')}</div>`;
    pick.innerHTML = `<div class="hkforeseen">
      <div class="hkfhead"><span class="hkftitle">Foreseen</span>
        <span class="hkfsub">the next currency is already decided &mdash; you may walk away</span></div>
      <div class="hkfbody">
        <div class="hkfcur">
          ${p.icon && ICONS[p.icon] ? `<img src="${esc(ICONS[p.icon])}" alt="" loading="lazy">` : ''}
          <div class="hkfcurtxt"><span class="hkfcurname">${esc(p.label)}</span>
            ${p.curdesc ? `<span class="hkfcurdesc">${esc(p.curdesc)}</span>` : ''}</div>
          ${costTxt ? `<span class="hkfcost">${costTxt}</span>` : ''}
        </div>
        ${rollBlock}
        <div class="hkbtns">
          <button class="hkcommit" data-commit>Commit the ${esc(short)}</button>
          <button class="hkwalk" data-cancel>Walk away</button></div>
        <div class="hkfnote">Committing applies the ${esc(short)} and spends the Lock. Walking away
          spends the Lock too &mdash; the foresight was the cost; foresee again with another Lock.</div>
      </div></div>`;
    pick.querySelector('[data-commit]').onclick = emCommitPreview;
    pick.querySelector('[data-cancel]').onclick = emCancelPreview;
  } else pick.innerHTML = '';

  // the currency rail - locked out while a reveal/essence choice is open.
  // Sorted into a stable keybind order so number shortcuts don't wander.
  const opts = emRailOpts();
  const rail = document.getElementById('emurail');
  const locked = !!emPend;
  // An omen is bound to a currency (erasures->Chaos, exaltations->Exalt,
  // annulments->Annul, crystallisation->perfect essence, ...). When one is
  // armed, light up the currency it applies to and dim the rest, so it is
  // obvious what to press next - mirroring the red omen border in game.
  const linkOf = o => !!emOmen && !locked &&
    stepOmens({ kind: o.kind, cur: o.cur, tier: o.tier, ref: o.ref }).some(x => x.i === emOmen);
  const anyLink = opts.some(linkOf);
  rail.innerHTML = opts.length
    ? opts.map((o, j) => {
        // bones ride the acid ramp and badge their mod-level floor, not a tier
        const bone = o.kind === 'bone' ? BONES.find(x => x.id === o.ref) : null;
        return `<button class="emucur${o.kind === 'bone' ? ' bone' : ''}${
        o.kind === 'hinekora' ? ' hk' + (emLock ? ' on' : '') : ''}${locked ? ' dim' : ''}${
        anyLink ? (linkOf(o) ? ' omlink' : ' omdim') : ''}" data-opt="${j}"
        data-tipname="${esc(o.label)}" data-tip="${esc(curDescOf(o))}">
        ${j < RAILKEYS.length ? `<span class="emucurkey" title="press ${RAILKEYS[j].toUpperCase()} to apply">${RAILKEYS[j].toUpperCase()}</span>` : ''}
        ${bone ? `<span class="bonefloor" title="mod-level floor this bone raises the ordinary pool to">${bone.min || 0}</span>` : ''}
        <span class="sigwrap">${sigil(o.icon)}${o.tier && o.tier !== 'I'
          ? `<span class="tiermark">${ROMAN[o.tier]}</span>` : ''}</span>
        <span class="emucurn">${esc(o.label.replace(/^Orb of /, ''))}</span>
      </button>`; }).join('')
    : `<div class="emudone">${em.sanctified
        ? 'This item is Sanctified — permanently locked and finished.'
        : em.corrupted ? 'This item is corrupted and finished.' : 'Nothing more can be applied.'}</div>`;
  if (!locked)
    rail.querySelectorAll('[data-opt]').forEach(b => b.onclick = e => {
      const opt = opts[+b.dataset.opt];
      // shift-click bursts (mirrors the game's shift+right-click); the bulk chips
      // set a standing count. Only spammable currencies bulk; the rest apply once.
      const n = e.shiftKey ? Math.max(emRepeat, 10) : emRepeat;
      (n > 1 && bulkable(opt.kind)) ? emBulk(opt, n) : emApply(opt);
    });

  // bulk-count chips in the rail header
  const bulkBox = document.getElementById('emubulk');
  if (bulkBox) {
    bulkBox.innerHTML = `<span class="ebk">bulk</span>` +
      [1, 5, 10, 25].map(c => `<button class="ebchip${emRepeat === c ? ' on' : ''}" data-bulk="${c}">×${c}</button>`).join('') +
      `<span class="ebhint" title="Hold Shift and click a currency to burst-apply it (only Transmute/Regal/Exalt/Chaos/Annul/Divine repeat)">shift-click = burst</span>`;
    bulkBox.querySelectorAll('[data-bulk]').forEach(b => b.onclick = () => { emRepeat = +b.dataset.bulk; drawEmu(); });
  }

  // omen strip: arm one that pairs with a currency available right now
  const kinds = new Set(opts.map(o => o.kind));
  const avail = [];
  const seen = new Set();
  for (const o of opts) {
    for (const om of stepOmens({ kind: o.kind, cur: o.cur, tier: o.tier, ref: o.ref })) {
      if (!seen.has(om.i)) { seen.add(om.i); avail.push(om); }
    }
  }
  const omBox = document.getElementById('emuomen');
  omBox.innerHTML = avail.length
    ? `<span class="emurailk">arm an omen</span>` +
      avail.map(o => omenChip(o, emOmen === o.i, esc(o.i))).join('')
    : '';
  omBox.querySelectorAll('[data-omen]').forEach(b => b.onclick = () => {
    // toggling an omen also exits a stranded essence picker (e.g. a Crystallisation
    // omen opened it and you'd rather do something else)
    if (emPend && emPend.kind === 'essence') emPend = null;
    emOmen = emOmen === b.dataset.omen ? '' : b.dataset.omen; drawEmu();
  });
  if (emOmen && anyLink) {
    const names = [...new Set(opts.filter(linkOf)
      .map(o => o.label.replace(/^(Greater|Perfect) /, '')))];
    omBox.insertAdjacentHTML('beforeend',
      `<div class="omnote omapply">&#9654; apply with <b>${esc(names.join(' / '))}</b> &mdash; highlighted above</div>`);
  } else if (emOmen && !anyLink && !locked) {
    omBox.insertAdjacentHTML('beforeend',
      `<div class="omnote">this omen pairs with a currency not available right now</div>`);
  }
  if (emOmen && tgt.note) {
    omBox.insertAdjacentHTML('beforeend',
      `<div class="omnote">${tgt.keys.size ? '&#9679; ' : ''}${tgt.note}${
        tgt.keys.size ? ' &mdash; highlighted on the item' : ''}</div>`);
  }

  // macro: record a rotation of currencies and replay it in a loop
  const macroBox = document.getElementById('emumacro');
  if (macroBox) {
    const canRun = emMacro.length && !em.corrupted && !em.sanctified && !emPend;
    macroBox.innerHTML = `
      <div class="emmhead"><span class="emurailk">macro</span>
        <button class="emmrec${emRecording ? ' on' : ''}" data-macrec>${
          emRecording ? '&#9632; Stop recording' : '&#9679; Record'}</button></div>
      ${emMacro.length
        ? `<div class="emmchips">${emMacro.map((e, i) =>
            `<span class="emmchip">${esc(e.opt.label.replace(/^Orb of /, ''))}${
              e.omen ? ' <i>+omen</i>' : ''}${e.n > 1 ? ' &times;' + e.n : ''}<b data-macdel="${i}"
              title="remove">&times;</b></span>`).join('<span class="emmarr">&rsaquo;</span>')}</div>`
        : `<div class="emmempty">${emRecording
            ? 'recording &mdash; apply currencies to capture a rotation'
            : 'Record a rotation (e.g. Annul &rsaquo; Augment), then replay it in a loop to cycle a base. Stops when a step no longer fits.'}</div>`}
      ${emMacro.length ? `<div class="emmrun">
          <button class="ghost" data-macrun${canRun ? '' : ' disabled'}>&#9654; Run once</button>
          <input id="emmk" type="number" min="1" max="500" value="20" class="emmk" title="loops">
          <button class="ghost" data-macrunk${canRun ? '' : ' disabled'}>&#9654; Run &times;N</button>
          <button class="ghost" data-macclear>Clear</button></div>` : ''}`;
    macroBox.querySelector('[data-macrec]').onclick = () => { emRecording = !emRecording; drawEmu(); };
    macroBox.querySelectorAll('[data-macdel]').forEach(b => b.onclick = ev => {
      ev.stopPropagation(); emMacro.splice(+b.dataset.macdel, 1); drawEmu(); });
    const r1 = macroBox.querySelector('[data-macrun]'); if (r1) r1.onclick = () => emRunMacro(1);
    const rk = macroBox.querySelector('[data-macrunk]'); if (rk) rk.onclick = () =>
      emRunMacro(Math.max(1, Math.min(500, +document.getElementById('emmk').value || 1)));
    const cl = macroBox.querySelector('[data-macclear]'); if (cl) cl.onclick = () => {
      emMacro = []; emRecording = false; drawEmu(); };
  }

  // step simulator: pick a legal currency and run it 1000x on this item
  const simBox = document.getElementById('emusim');
  if (simBox) {
    const legal = optionsFor(em, true);
    if (!legal.length || emPend) { simBox.innerHTML = ''; }
    else {
      simBox.innerHTML = `<div class="emusimhead">Simulate a step
          <span class="note">runs the chosen currency 1000&times; on this exact item</span></div>
        <div class="emusimbar">
          <select id="emsimsel">${legal.map((o, j) =>
            `<option value="${j}">${esc(o.label)}</option>`).join('')}</select>
          <button class="ghost" id="emsimgo">&#9654; Simulate &times;1000</button></div>
        <div id="emsimout">${renderSim(emSim)}</div>`;
      const sel = document.getElementById('emsimsel'), go = document.getElementById('emsimgo');
      go.onclick = () => { emSim = emSimStep(legal[+sel.value], 1000);
        document.getElementById('emsimout').innerHTML = renderSim(emSim); };
    }
  }
  // log (newest first) and footer
  const log = document.getElementById('emulog');
  log.innerHTML = emLog.length
    ? emLog.slice().reverse().map((e, i) => `<div class="emulogrow${e.dead ? ' dead' : ''}${e.note ? ' note' : ''}">
        <span class="emulogn">${emLog.length - i}</span>
        <span><b>${e.label ? esc(e.label) : ''}</b>${e.label && e.detail ? ' &mdash; ' : ''}${e.detail || ''}</span>
      </div>`).join('')
    : '<div class="m ghost">no currency used yet</div>';
  // once the item is corrupted the run is over: settle the comparison on its own
  if ((em.corrupted || em.sanctified) && !emCompare && plan.length) emCompare = emRunCompare();
  drawTally();
  drawStats();
  const nMods = em.affixes.filter(a => a.a !== 'c').length;
  document.getElementById('emufoot').innerHTML =
    `<button class="ghost" id="emuundo"${emHist.length ? '' : ' disabled'}>&#8630; Undo</button>
     <button class="ghost" id="emurestart"${emLog.length ? '' : ' disabled'}
       title="Bank this attempt's cost, buy a fresh base, and keep crafting">&#8635; New base &middot; keep cost</button>
     <span>${emLog.length} step${emLog.length === 1 ? '' : 's'} &middot; ${nMods} modifier${
       nMods === 1 ? '' : 's'}${em.corrupted ? ' &middot; corrupted' : ''}</span>`;
  const u = document.getElementById('emuundo'); if (u) u.onclick = emUndo;
  const rs = document.getElementById('emurestart'); if (rs) rs.onclick = emRestartKeepCost;
}

/* ================= craft plan canvas =================
   A plan is an ordered chain of steps. Each step spends one currency and
   tries to land one of its target modifiers; on failure it either retries
   (optionally paying a recovery currency) or bricks the item.

   Probabilities come from the same pool resolution the bench uses, evaluated
   against the item state that actually enters the step. Expected currency is
   solved in closed form, not simulated — see solvePlan below. */

let view = 'graph';
let plan = [];            // [{ id, cur, tier, targets[], fail, rec, x, y }]
let selStep = null, planSeq = 0;

const ROMAN = { I: 'I', II: 'II', III: 'III' };
const SIG = {
  transmute: ['#6aa9d8', 'Tr'], aug: ['#7fc4a0', 'Au'], regal: ['#d8b45a', 'Rg'],
  exalted: ['#e8dca0', 'Ex'], chaos: ['#c08a5a', 'Ch'], annul: ['#b06a8a', 'An'],
  essence: ['#c9a227', 'Es'], base: ['#8f8f9a', 'B'], brick: ['#b5573a', '!'],
  reveal: ['#8a6ab0', 'Rv'], fracture: ['#c8aa5a', 'Fr'], architect: ['#a03060', 'Ar'],
  hinekora: ['#7a5cc0', 'Hk'],
  'q-weapon': ['#9aa7b8', 'Q'], 'q-armour': ['#9aa7b8', 'Q'], 'q-caster': ['#9aa7b8', 'Q'],
  'vinfuse-weapon': ['#b0384d', 'Vi'], 'vinfuse-armour': ['#b0384d', 'Vi'], 'vinfuse-caster': ['#b0384d', 'Vi'],
};

/* Steps that add a modifier, with the rarity they consume and produce. */
const STEPCUR = {
  transmute: { n: 'Orb of Transmutation', from: ['normal'], to: 'magic', tiered: true,
               rule: 'Normal: become Magic with 1 mod' },
  aug:       { n: 'Orb of Augmentation', from: ['magic'], to: 'magic', tiered: true,
               rule: 'Magic: add 1 mod' },
  regal:     { n: 'Regal Orb', from: ['magic'], to: 'rare', tiered: true,
               rule: 'Magic: become Rare, add 1 mod' },
  exalted:   { n: 'Exalted Orb', from: ['rare'], to: 'rare', tiered: true,
               rule: 'Rare: add 1 mod' },
  chaos:     { n: 'Chaos Orb', from: ['rare'], to: 'rare', tiered: true,
               rule: 'Rare: remove 1 random mod, then add 1' },
};

const COSTNAME = { base: 'Bases', annul: 'Orb of Annulment', brick: 'Bricked items' };
const costLabel = k => {
  if (COSTNAME[k]) return COSTNAME[k];
  if (k.startsWith('ess:')) return (ESS.find(e => e.i === k.slice(4)) || {}).n || 'Essence';
  if (k.startsWith('omen:')) return (OMENS.find(o => o.i === k.slice(5)) || {}).n || 'Omen';
  const b = BONES.find(x => x.id === k);
  if (b) return b.name;
  if (k === 'hinekora') return "Hinekora's Lock";
  if (k === 'vinfuse-weapon') return "Vaal Blacksmith's Infuser";
  if (k === 'vinfuse-armour') return "Vaal Armourer's Infuser";
  if (k === 'vinfuse-caster') return "Vaal Arcanist's Infuser";
  if (k === 'q-weapon') return "Blacksmith's Whetstone";
  if (k === 'q-armour') return "Armourer's Scrap";
  if (k === 'q-caster') return "Arcanist's Etcher";
  if (k === 'fracture') return 'Fracturing Orb';
  if (k === 'reveal') return 'Reveal (desecrated)';
  if (k === 'divine') return 'Divine Orb';
  if (k === 'vaal') return 'Vaal Orb';
  if (k === 'architect') return "Architect's Orb";
  if (k.includes('@')) { const [c, t] = k.split('@'); return curName(c, t); }
  return STEPCUR[k] ? STEPCUR[k].n : k;
};
/**
 * A step is one of four kinds. Orbs roll the normal pool; essences grant a
 * fixed modifier outright; Abyssal bones roll the desecrated pool through
 * their own level window; a Fracturing Orb adds nothing at all, it locks one
 * of the modifiers already present — chosen at random, which is why targeting
 * a specific one is 1/n.
 */
const REVEAL_OPTS = 3;

/**
 * A Vaal Orb has four equally likely outcomes and seals the item whichever one
 * lands: nothing, lose a modifier, gain a corrupted modifier, or reroll the
 * numeric values of what is already there. Only one of the four writes a
 * corrupted line, so asking for a particular corrupted modifier is a quarter of
 * that modifier's share of the pool, not the share itself.
 *
 * Rerolling values does not move a modifier between tiers, so against
 * tier-based targets that outcome is indistinguishable from nothing happening.
 */
const VAAL = { none: 0.25, lose: 0.25, gain: 0.25, reroll: 0.25 };

/**
 * A Vaal Orb writes a corrupted modifier and seals the item: corruption is
 * final, so no currency may follow it. The corrupted line sits outside the
 * prefix/suffix budget, which is why a full six-modifier Rare can still take
 * one. The corrupted pool carries no spawn weights on poe2db, so every entry
 * is treated as equally likely.
 */

function stepDef(s) {
  if (s.kind === 'hinekora')
    return { name: "Hinekora's Lock", icon: 'hinekora', to: null,
             from: ['normal', 'magic', 'rare'], rule: null, tiered: false };
  if (s.kind === 'essence') {
    const e = ESS.find(x => x.i === s.ref);
    if (!e) return null;
    const needRare = e.ti === 'perfect' || e.ti === 'special';
    return { name: e.n, icon: 'essence', ess: e, to: 'rare', from: [needRare ? 'rare' : 'magic'],
             rule: `${needRare ? 'Rare' : 'Magic'}: guarantees its modifier`, tiered: false };
  }
  if (s.kind === 'architect') {
    return { name: "Architect's Orb", icon: 'architect', to: null,
             from: ['normal', 'magic', 'rare'], needsCorrupt: true,
             rule: 'Corrupted only: double-corrupt, or destroy the item',
             tiered: false, architect: true };
  }
  if (s.kind === 'vaal') {
    return { name: 'Vaal Orb', icon: 'vaal', to: null,
             from: ['normal', 'magic', 'rare'],
             rule: 'Any rarity: corrupt the item &mdash; nothing may follow',
             tiered: false, vaal: true };
  }
  if (s.kind === 'divine') {
    // rerolls the numbers inside each modifier's existing tier; the tiers, and
    // therefore every probability, are untouched
    return { name: 'Divine Orb', icon: 'divine', to: null,
             from: ['magic', 'rare'],
             rule: 'Magic or Rare: reroll the values inside each tier',
             tiered: false, divine: true };
  }
  if (s.kind === 'reveal') {
    // revealing does not change rarity and adds no modifier: it resolves one
    // desecrated modifier that is already sitting on the item
    return { name: 'Reveal Desecrated', icon: 'reveal', to: null, from: ['rare'],
             rule: 'Rare: resolve a desecrated modifier &mdash; ' + REVEAL_OPTS + ' options',
             tiered: false, reveal: true };
  }
  if (s.kind === 'annul') {
    // the one currency that leaves rarity alone: `to: null` means unchanged
    return { name: 'Orb of Annulment', icon: 'annul', to: null,
             from: ['magic', 'rare'],
             rule: 'Magic or Rare: remove one random modifier', tiered: false };
  }
  if (s.kind === 'bone') {
    const b = BONES.find(x => x.id === s.ref);
    if (!b) return null;
    const bt = boneTierOf(b);
    const win = b.min ? ` &middot; normal pool mlvl \u2265 ${b.min} (${bt.word})` : '';
    return { name: b.name, icon: b.id, bone: b, to: 'rare', from: ['rare'],
             rule: `Rare: add a desecrated mod${win}`, tiered: false };
  }
  if (s.kind === 'fracture') {
    return { name: 'Fracturing Orb', icon: 'fracture', to: 'rare', from: ['rare'],
             rule: 'Rare with 4+ mods: fracture one at random', tiered: false };
  }
  const C = STEPCUR[s.cur];
  return { name: curName(s.cur, s.tier), icon: s.cur, to: C.to, from: C.from,
           rule: C.rule, tiered: true };
}

/** Cost-table key: essences and bones are individual items, not one currency. */
function costKey(s) {
  if (s.kind === 'hinekora') return 'hinekora';
  if (s.kind === 'essence') return 'ess:' + s.ref;
  if (s.kind === 'bone') return s.ref;
  // kinds that carry no currency key of their own would otherwise all collapse
  // into a single unnamed row in the cost table
  if (s.kind === 'fracture') return 'fracture';
  if (s.kind === 'annul') return 'annul';
  if (s.kind === 'reveal') return 'reveal';
  if (s.kind === 'divine') return 'divine';
  if (s.kind === 'vaal') return 'vaal';
  if (s.kind === 'architect') return 'architect';
  return (STEPCUR[s.cur] && STEPCUR[s.cur].tiered && s.tier !== 'I')
    ? s.cur + '@' + s.tier : s.cur;
}

const curName = (k, t) => (STEPCUR[k].tiered ? TIERWORD[t] : '') + STEPCUR[k].n;

/* ---------------- plan evaluation ---------------- */

/** Item state entering step index i: the base plus every target landed before it. */
function stateBefore(i) {
  let rarity = state.rarity === 'normal' ? 'normal' : state.rarity;
  let corrupted = !!state.corrupted;
  let sanctified = !!state.sanctified;
  const affixes = state.affixes.filter(a => a.a !== 'c')
                    .map(a => ({ g: a.g, a: a.a, tier: a.tier, cat: a.cat, fx: a.fx }));
  for (let k = 0; k < i; k++) {
    const s = plan[k];
    const D = stepDef(s);
    if (!D) continue;
    if (D.to) rarity = D.to;                 // an Annul leaves rarity alone
    if (s.kind === 'architect') {
      // Success writes one fixed line - Twice Corrupted - rather than rolling
      // the corrupted pool. Failure destroys the item, which the cost model
      // handles as a brick. Either way the orb is spent: one use per item.
      affixes.push({ g: '__twice', a: 'c', tier: 0,
                     name: 'Twice Corrupted', cor: true, twice: true });
      continue;
    }
    if (s.kind === 'vaal') {
      corrupted = true;
      // only one of the four outcomes writes a line, so an untargeted Vaal is
      // shown sealed but unchanged rather than promising a modifier
      const t = s.targets && s.targets[0];
      if (t) affixes.push({ g: t.g, a: 'c', tier: t.maxTier || 1, name: t.name, cor: true });
      continue;
    }
    if (s.kind === 'hinekora') continue;       // foresight marker: no state change
    if (s.kind === 'divine') {
      // A Divine changes only values, so the affix list is unchanged; but a
      // Sanctification Divine permanently locks the item.
      if (omenFx(s.omen ? omenById(s.omen) : null) === 'sanctify') sanctified = true;
      continue;
    }
    if (s.kind === 'reveal') {
      // the unrevealed modifier becomes a concrete one; the slot it already
      // occupies is reused, so the modifier count does not change
      const idx = affixes.findIndex(a => a.un);
      if (idx >= 0) {
        const t = s.targets && s.targets[0];
        affixes[idx] = t
          ? { g: t.g, a: t.a, tier: t.maxTier || 1, name: t.name, cat: 'desecrated' }
          : { ...affixes[idx], un: undefined };
      }
      continue;
    }
    if (s.kind === 'annul') {
      // removes a random modifier from whatever the omen leaves eligible
      const free = annulPool(affixes, s);
      if (free.length) {
        let v = null;
        if (s.fxPick) v = free.find(a => a.g === s.fxPick.g && a.a === s.fxPick.a);
        if (!v) v = free[0];
        affixes.splice(affixes.indexOf(v), 1);
      }
      continue;
    }
    if (s.kind === 'fracture') {
      // Fracture locks one existing modifier in place. It adds nothing; the
      // locked mod is flagged fx and can never again be removed or rerolled.
      if (affixes.length) {
        // an unrevealed desecrated modifier is not a legal fracture target, which
        // is exactly why the strat lands a bone before fracturing: it shrinks the
        // pool the fracture rolls over without occupying one of its slots
        const can = a => !a.fx && !a.un;
        let idx = -1;
        if (s.fxPick) idx = affixes.findIndex(a => can(a) && a.g === s.fxPick.g && a.a === s.fxPick.a);
        if (idx < 0) idx = affixes.findIndex(can);
        if (idx >= 0) affixes[idx] = { ...affixes[idx], fx: true };
      }
      continue;
    }
    if (s.kind === 'essence') {
      const e = D.ess;
      if (isPerfectEss(e)) {
        // remove a modifier the plan is not trying to keep, then add the essence
        const keep = new Set(s.targets.map(t => t.g + '|' + t.a));
        const pool = essReplacePool(affixes, e.a);
        let victim = pool.find(a => !keep.has(a.g + '|' + a.a)) || pool[0];
        if (victim) affixes.splice(affixes.indexOf(victim), 1);
      }
      affixes.push({ g: e.g, a: e.a, tier: 1, name: e.n.replace(/^.*Essence of /, ''),
                     ess: true, cat: 'crafted' });
      continue;
    }
    // A Chaos Orb takes one modifier away before it writes one, so the count
    // is unchanged. Prefer to drop something this step is not trying to keep.
    if (s.kind === 'orb' && s.cur === 'chaos' && affixes.some(a => !a.fx)) {
      const keep = new Set(s.targets.map(t => t.g + '|' + t.a));
      let at = affixes.findIndex(a => !a.fx && !keep.has(a.g + '|' + a.a));
      if (at < 0) at = affixes.findIndex(a => !a.fx);   // fractured mods are safe
      if (at >= 0) affixes.splice(at, 1);
    }

    const got = s.mode === 'all' ? s.targets.slice(0, 3) : s.targets.slice(0, 1);
    if (got.length) {
      for (const t of got)
        affixes.push({ g: t.g, a: t.a, tier: t.maxTier || 1, name: t.name,
                       cat: s.kind === 'bone' ? 'desecrated' : undefined,
                       un: s.kind === 'bone' || undefined,
                       rOmen: s.kind === 'bone' ? (s.omen || null) : undefined,
                       rMin: s.kind === 'bone' ? (D.bone ? (D.bone.min || 0) : 0) : undefined });
    } else {
      // Every add-type orb writes a modifier even when no target is named.
      // Without this an untargeted step placed nothing, the item never filled,
      // and Augmentation could be chained forever on a Magic item.
      { const bm = blankMod(rarity, affixes);
        if (s.kind === 'bone') { bm.cat = 'desecrated'; bm.un = true; bm.rOmen = s.omen || null;
          bm.rMin = D.bone ? (D.bone.min || 0) : 0; }
        affixes.push(bm); }
    }
  }
  return { rarity, affixes, corrupted, sanctified };
}

/**
 * A modifier we know was written but not which one. It occupies a slot on
 * whichever side has more room, and takes a unique group so it never blocks a
 * real family we have no reason to think it used.
 */
function blankMod(rarity, affixes) {
  const lim = LIM(rarity);
  const np = affixes.filter(a => a.a === 'p').length;
  const ns = affixes.filter(a => a.a === 's').length;
  const a = (lim.p - np) >= (lim.s - ns) ? 'p' : 's';
  return { g: '__any' + affixes.length, a, tier: 0, name: 'random modifier', rand: true };
}

const asItem = st => ({ slug: state.slug, base: state.base, classTags: state.classTags,
                        ilvl: state.ilvl, rarity: st.rarity, affixes: st.affixes,
                        sockets: st.sockets,
                        corrupted: !!st.corrupted, sanctified: !!st.sanctified });

/**
 * A step whose targets must ALL land, for an add-type currency.
 *
 * Each use adds a modifier whatever it rolls, so a miss permanently burns an
 * affix slot — this is drawing without replacement, not a free retry loop. The
 * walk therefore ends in one of two ways: every target landed (success), or the
 * relevant slots ran out (failure), which makes ALL-mode steps able to brick.
 *
 * State is (which targets landed, prefixes used, suffixes used); the pool is
 * re-resolved per state so group exclusivity and slot limits are honoured.
 *
 * Stated approximation: junk modifiers occupy a slot but we do not track WHICH
 * group each junk roll consumed — doing so is combinatorial. Target shares are
 * therefore computed from the landed targets alone, which slightly understates
 * later-target odds (a consumed junk group would other0wise leave the pool).
 */
function allModeSolve(i) {
  const s = plan[i], C = STEPCUR[s.cur];
  const before = stateBefore(i);
  const ts = s.targets.slice(0, 3);
  const n = ts.length;
  const min = C.tiered ? minFor(s.cur, s.tier) : 0;
  const lim = LIM(C.to);
  const memo = new Map();

  const basePre = before.affixes.filter(a => a.a === 'p').length;
  const baseSuf = before.affixes.filter(a => a.a === 's').length;

  function walk(mask, pu, su) {
    if (mask === (1 << n) - 1) return { p: 1, uses: 0 };
    const key = mask + ':' + pu + ':' + su;
    if (memo.has(key)) return memo.get(key);
    memo.set(key, { p: 0, uses: 0 });            // re-entry guard

    const affixes = before.affixes.concat(
      ts.filter((_, k) => mask & (1 << k)).map(x => ({ g: x.g, a: x.a, tier: x.maxTier || 1 })));
    const probe = { slug: state.slug, base: state.base, classTags: state.classTags,
                    ilvl: state.ilvl, rarity: C.to, corrupted: false,
                    affixes: affixes.concat(
                      Array.from({ length: Math.max(0, pu - basePre - countBits(mask, ts, 'p')) },
                                 () => ({ g: '__junk_p' + Math.random(), a: 'p' })),
                      Array.from({ length: Math.max(0, su - baseSuf - countBits(mask, ts, 's')) },
                                 () => ({ g: '__junk_s' + Math.random(), a: 's' }))) };
    const pool = eligible(probe, null, min);
    const tot = pool.reduce((a, e) => a + e.w, 0);
    if (!tot) { const r = { p: 0, uses: 0 }; memo.set(key, r); return r; }

    let acc = { p: 0, uses: 1 };
    let covered = 0;
    for (let k = 0; k < n; k++) {
      if (mask & (1 << k)) continue;
      const t = ts[k];
      const w = pool.filter(e => e.m.g === t.g && e.m.a === t.a &&
                                 (!t.maxTier || e.t[0] <= t.maxTier))
                    .reduce((a, e) => a + e.w, 0);
      if (!w) continue;
      const pk = w / tot; covered += pk;
      const nx = walk(mask | (1 << k), pu + (t.a === 'p' ? 1 : 0), su + (t.a === 's' ? 1 : 0));
      acc.p += pk * nx.p; acc.uses += pk * nx.uses;
    }
    // anything else fills a slot and moves on
    const wJunkP = pool.filter(e => e.m.a === 'p').reduce((a, e) => a + e.w, 0);
    const wJunkS = tot - wJunkP;
    const missP = Math.max(0, wJunkP / tot - targetShare(pool, tot, ts, mask, 'p'));
    const missS = Math.max(0, wJunkS / tot - targetShare(pool, tot, ts, mask, 's'));
    for (const [share, isPre] of [[missP, true], [missS, false]]) {
      if (share <= 0) continue;
      const nx = walk(mask, pu + (isPre ? 1 : 0), su + (isPre ? 0 : 1));
      acc.p += share * nx.p; acc.uses += share * nx.uses;
    }
    if (covered === 0 && missP + missS === 0) { const r = { p: 0, uses: 0 }; memo.set(key, r); return r; }
    memo.set(key, acc);
    return acc;
  }

  return walk(0, basePre, baseSuf);
}

function countBits(mask, ts, side) {
  let c = 0;
  ts.forEach((t, k) => { if ((mask & (1 << k)) && t.a === side) c++; });
  return c;
}

function targetShare(pool, tot, ts, mask, side) {
  let w = 0;
  ts.forEach((t, k) => {
    if (mask & (1 << k)) return;
    if (t.a !== side) return;
    w += pool.filter(e => e.m.g === t.g && e.m.a === t.a &&
                          (!t.maxTier || e.t[0] <= t.maxTier))
             .reduce((a, e) => a + e.w, 0);
  });
  return w / tot;
}

/** P(one use of this step lands any of its targets), exact from the pool. */
function stepChance(i) {
  const s = plan[i], D = stepDef(s);
  if (!D) return { p: 0, why: 'unknown step' };
  const before = stateBefore(i);
  if (before.sanctified)
    return { p: 0, why: 'the item is Sanctified; it is permanently locked' };
  if (before.corrupted && s.kind !== 'architect')
    return { p: 0, why: 'the item is corrupted; no further currency can be used' };
  if (D.needsCorrupt && !before.corrupted)
    return { p: 0, why: "an Architect's Orb only works on a corrupted item" };
  if (!D.from.includes(before.rarity))
    return { p: 0, why: `needs a ${D.from.map(r => RNAME[r]).join(' or ')} item` };
  if (s.kind === 'hinekora') return { p: 1, why: null };   // foresight: always "succeeds", costs only

  // a bone adds a modifier, so the 6-modifier ceiling applies
  if (s.kind === 'bone' && before.affixes.length >= LIMITS.rare.total)
    return { p: 0, why: `a Rare item holds ${LIMITS.rare.total} modifiers; this one is full` };
  // and an item may carry only one desecrated modifier
  if (s.kind === 'bone' && countCat(before.affixes, 'desecrated') >= maxDesecrated())
    return { p: 0, why: `an item can hold ${maxDesecrated()} desecrated modifier${maxDesecrated() > 1 ? 's' : ''}` };

  // an essence grants its modifier outright
  if (s.kind === 'essence') {
    const e = D.ess;
    if (countCat(before.affixes, 'crafted') >= maxCrafted())
      return { p: 0, why: `an item can hold ${maxCrafted()} crafted (essence) modifier${maxCrafted() > 1 ? 's' : ''}` };
    if (before.affixes.some(a => a.g === e.g && a.a === e.a))
      return { p: 0, why: 'that modifier is already on the item' };
    if (isPerfectEss(e)) {
      // a perfect essence replaces, so it only needs something it may replace
      if (!essReplacePool(before.affixes, e.a).length)
        return { p: 0, why: `nothing here can be replaced by a ${e.a === 'p' ? 'prefix' : 'suffix'} essence` };
      return { p: 1, why: null };
    }
    if (before.affixes.length >= effLimit('total'))
      return { p: 0, why: `a Rare item holds ${effLimit('total')} modifiers; this one is full` };
    const used = before.affixes.filter(a => a.a === e.a).length;
    if (used >= effLimit(e.a))
      return { p: 0, why: `no open ${e.a === 'p' ? 'prefix' : 'suffix'} (${used} of ${effLimit(e.a)} used)` };
    return { p: 1, why: null };
  }

  // A Vaal Orb always corrupts. If a particular corrupted modifier is wanted,
  // the chance is that modifier's share of the (unweighted) corrupted pool.
  // An Architect's Orb is a flat coin flip with a fixed reward, so there is
  // nothing to aim at: it either writes Twice Corrupted or destroys the item.
  if (s.kind === 'architect') {
    if (before.affixes.some(a => a.twice))
      return { p: 0, why: 'an item can only be twice corrupted once' };
    return { p: 0.5, why: null };
  }

  // A Vaal writes a corrupted line in only one outcome of four, so a wanted
  // corrupted modifier is a quarter of its share of the pool.
  if (s.kind === 'vaal') {
    if (!s.targets.length) return { p: 1, why: null };
    const P = stepPool(s);
    if (!P || !P.tot) return { p: 0, why: 'no corrupted modifier can apply here' };
    const hit = P.list.filter(m => s.targets.some(t => t.g === m.g && t.a === m.a))
                      .reduce((a, m) => a + m.w, 0);
    return { p: VAAL.gain * (hit / P.tot),
             why: hit ? null : 'that corrupted modifier cannot apply here' };
  }

  // A reveal offers a handful of desecrated modifiers and you keep one, so the
  // step lands if the modifier you want turns up among the options at all.
  if (s.kind === 'reveal') {
    if (!before.affixes.some(a => a.un))
      return { p: 0, why: 'no unrevealed desecrated modifier on the item' };
    if (!s.targets.length) return { p: 1, why: null };
    const P = stepPool(s);
    if (!P || !P.tot) return { p: 0, why: 'nothing can be revealed here' };
    const want = P.list.filter(m => s.targets.some(t => t.g === m.g && t.a === m.a &&
      (!t.minV || m.tiers.some(x => valueFrac([x.t, x.ilvl, x.v], t.minV) > 0))));
    if (!want.reduce((a, m) => a + m.w, 0))
      return { p: 0, why: 'that modifier is not in the desecrated pool' };
    const once = revealHitChance(P, want);
    // Abyssal Echoes rerolls the options, so a miss gets a second, independent set
    const echoes = omenFx(s.omen ? omenById(s.omen) : null) === 'reroll';
    return { p: echoes ? 1 - Math.pow(1 - once, 2) : once, why: null };
  }

  // a Divine Orb always applies; it moves numbers, never tiers
  if (s.kind === 'divine') {
    if (before.corrupted || before.sanctified) return { p: 0, why: 'this item can no longer be divined' };
    if (!before.affixes.some(a => a.a !== 'c' && !a.fx))
      return { p: 0, why: 'every modifier here is fractured or corrupted' };
    return { p: 1, why: null };
  }

  // an Annulment strips one random modifier from whatever the omen leaves eligible
  if (s.kind === 'annul') {
    const free = annulPool(before.affixes, s);
    if (!free.length) {
      const o = s.omen ? omenById(s.omen) : null;
      const fx = omenFx(o);
      return { p: 0, why: fx === 'desec'
          ? 'the omen removes only a desecrated modifier, and there is none here'
        : fx === 'force' ? `the omen removes only a ${o.f}, and none is removable here`
        : 'nothing left that an Annulment can remove' };
    }
    if (!s.fxPick) return { p: 1, why: null };
    const gone = !free.some(a => a.g === s.fxPick.g && a.a === s.fxPick.a);
    return { p: 1 / free.length, why: gone ? 'the omen protects that modifier' : null };
  }

  // a fracture locks one modifier at random. Landing a *chosen* modifier is
  // 1 / (fracturable count); unrevealed desecrated mods are not fracturable.
  if (s.kind === 'fracture') {
    const n = before.affixes.length;
    if (n < 4) return { p: 0, why: `needs 4+ modifiers, item has ${n}` };
    const free = before.affixes.filter(a => !a.fx && !a.un).length;
    if (!free) return { p: 0, why: 'no modifier here can be fractured' };
    if (!s.fxPick) return { p: 1, why: null };
    const still = before.affixes.some(a => a.fx && a.g === s.fxPick.g && a.a === s.fxPick.a);
    return { p: 1 / free, why: still ? 'that modifier is already fractured' : null };
  }

  if (!s.targets.length) return { p: 0, why: 'no target set' };

  // the roll resolves at the rarity the currency leaves behind
  const probe = asItem({ rarity: D.to || before.rarity, affixes: before.affixes });
  const min = D.tiered ? minFor(s.cur, s.tier) : 0;
  const src = s.kind === 'bone' ? DES : MODS;
  let pool = eligible(probe, null, D.bone ? (D.bone.min || 0) : min,
                      D.bone && D.bone.max ? D.bone.max : Infinity, src);
  const nar = omenNarrow(pool, s, before);
  pool = nar.pool;
  const tot = pool.reduce((a, e) => a + e.w, 0);
  if (!tot) return { p: 0, why: nar.fx === 'force'
      ? `the omen forces a ${nar.o.f}, and none can spawn here`
    : nar.fx === 'lich'
      ? `the omen guarantees a ${LICHNAME[nar.tag] || 'lich'} modifier, and none can spawn here`
      : 'nothing can spawn here' };

  const have = new Set(before.affixes.map(a => a.g + '|' + a.a));
  const hit = pool.reduce((acc, e) => {
    const tg = s.targets.find(t => t.g === e.m.g && t.a === e.m.a &&
      !have.has(t.g + '|' + t.a) && (!t.maxTier || e.t[0] <= t.maxTier));
    return tg ? acc + e.w * valueFrac(e.t, tg.minV) : acc;
  }, 0);
  const why = hit ? null
    : nar.fx === 'lich' ? `the ${LICHNAME[nar.tag] || 'lich'} set does not contain that modifier`
    : nar.fx === 'force' ? `the ${nar.o.f} side cannot roll that modifier`
    : 'target cannot roll here';
  return { p: hit / tot, why };
}

/**
 * Strict step model: a removal can undo progress, and you re-climb with the
 * currency you are already holding.
 *
 * Earlier steps are NOT re-run. If the Annul backing an Exalt strips the mod a
 * Regal placed, you do not Regal again — the item is already Rare, so you keep
 * Exalting until it is back. Each step is a biased walk in "targets landed":
 *
 *   add + Annul recovery   up = p           down = (1-p)*r
 *   chaos                  up = (1-r)*p     down = r*(1-p)
 *   otherwise              up = p           down = 0
 *
 * with r = landed/M the chance a removal takes something you wanted. Expected
 * applications for one net target is 1/(up-down). When down >= up the step
 * destroys progress faster than it makes it and the plan cannot finish — that
 * is reported rather than hidden behind a large number.
 */
function stepWalk(s) {
  const p = s.p, r = s.mods > 0 ? Math.min(1, (s.landed || 0) / s.mods) : 0;
  let up, down;
  if (s.kind === 'chaos') { up = (1 - r) * p; down = r * (1 - p); }
  else if (s.rec === 'annul' && s.fail !== 'brick') { up = p; down = (1 - p) * r; }
  else { up = p; down = 0; }
  const net = up - down;
  if (!(net > 0)) return { uses: Infinity, rec: Infinity, net, r };
  const uses = 1 / net;
  return { uses, rec: s.rec === 'annul' ? (1 - p) * uses : 0, net, r };
}

function solveStrict(steps, baseCost = 1) {
  const add = (t, k, v) => { if (v) t[k] = (t[k] || 0) + v; return t; };
  const scale = (t, f) => { const o = {}; for (const k in t) o[k] = t[k] * f; return o; };
  const merge = (x, y) => { const o = { ...x }; for (const k in y) add(o, k, y[k]); return o; };

  const walks = steps.map(stepWalk);
  if (walks.some(w => !isFinite(w.uses))) return null;

  let A = {}, B = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i], w = walks[i], p = s.p, q = 1 - p;
    if (s.fail === 'brick') {
      let Ai = merge(add({}, s.cur, 1), scale(A, p));
      Ai = merge(Ai, scale(add(add({}, 'base', baseCost), 'brick', 1), q));
      B = p * B + q; A = Ai;
    } else {
      A = merge(merge(add({}, s.cur, w.uses), s.rec ? add({}, s.rec, w.rec) : {}), A);
    }
  }
  if (B >= 1) return null;
  const perGoal = scale(A, 1 / (1 - B));
  let pRun = 1;
  for (const s of steps) if (s.fail === 'brick') pRun *= s.p;
  const sum = t => Object.entries(t).filter(([k]) => k !== 'brick')
                     .reduce((a2, [, v]) => a2 + v, 0);
  return { perGoal, spend: sum(perGoal), bricks: perGoal.brick || 0, pRun,
           walks, strict: true };
}

/** Closed-form expected currency per landed goal. Mirrors cost_model.mjs. */
function solvePlan(steps) {
  for (const s of steps) if (!(s.p > 0) || !isFinite(s.uses)) return null;
  const add = (t, k, v) => { if (v) t[k] = (t[k] || 0) + v; return t; };
  const scale = (t, f) => { const o = {}; for (const k in t) o[k] = t[k] * f; return o; };
  const merge = (a, b) => { const o = { ...a }; for (const k in b) add(o, k, b[k]); return o; };

  let A = {}, B = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i], p = s.p, q = 1 - p;
    if (s.fail === 'brick') {
      let Ai = merge(add({}, s.cur, 1), scale(A, p));
      Ai = merge(Ai, scale(add(add({}, 'base', 1), 'brick', 1), q));
      B = p * B + q; A = Ai;
    } else {
      if (!isFinite(s.uses)) return null;
      const per = merge(add({}, s.cur, s.uses), s.rec ? add({}, s.rec, s.recUses) : {});
      A = merge(per, A);
    }
  }
  if (B >= 1) return null;
  const perGoal = scale(A, 1 / (1 - B));

  let pRun = 1; const clean = {};
  for (const s of steps) {
    if (s.fail === 'brick') { pRun *= s.p; add(clean, s.cur, 1); }
    else { add(clean, s.cur, s.uses); if (s.rec) add(clean, s.rec, s.recUses); }
  }
  add(clean, 'base', 1);
  const sum = t => Object.entries(t).filter(([k]) => k !== 'brick')
                    .reduce((a, [, v]) => a + v, 0);
  const spend = sum(perGoal), cleanSpend = sum(clean);
  return { perGoal, spend, bricks: perGoal.brick || 0, pRun,
           wasted: spend > 0 ? Math.max(0, (spend - cleanSpend) / spend) : 0 };
}

function evaluate() {
  const steps = plan.map((s, i) => {
    const { p, why } = stepChance(i);
    const all = s.mode === 'all' && s.targets.length > 1;
    let uses = p > 0 ? 1 / p : Infinity, note = why;
    let pAll = p;
    if (all) {
      const r = allModeSolve(i);
      uses = r.uses; pAll = r.p;
      if (!(r.p > 0)) note = 'these targets cannot all fit — slots run out first';
    }
    // a use that lands nothing needs the recovery item; landings do not
    const landed = all ? Math.min(s.targets.length, 3) : 1;
    const recUses = Math.max(0, uses - landed);
    return { cur: costKey(s), p: all ? pAll : p, uses, recUses, all,
             // Only UNLOCKED modifiers can be removed. A removal happens after a
             // failed roll has written a junk mod, so the removable pool is the
             // unlocked affixes plus that one; fractured mods are safe and drop
             // out of the denominator (4 mods, 1 fractured -> annul hits 1/3).
             mods: stateBefore(i).affixes.filter(a => !a.fx).length + 1,
             landed: stateBefore(i).affixes.filter(a => !a.fx).length,
             kind: s.kind === 'orb' && s.cur === 'chaos' ? 'chaos' : (s.kind || 'orb'),
             fail: s.fail, rec: s.rec, why: note };
  });
  const solved = strict ? solveStrict(steps) : solvePlan(steps);
  return { steps, solved, loose: strict ? solvePlan(steps) : null };
}

/* ---------------- rendering ---------------- */

const CW = 320, CH_GAP = 40;

function sigil(kind) {
  const src = ICONS[kind];
  if (src) return `<img class="sig art" src="${src}" alt="" draggable="false">`;
  const [c, t] = SIG[kind] || SIG.base;
  return `<span class="sig" style="background:${c}">${t}</span>`;
}

// Hover tooltips for the emulator: for each mod we show the value window its
// current tier can roll and where the actual roll landed inside it, so a player
// can see at a glance whether a Divine Orb (rerolls values within the tier) is
// worth it. Built at render time into a small registry; the mod line only carries
// an integer index, so nothing HTML-unsafe ever lands in an attribute.
let TIP_REG = [], EMU_RENDER = false, emTipBound = false;
// while set (during the emulator mod render), modLine shows magnitude-boosted values
let dispScale = null;
// while true (the locked Hinekora render), each numeric mod grows its (min–max) window
let hkWin = false;
// Build a mod line where each rolled number is followed by its magenta roll window,
// e.g. 25(20–30)% increased Global Defences. Ranges come from the mod's current tier.
function hkWindowed(a) {
  const r = modRanges(a);
  const tmpl = (r && r.tmpl) || a.x || '';
  const v = a.v || [];
  const ranges = r ? r.ranges : null;
  let html = '', last = 0, m;
  const re = /\{(\d+)\}/g;
  while ((m = re.exec(tmpl))) {
    html += esc(tmpl.slice(last, m.index));
    const i = +m[1], rg = ranges && ranges[i];
    html += `<span class="hkval">${esc(String(fmtNum(v[i])))}</span>`;
    if (rg && rg[0] !== rg[1]) html += `<span class="hkwin">(${rg[0]}–${rg[1]})</span>`;
    last = m.index + m[0].length;
  }
  html += esc(tmpl.slice(last));
  return html.split('\n').join(', ');
}

// A roll's position in its tier window as a good/bad cue: high = green (leave it),
// mid = amber, low = red (a Divine is tempting). Same thresholds everywhere.
const qualClass = pct => pct == null ? '' : pct >= 70 ? 'tq-hi' : pct >= 35 ? 'tq-mid' : 'tq-lo';
const qualWord  = pct => pct == null ? '' : pct >= 70 ? 'high roll' : pct >= 35 ? 'mid roll' : 'low roll';

/** The tier value windows + current roll for an affix, or null if it has none. */
function modRanges(a) {
  if (a.impl) {
    const src = ((state.base && state.base.imp) || []).find(im => im.x === a.x);
    if (!src || !src.v || !src.v.length) return null;
    return { ranges: src.v, cur: a.v, tmpl: a.x, tier: '', tname: 'implicit', impl: true };
  }
  if (a.rand || a.twice || a.mark || a.un || a.a === 'c') return null;
  // essence/alloy mods are graded against their own window, not the base ladder
  if (a.er && a.er.length) return { ranges: a.er, cur: a.v, tmpl: a.x, tier: a.tier, tname: a.tname || '', fx: !!a.fx };
  const m = modOf(a);
  if (!m || !m.t) return null;
  const t = m.t.find(x => x[0] === a.tier);
  if (!t || !t[2] || !t[2].length) return null;
  return { ranges: t[2], cur: a.v, tmpl: m.x, tier: a.tier, tname: t[4] || '', fx: !!a.fx };
}

/** Mean percentile of a roll across its varying slots (0-100), or null. */
function rollQuality(a) {
  const r = modRanges(a);
  if (!r || r.fx || !r.cur) return null;      // fractured can't be rerolled: no cue
  let sum = 0, n = 0;
  r.ranges.forEach((rg, i) => {
    if (rg[1] <= rg[0] || r.cur[i] == null) return;
    sum += (r.cur[i] - rg[0]) / (rg[1] - rg[0]); n++;
  });
  return n ? Math.round(sum / n * 100) : null;
}

/**
 * Graph analogue of rollQuality: with no rolled value to grade, rate the affix
 * by which TIER it sits on within the mod's ladder (a tier's value ceiling vs
 * the mod's best/worst tier). Top tier -> green, weakest -> red. Value-based so
 * it holds whichever way the tier indices run. null for single-tier / valueless.
 */
function tierQuality(a) {
  if (a.fx || a.rand || a.twice || a.a === 'c' || a.mark || a.un || a.impl || !a.tier) return null;
  const m = modOf(a);
  if (!m || !m.t || m.t.length < 2) return null;
  const ceil = t => { const last = t[2] && t[2][t[2].length - 1]; return last ? last[1] : null; };
  const mine = m.t.find(t => t[0] === a.tier);
  const myTop = mine && ceil(mine);
  if (myTop == null) return null;
  const tops = m.t.map(ceil).filter(v => v != null);
  const hi = Math.max(...tops), lo = Math.min(...tops);
  if (hi === lo) return null;
  return Math.round((myTop - lo) / (hi - lo) * 100);
}

function tipHTML({ ranges, cur, tmpl, tier, tname, note }) {
  const hasRange = ranges.some(r => r[0] !== r[1]);
  const rangeStr = renderRange(tmpl, ranges);
  let bars = '';
  ranges.forEach((r, i) => {
    if (r[0] === r[1]) return;                       // fixed slot, no bar
    const c = cur ? cur[i] : null;
    const pct = c != null && r[1] > r[0]
      ? Math.round(((c - r[0]) / (r[1] - r[0])) * 100) : null;
    const w = pct == null ? 0 : Math.max(0, Math.min(100, pct));
    const q = qualClass(pct);
    bars += `<div class="tiprow ${q}">
      <div class="tipbarwrap"><span class="tipend">${r[0]}</span>
        <div class="tipbar"><i style="width:${w}%"></i>${
          c != null ? `<b style="left:${w}%"></b>` : ''}</div>
        <span class="tipend">${r[1]}</span></div>
      ${c != null ? `<div class="tipnow">rolled <b>${c}</b>${
        pct != null ? ` &middot; ${pct}% &middot; <span class="tqword">${qualWord(pct)}</span>` : ''}</div>` : ''}
    </div>`;
  });
  const tt = tier ? 'T' + tier : (tname === 'implicit' ? 'IMP' : '');
  return `<div class="tiptag">${tt}${tname && tname !== 'implicit'
        ? ' &middot; ' + esc(tname) : ''}</div>
    <div class="tiphead">this tier can roll</div>
    <div class="tiprangelbl">${esc(rangeStr)}</div>
    ${hasRange ? bars : '<div class="tipfixed">fixed value &mdash; nothing to reroll</div>'}
    <div class="tipnote">${note}</div>`;
}

/** Tooltip HTML for one affix, or '' when it has no rerollable range. */
function rangeTip(a) {
  const r = modRanges(a);
  if (!r) return '';
  const note = r.impl ? 'a Divine Orb (or Omen of the Blessed) rerolls implicit values'
    : r.fx ? 'fractured &mdash; locked; a Divine will not reroll it'
    : 'a Divine Orb rerolls the values within this tier';
  return tipHTML({ ...r, note });
}

/** Attribute snippet ` data-rtip="N"` when a line has a range to show (emu only).
 * A dedicated attribute (not the shared plain-text `data-tip`) so the global
 * cursor tooltip leaves these rich range popups to bindEmuTip. */
function tipAttr(a) {
  if (!EMU_RENDER) return '';
  const html = rangeTip(a);
  if (!html) return '';
  return ' data-rtip="' + (TIP_REG.push(html) - 1) + '"';
}

function bindEmuTip() {
  if (emTipBound) return;
  const emu = document.getElementById('emu');
  const tip = document.getElementById('emutip');
  if (!emu || !tip) return;
  emTipBound = true;
  const hide = () => tip.classList.add('hidden');
  emu.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-rtip]');
    if (!el) return;
    const html = TIP_REG[+el.dataset.rtip];
    if (!html) { hide(); return; }
    tip.innerHTML = html;
    tip.classList.remove('hidden');
    const r = el.getBoundingClientRect(), tr = tip.getBoundingClientRect();
    let left = r.left, top = r.bottom + 8;
    if (left + tr.width > innerWidth - 8) left = innerWidth - 8 - tr.width;
    if (top + tr.height > innerHeight - 8) top = r.top - 8 - tr.height;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, top) + 'px';
  });
  emu.addEventListener('mouseout', e => {
    if (!e.target.closest('[data-rtip]')) return;
    const to = e.relatedTarget;
    if (to && to.closest && to.closest('[data-rtip]') === e.target.closest('[data-rtip]')) return;
    hide();
  });
}

// An unrevealed desecrated modifier reads as illegible acid script, like the
// game. Cyrillic/Greek codepoints (present in every system font + Source Sans 3,
// so never tofu). Shuffled deterministically per affix so two differ but the same
// one is stable across re-renders.
const UNREV_GLYPHS = ['Ѭ','Ж','Ѧ','⊕','Ϟ','Ѫ','⊗','Ψ','Ѱ','Ђ','Ҩ','Ϫ','Ѯ','Җ'];
function unrevGlyphs(a) {
  let s = hashStr((a.g || '') + '|' + (a.a || '') + '|' + (a.ml || 0)) || 1;
  const arr = UNREV_GLYPHS.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, 8).join(' ');
}

function modLine(a, ghost) {
  // a family splits per item class (Armour vs Energy Shield variants share a
  // group), so resolve the name against THIS base, not the first global match
  const m = modOf(a);
  // a modifier-magnitude meta-mod (Thrud) boosts this mod's numbers; show the
  // boosted value on the line itself, like the game does
  const magScale = dispScale ? dispScale(a) : 1;
  const name = magScale !== 1 ? magText(a, dispScale) : modText(a);
  // origin tint: desecrated modifiers read green, crafted (essence/rune) blue
  const cat = a.cat === 'desecrated' ? ' desec' : a.cat === 'crafted' ? ' craft' : a.cat === 'rune' ? ' rune' : '';
  if (a.rand) return `<div class="m rand">
    <span class="tb">&mdash;</span>
    <span>${a.a === 'p' ? 'prefix' : 'suffix'} &middot; random modifier</span></div>`;
  if (a.twice) return `<div class="m cor twice" title="twice corrupted: an Architect's Orb landed">
    <span class="tb">&#9670;&#9670;</span>
    <span>Twice Corrupted</span></div>`;
  if (a.a === 'c') return `<div class="m cor" title="corrupted: the item is final">
    <span class="tb">&#9670;</span>
    <span>${esc(name)}</span></div>`;
  if (a.mark) return `<div class="m abyssmark" title="Mark of the Abyssal Lord: a desecration bone turns this into an unrevealed desecrated modifier">
    <span class="tb">&#9670;</span>
    <span>Mark of the Abyssal Lord <span class="unrev">abyss mark</span></span></div>`;
  if (a.un) return `<div class="m unrevealed" title="an unrevealed desecrated modifier — reveal it at the Well of Souls; it cannot be fractured until revealed">
    <span class="tb">??</span>
    <span class="glyphs" aria-label="unrevealed desecrated modifier">${unrevGlyphs(a)}</span></div>`;
  if (a.fx) return `<div class="m fx"${tipAttr(a)} title="fractured: locked, cannot be removed or rerolled">
    <span class="tb">${a.tier ? 'T' + a.tier : '&#128274;'}</span>
    <span>${ICONS.fracture ? `<img class="fxlock" src="${ICONS.fracture}" alt="fractured" draggable="false">`
      : '<span class="fxlock">&#128274;</span>'} ${esc(name)}</span></div>`;
  // at-a-glance quality tint on the tier tag: in the emulator it grades the real
  // ROLL within its tier; in the graph (no rolled value) it grades the TIER itself.
  let q = '', tbTitle = '';
  if (EMU_RENDER) q = qualClass(rollQuality(a));
  else {
    q = qualClass(tierQuality(a));
    if (q) tbTitle = ` title="T${a.tier} — ${q === 'tq-hi' ? 'a top tier'
      : q === 'tq-mid' ? 'a mid tier' : 'a low tier'} for this modifier"`;
  }
  const magAttr = magScale !== 1
    ? ` title="magnified &times;${magScale.toFixed(2)} by a modifier-magnitude rune &mdash; base roll: ${esc(modText(a))}"` : '';
  // Hinekora locked state: the value carries its (min–max) roll window (raw HTML, spans)
  const inner = hkWin ? hkWindowed(a) : esc(name);
  return `<div class="m${ghost ? ' ghost' : ''}${cat}${magScale !== 1 ? ' magnified' : ''}"${tipAttr(a)}${magAttr}>
    <span class="tb${q ? ' ' + q : ''}"${tbTitle}>${a.tier ? 'T' + a.tier : '?'}</span>
    <span>${inner}</span></div>`;
}

function drawPlan() {
  const cards = document.getElementById('cards');
  const { steps, solved, loose } = evaluate();
  const parts = [];

  // base item card
  const b0 = { x: 24, y: 24 };
  parts.push(`<div class="card" style="left:${b0.x}px;top:${b0.y}px" data-base="1">
    <div class="chead">${sigil('base')}
      <div><div class="cname">Base item</div>
      <div class="crule">${esc(state.base.n)}</div></div></div>
    <div class="enters"><span class="k">Starts as</span>
      <div class="iname" style="color:var(--${state.rarity === 'rare' ? 'rare' : state.rarity === 'magic' ? 'magic' : 'ink'})">
        ${esc(BASES[state.slug].ic || state.slug)}</div>
      <div class="m ghost">ilvl ${state.ilvl} &middot; ${RNAME[state.rarity]}</div>
      ${capacity(state)}
    </div>
    ${plan.length === 0 ? rail(-1, null) : ''}</div>`);

  plan.forEach((s, i) => {
    const D = stepDef(s), ev = steps[i], before = stateBefore(i);
    if (!D) return;
    const bad = !(ev.p > 0);
    const min = D.tiered ? minFor(s.cur, s.tier) : 0;
    const fixed = s.kind === 'essence' || s.kind === 'architect';
    parts.push(`<div class="card${selStep === s.id ? ' sel' : ''}" data-step="${s.id}"
        style="left:${s.x}px;top:${s.y}px">
      <div class="chead">
        <span class="sigwrap">${sigil(D.icon)}${
          D.tiered && s.tier !== 'I' ? `<span class="tiermark">${ROMAN[s.tier]}</span>` : ''}</span>
        <div><div class="cname">${esc(D.name)}${s.omen && omenById(s.omen)
            ? ` <span class="omtag">+ ${esc(omenById(s.omen).n.replace(/^Omen of (the )?/, ''))}</span>` : ''}</div>
          <div class="crule">${D.tiered ? `<span class="croman">${ROMAN[s.tier]}</span> ` : ''}${
            D.rule}${min ? ` (mlvl &ge; ${min})` : ''}</div></div>
        <span class="cx" data-del="${s.id}">&times;</span>
      </div>

      <div class="enters"><span class="k">Enters as</span>
        <div class="iname" style="color:var(--${before.rarity === 'rare' ? 'rare' : before.rarity === 'magic' ? 'magic' : 'ink'})">
          ${esc(BASES[state.slug].ic || state.slug)}</div>
        ${before.affixes.length ? before.affixes.map(a => modLine(a)).join('')
          : '<div class="m ghost">no modifiers yet</div>'}
        ${capacity(before)}
      </div>

      ${s.kind === 'essence' ? `<div class="trow">
          <span class="tag ${D.ess.a}">${D.ess.a === 'p' ? 'PREFIX' : 'SUFFIX'}</span>
          <span>${esc(D.ess.x.replace(/\{(\d+)\}/g, (_, k) =>
            D.ess.v[k] ? (D.ess.v[k][0] === D.ess.v[k][1] ? D.ess.v[k][0]
              : D.ess.v[k][0] + '-' + D.ess.v[k][1]) : 'X').split('\n').join(' + '))}</span>
          <span class="dot2" style="background:${bad ? 'var(--suffix)' : 'var(--accent)'}"></span>
        </div>` : ''}
      ${s.kind === 'fracture' || s.kind === 'annul' ? fracturePanel(s, before) : ''}
      ${s.kind === 'vaal' ? `<div class="pool"><div class="poolfoot">
          four outcomes, one in four each &middot; nothing &middot; lose a modifier &middot;
          gain a corrupted line &middot; reroll values. Only the third writes a line, so a wanted
          corrupted modifier is a quarter of its share of the pool. Rerolled values stay inside
          their tier, so that outcome does not move a tier-based target.
        </div></div>` : ''}
      ${s.kind === 'architect' ? `<div class="pool"><div class="poolfoot">
          corrupted items only, and <b>one use per item</b> &middot; half the time the item gains
          <b>Twice Corrupted</b>, half the time it is <b>destroyed</b> &mdash; counted as a brick
          in the cost and the simulation. There is nothing to aim at: the reward is fixed.
        </div></div>` : ''}
      ${fixed ? '' : s.targets.map((t, ti) => `<div class="trow">
          ${ti ? `<span class="tag op">${s.mode === 'all' ? 'AND' : 'OR'}</span>` : ''}
          <span class="tag ${t.a}">${t.a === 'p' ? 'PREFIX' : 'SUFFIX'}</span>
          <span>${esc(t.name)}</span>
          <span class="tcyc" data-tcyc="${s.id}:${ti}"
            title="required tier — click to change">${t.maxTier ? 'T' + t.maxTier + '+' : 'any tier'}</span>
          <span class="tcyc minv" data-minv="${s.id}:${ti}"
            title="minimum rolled value — click to set">${t.minV ? '&ge; ' + t.minV : 'any roll'}</span>
          <span class="tx" data-untarget="${s.id}:${ti}">&times;</span>
          <span class="dot2" style="background:${bad ? 'var(--suffix)' : 'var(--prefix)'}"></span>
        </div>`).join('')}
      ${omenRow(s)}
      <div class="trow modrow"${fixed ? ' style="display:none"' : ''}>
        <span class="addt" style="padding:0" data-pool="${s.id}">${
          openPool.has(s.id) ? '&minus; hide modifiers' : '&oplus; choose modifiers'}</span>
        ${s.targets.length > 1 ? `<span class="modechip" data-mode="${s.id}">${
          s.mode === 'all' ? 'need ALL' : 'ANY one'}</span>` : ''}
      </div>
      ${!fixed && openPool.has(s.id) ? poolPanel(s) : ''}

      <div class="loop${s.fail === 'brick' ? ' dead' : ''}" data-fail="${s.id}">
        ${ev.p >= 1 ? '&#10003; always succeeds'
          : s.fail === 'brick' ? '&#9760; on failure: brick the item'
          : `&#8635; on failure: retry${s.rec ? ' after an Annul' : ''}`}
        <b>${bad ? '—' : (s.fail === 'brick'
              ? `${(ev.p * 100).toFixed(1)}%`
              : `~${isFinite(ev.uses) ? ev.uses.toFixed(1) : '\u221e'}`)}</b>
      </div>
      ${bad ? `<div class="costfoot" style="color:var(--suffix)">${
        /no target/.test(ev.why || '')
          ? 'Pick a modifier below to give this step a target.'
          : esc(ev.why || 'impossible step')}</div>` : ''}
      ${!bad && strict && !isFinite(stepWalk(ev).uses)
        ? `<div class="costfoot" style="color:var(--suffix)">Removals undo this faster than it
           lands &mdash; ${ev.landed} of ${ev.mods} modifiers here are targets.</div>` : ''}
    </div>`);
  });

  // where the chain leaves the item
  if (plan.length) {
    const fin = stateBefore(plan.length);
    const last = plan[plan.length - 1];
    const fx = last.x || 24, fy = (last.y || 24) + 260;
    parts.push(`<div class="card fin" style="left:${fx}px;top:${fy}px" data-fin="1">
      <div class="chead">${sigil('base')}
        <div><div class="cname">Result</div>
        <div class="crule">after ${plan.length} step${plan.length === 1 ? '' : 's'}</div></div></div>
      <div class="enters"><span class="k">Ends as</span>
        <div class="iname" style="color:var(--${fin.rarity === 'rare' ? 'rare'
          : fin.rarity === 'magic' ? 'magic' : 'ink'})">
          ${esc(BASES[state.slug].ic || state.slug)} &middot; ${RNAME[fin.rarity]}</div>
        ${fin.affixes.length ? fin.affixes.map(a => modLine(a)).join('')
          : '<div class="m ghost">no modifiers</div>'}
        ${capacity(fin)}
      </div>
      ${rail(plan.length - 1, last.id)}
    </div>`);
  }

  // brick / cost summary
  if (solved) {
    const bx = 402, by = 24;   // side column, clear of the vertical chain
    const rows = Object.entries(solved.perGoal)
      .filter(([k]) => k !== 'brick')
      .sort((a, b) => b[1] - a[1]);
    parts.push(`<div class="card brick" style="left:${bx}px;top:${by}px" data-cost="1">
      <div class="chead">${sigil('brick')}
        <div><div class="cname">Cost per landed goal</div>
        <div class="crule">${strict ? 'strict: removals can undo progress' : 'simple: failures cost only the orb'}</div></div></div>
      ${solved.strict
        ? `<div class="bigpct">${solved.spend.toFixed(0)}</div>
           <div class="bigk">currency items per goal landed</div>`
        : `<div class="bigpct">${(solved.wasted * 100).toFixed(1)}%</div>
           <div class="bigk">wasted on bricks per goal</div>`}
      ${rows.map(([k, v]) => `<div class="costrow">
          ${ICONS[k.split('@')[0]]
              ? `<img class="bico" src="${ICONS[k.split('@')[0]]}" alt="">` : ''}
          <span class="cn">${esc(costLabel(k))}</span>
          <span class="cv">${v.toFixed(2)}</span></div>`).join('')}
      <div class="costfoot">~${solved.bricks.toFixed(1)} bricks per goal landed &middot;
        one clean pass lands ${(solved.pRun * 100).toFixed(2)}% of the time${
        solved.strict ? ' &middot; Annul and Chaos removals are modelled as undoing earlier steps' : ''}</div>
    </div>`);
  }

  cards.innerHTML = parts.join('');
  wireCards();
  layoutCards();
  applyZoom();
  drawWires();
  drawPathbar(solved, steps, loose);
  drawHistory();
}

const CARDW = 320, COLGAP = 44, ROWGAP = 30;
const COLX = [24, 24 + CARDW + COLGAP];              // two chain columns
const COSTX = COLX[1] + CARDW + COLGAP;              // summary sits past them

/**
 * Two-column zig-zag. The base, every step and the result are laid out in
 * reading order across two columns (base left, step 1 right, step 2 left, ...)
 * and each column stacks by measured height. That roughly halves the vertical
 * run of a long plan and keeps each step visually next to its neighbour, while
 * the wires zig-zag between the columns to show the true order.
 */
function layoutCards() {
  const host = document.getElementById('cards');
  const seq = [];
  const base = host.querySelector('.card[data-base]');
  if (base) seq.push(base);
  for (const st of plan) {
    const el = host.querySelector(`.card[data-step="${st.id}"]`);
    if (el) seq.push(el);
  }
  const fin = host.querySelector('.card[data-fin]');
  if (fin) seq.push(fin);

  const yc = [24, 24];
  seq.forEach((el, i) => {
    const col = i % 2;
    el.style.left = COLX[col] + 'px';
    el.style.top = yc[col] + 'px';
    const id = el.dataset.step;
    if (id) { const st = plan.find(x => x.id === +id); if (st) { st.x = COLX[col]; st.y = yc[col]; } }
    yc[col] += el.offsetHeight + ROWGAP;
  });

  const cost = host.querySelector('.card[data-cost]');
  if (cost) { cost.style.left = COSTX + 'px'; cost.style.top = '24px'; }
}

/** Route one wire between consecutive cards: side-by-side or diagonal drop. */
function wirePath(a, b) {
  const acx = a.x + a.w / 2, bcx = b.x + b.w / 2;
  const sameRow = Math.abs(a.y - b.y) < Math.min(a.h, b.h) * 0.55;
  if (sameRow) {                               // horizontal S between facing edges
    const aLeft = acx <= bcx;
    const x1 = aLeft ? a.x + a.w : a.x, x2 = aLeft ? b.x : b.x + b.w;
    const y1 = a.y + 30, y2 = b.y + 30, mx = (x1 + x2) / 2;
    return { d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, p1: [x1, y1], p2: [x2, y2] };
  }
  const x1 = acx, y1 = a.y + a.h, x2 = bcx, y2 = b.y, my = (y1 + y2) / 2;
  return { d: `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`, p1: [x1, y1], p2: [x2, y2] };
}

function drawWires() {
  const svg = document.getElementById('wires');
  const host = document.getElementById('cards');
  const st = document.getElementById('stage');
  svg.setAttribute('width', st ? st.offsetWidth : host.offsetWidth);
  svg.setAttribute('height', st ? st.offsetHeight : host.offsetHeight);
  const boxes = [...host.querySelectorAll('.card')];
  const at = el => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
  const seq = [boxes.find(b => b.dataset.base)].concat(
    plan.map(s => boxes.find(b => b.dataset.step === String(s.id)))).filter(Boolean);

  const fin = boxes.find(b => b.dataset.fin);
  if (fin) seq.push(fin);

  const out = [];
  for (let i = 0; i + 1 < seq.length; i++) {
    const dead = plan[i] && plan[i].fail === 'brick';
    const w = wirePath(at(seq[i]), at(seq[i + 1]));
    out.push(`<path class="${dead ? 'dead' : ''}" d="${w.d}"/>`);
    out.push(`<circle class="${dead ? 'dead' : ''}" cx="${w.p1[0]}" cy="${w.p1[1]}" r="3.5"/>`);
    out.push(`<circle class="${dead ? 'dead' : ''}" cx="${w.p2[0]}" cy="${w.p2[1]}" r="3.5"/>`);
  }
  svg.innerHTML = out.join('');
}

function drawPathbar(solved, steps, loose) {
  const el = document.getElementById('pathbar');
  if (!plan.length) {
    el.innerHTML = `<span>Add a step to start a plan. Each step spends one currency and
      tries to land a modifier; mark a step as bricking to see what failure really costs.</span>`;
    return;
  }
  const broken = steps.filter(s => !(s.p > 0)).length;
  if (!solved) {
    if (broken) {
      el.innerHTML = `<span class="warn">${broken} step${broken === 1 ? '' : 's'} cannot land —
        fix the highlighted node${broken === 1 ? '' : 's'} to get a cost.</span>`;
      return;
    }
    // every step can land, so the plan must be losing ground to removals
    const bad = steps.map((s, i) => ({ i, w: stepWalk(s) })).filter(x => !isFinite(x.w.uses));
    if (bad.length && strict) {
      const b = bad[0], st = steps[b.i];
      el.innerHTML = `<span class="warn">Step ${b.i + 1} destroys progress faster than it
        makes it: it lands ${(st.p * 100).toFixed(1)}% of the time, but a removal takes one of
        your targets ${(b.w.r * 100).toFixed(0)}% of the time
        (${st.landed} of ${st.mods} modifiers are ones you want).</span>
        <span>Drop the Annul recovery, or land this modifier earlier while fewer targets are
        on the item.</span>`;
      return;
    }
    el.innerHTML = `<span class="warn">This plan has no finite cost.</span>`;
    return;
  }
  const extra = loose && loose.spend > 0
    ? `<span><span class="k">Cost of removal risk</span><b class="warn">+${
        Math.max(0, ((solved.spend / loose.spend) - 1) * 100).toFixed(0)}%</b>
       <span style="opacity:.7">vs ${loose.spend.toFixed(1)} ignoring it</span></span>` : '';
  el.innerHTML =
    `<span><span class="k">${strict ? 'Strict model' : 'Simple model'}</span><b>${
      strict ? 'removals undo progress' : 'failures are free'}</b></span>` +
    `<span><span class="k">Clean pass</span><b>${(solved.pRun * 100).toFixed(2)}%</b></span>` +
    `<span><span class="k">Currency per goal</span><b>${solved.spend.toFixed(1)}</b></span>` +
    `<span><span class="k">Bricks per goal</span><b>${solved.bricks.toFixed(1)}</b></span>` +
    (solved.strict ? '' :
      `<span><span class="k">Wasted on bricks</span><b class="warn">${
        (solved.wasted * 100).toFixed(1)}%</b></span>`) + extra;
}

/* ---------------- interaction ---------------- */

function wireCards() {
  const host = document.getElementById('cards');
  // manual drag retired: the two-column zig-zag arranges every card

  host.querySelectorAll('[data-del]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    plan = plan.filter(s => s.id !== +b.dataset.del);
    drawPlan();
  });
  host.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
    const s = plan.find(x => x.id === +b.dataset.mode);
    s.mode = s.mode === 'all' ? 'either' : 'all';
    if (s.mode === 'all') s.fail = 'retry';
    drawPlan();
  });
  host.querySelectorAll('[data-fail]').forEach(b => b.onclick = () => {
    const s = plan.find(x => x.id === +b.dataset.fail);
    if (s.mode === 'all' && s.targets.length > 1) return;   // ALL is a loop, it cannot brick
    s.fail = s.fail === 'retry' && !s.rec ? 'retryAnnul' : s.fail === 'retryAnnul' ? 'brick' : 'retry';
    if (s.fail === 'retryAnnul') { s.fail = 'retry'; s.rec = 'annul'; }
    else if (s.fail === 'retry') s.rec = null;
    drawPlan();
  });
  host.querySelectorAll('[data-untarget]').forEach(b => b.onclick = () => {
    const [id, ti] = b.dataset.untarget.split(':');
    const s = plan.find(x => x.id === +id);
    s.targets.splice(+ti, 1);
    drawPlan();
  });
  host.querySelectorAll('[data-pool]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const id = +b.dataset.pool;
    openPool.has(id) ? openPool.delete(id) : openPool.add(id);
    selStep = id;
    drawPlan();
  });

  host.querySelectorAll('[data-add]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const [kind, cur, ref, afterId, tier] = b.dataset.add.split(':');
    const at = afterId === '' ? 0 : plan.findIndex(x => x.id === +afterId) + 1;
    if (kind === 'essence') { openEssencePick(at); return; }
    addStep(cur === 'fracture' ? 'exalted' : cur, tier || 'I', at,
            kind === 'orb' ? 'orb' : kind, ref || null);
    drawPlan();
  });

  host.querySelectorAll('[data-pick]').forEach(row => row.onclick = e => {
    e.stopPropagation();
    const raw = row.dataset.pick;
    const id = +raw.slice(0, raw.indexOf(':'));
    const key = raw.slice(raw.indexOf(':') + 1);
    const [g, a] = [key.slice(0, key.lastIndexOf('|')), key.slice(key.lastIndexOf('|') + 1)];
    const st = plan.find(x => x.id === id);
    if (!st) return;
    const at = st.targets.findIndex(t => t.g === g && t.a === a);
    if (at >= 0) st.targets.splice(at, 1);
    else {
      const P = stepPool(st);
      const m = P && P.list.find(x => x.g === g && x.a === a);
      st.targets.push({ g, a, name: m ? m.name : g, maxTier: 0 });
    }
    drawPlan();
  });

  host.querySelectorAll('[data-tier]').forEach(c => c.onclick = e => {
    e.stopPropagation();
    const k = c.dataset.tier;
    openTier.has(k) ? openTier.delete(k) : openTier.add(k);
    drawPlan();
  });

  host.querySelectorAll('[data-ptier]').forEach(row => row.onclick = e => {
    e.stopPropagation();
    const raw = row.dataset.ptier;
    const at = raw.lastIndexOf(':');
    const key = raw.slice(0, at), tier = +raw.slice(at + 1);
    const id = +key.slice(0, key.indexOf(':'));
    const gk = key.slice(key.indexOf(':') + 1);
    const g = gk.slice(0, gk.lastIndexOf('|')), a = gk.slice(gk.lastIndexOf('|') + 1);
    const st = plan.find(x => x.id === id);
    if (!st) return;
    let t = st.targets.find(x => x.g === g && x.a === a);
    if (!t) {
      const P = stepPool(st), m = P && P.list.find(x => x.g === g && x.a === a);
      t = { g, a, name: m ? m.name : g, maxTier: 0 };
      st.targets.push(t);
    }
    t.maxTier = t.maxTier === tier ? 0 : tier;   // click the active tier to clear
    drawPlan();
  });

  host.querySelectorAll('[data-minv]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const [id, ti] = b.dataset.minv.split(':');
    const st = plan.find(x => x.id === +id);
    const t = st && st.targets[+ti];
    if (!t) return;
    const P = stepPool(st);
    const m = P && P.list.find(x => x.g === t.g && x.a === t.a);
    const best = m && m.tiers[0] && m.tiers[0].v && m.tiers[0].v[0];
    const hint = best ? ` (best tier rolls ${best[0]}-${best[1]})` : '';
    const cur = t.minV ? String(t.minV) : '';
    const ans = prompt(`Minimum rolled value for "${t.name}"${hint}.\nLeave blank for any roll.`, cur);
    if (ans === null) return;
    const v = parseFloat(ans);
    t.minV = isFinite(v) && v > 0 ? v : 0;
    drawPlan();
  });

  host.querySelectorAll('[data-tcyc]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const [id, ti] = b.dataset.tcyc.split(':');
    const st = plan.find(x => x.id === +id);
    const t = st && st.targets[+ti];
    if (!t) return;
    t.maxTier = t.maxTier >= 3 ? 0 : (t.maxTier || 0) + 1;
    drawPlan();
  });

  host.querySelectorAll('[data-omen]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const raw = b.dataset.omen, at = raw.indexOf(':');
    const st = plan.find(x => x.id === +raw.slice(0, at));
    if (!st) return;
    const id = raw.slice(at + 1);
    st.omen = st.omen === id ? null : id;      // an omen is armed per step
    drawPlan();
  });

  host.querySelectorAll('[data-fx]').forEach(row => row.onclick = e => {
    e.stopPropagation();
    const raw = row.dataset.fx, at = raw.indexOf(':');
    const id = +raw.slice(0, at), key = raw.slice(at + 1);
    const g = key.slice(0, key.lastIndexOf('|')), a = key.slice(key.lastIndexOf('|') + 1);
    const st = plan.find(x => x.id === id);
    if (!st) return;
    st.fxPick = (st.fxPick && st.fxPick.g === g && st.fxPick.a === a) ? null : { g, a };
    drawPlan();
  });

  host.querySelectorAll('[data-poolq]').forEach(inp => {
    inp.oninput = () => { poolQ[+inp.dataset.poolq] = inp.value; drawPlan();
      const again = host.querySelector(`[data-poolq="${inp.dataset.poolq}"]`);
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    };
    inp.onclick = e => e.stopPropagation();
  });
}

/**
 * Everything that can legally follow the item state after step i. Rendered as
 * icons on the card itself so a chain is built by clicking the node you are
 * looking at, rather than hunting through a dropdown at the top of the page.
 */
function nextOptions(i) { return optionsFor(stateBefore(i + 1)); }

/** Legal next currencies for any item state - used by both the plan rail and
 *  the live emulator, so the two can never disagree about what is allowed. */
function optionsFor(st, forEmu) {
  const r = st.rarity, n = st.affixes.length;
  const lim = LIM(r);
  const out = [];
  const push = (kind, cur, label, ref, tier) => out.push({ kind, cur, label, ref,
    tier: tier || 'I',
    icon: kind === 'bone' ? ref : kind === 'essence' ? 'essence'
        : kind === 'fracture' ? 'fracture' : cur });
  // a tiered orb is offered at each of its tiers (Normal / Greater / Perfect),
  // skipping a tier whose minimum modifier level is above the item's level.
  const pushOrb = (cur, label) => {
    const t = TIERS[cur];
    for (const tr of (t ? ['I', 'II', 'III'] : ['I'])) {
      if (tr !== 'I' && (t[tr] || 0) > state.ilvl) continue;
      push('orb', cur, TIERWORD[tr] + label, null, tr);
    }
  };

  if (r === 'normal') pushOrb('transmute', 'Orb of Transmutation');
  if (r === 'magic') {
    if (n < lim.total) pushOrb('aug', 'Orb of Augmentation');
    pushOrb('regal', 'Regal Orb');
  }
  // an Annulment works at either rarity, as long as something is removable
  if ((r === 'magic' || r === 'rare') && st.affixes.some(a => !a.fx))
    push('annul', 'annul', 'Orb of Annulment', null);
  // and a desecrated modifier can be resolved once it is on the item
  if (r === 'rare' && st.affixes.some(a => a.un))
    push('reveal', 'reveal', 'Reveal Desecrated', null);
  // a Divine Orb only moves numbers, and never a fractured one, so it needs an
  // unlocked modifier to move them on
  if ((r === 'magic' || r === 'rare') && st.affixes.some(a => a.a !== 'c' && !a.fx))
    push('divine', 'divine', 'Divine Orb', null);
  // quality currency raises quality to the base's cap, by item type - emulator
  // only, since the graph plans mod pools, not the finishing quality pass
  if (forEmu) {
    const qc = qCap(st), curQ = (st.quality != null) ? st.quality : qc, ct = state.classTags || [];
    if (!st.corrupted && curQ < qc) {
      if (ct.includes('caster')) push('quality', 'q-caster', "Arcanist's Etcher");
      else if (ct.includes('weapon') || ct.includes('martial')) push('quality', 'q-weapon', "Blacksmith's Whetstone");
      else if (baseSockets(state.slug) > 0) push('quality', 'q-armour', "Armourer's Scrap");
    }
  }
  // Vaal Infuser: pushes quality past 20% toward the 30% ceiling, with a
  // corruption risk on every use - the final min-max step on finished gear
  if (forEmu) {
    const cq = st.quality != null ? st.quality : 20, ct = state.classTags || [];
    if (!st.corrupted && cq >= 20 && cq < 30) {
      if (ct.includes('caster')) push('vaalinfuse', 'vinfuse-caster', "Vaal Arcanist's Infuser");
      else if (ct.includes('weapon') || ct.includes('martial')) push('vaalinfuse', 'vinfuse-weapon', "Vaal Blacksmith's Infuser");
      else if (baseSockets(state.slug) > 0) push('vaalinfuse', 'vinfuse-armour', "Vaal Armourer's Infuser");
    }
  }
  // Sanctification is a permanent, total lock: nothing further, not even Architect
  if (st.sanctified) return [];
  // corrupting is the last thing that can happen to an item
  push('vaal', 'vaal', 'Vaal Orb', null);
  if (st.corrupted) {
    // corruption is final, save for the one currency made to act on it - and an
    // Architect's Orb may be used only once, whichever way the flip goes
    return st.affixes.some(a => a.twice) ? []
      : [{ kind: 'architect', cur: 'architect', label: "Architect's Orb",
           ref: null, tier: 'I', icon: 'architect' }];
  }
  // Hinekora's Lock: in the emulator it arms foresight of the next currency; in
  // the graph it is a costed marker for planning the ~1200 div spend.
  push('hinekora', 'hinekora', "Hinekora's Lock", null);
  const hasDesecrated = countCat(st.affixes, 'desecrated') >= maxDesecrated();
  const hasCrafted = countCat(st.affixes, 'crafted') >= maxCrafted();
  if (r === 'rare') {
    if (n < lim.total) pushOrb('exalted', 'Exalted Orb');
    // Chaos swaps one modifier for another, so a full item still takes it
    pushOrb('chaos', 'Chaos Orb');
    // a Fracture locks an existing modifier rather than adding one
    // one fractured modifier max per item, so a second Fracturing Orb is illegal
    if (n >= 4 && !st.affixes.some(a => a.fx)) push('fracture', 'fracture', 'Fracturing Orb');
    // a bone adds a desecrated modifier: needs a free slot AND the item may hold
    // only one desecrated modifier at a time
    if (n < lim.total && !hasDesecrated)
      for (const b of BONES)
        if (b.classes.includes(state.slug)) push('bone', b.id, b.name, b.id);
  }
  // Essences grant a fixed modifier and leave the item Rare: lesser and greater
  // act on a Magic item, perfect ones on a Rare item. Either way they need a
  // free slot on their own side once the item is Rare.
  const anyEss = ESS.some(e => {
    if (!e.c.includes(state.slug) || e.rl > state.ilvl) return false;
    const needRare = e.ti === 'perfect' || e.ti === 'special';
    if (needRare ? r !== 'rare' : r !== 'magic') return false;
    // an essence writes a crafted modifier, and only one may sit on an item
    if (hasCrafted) return false;
    // a perfect essence replaces, so it only needs something to replace
    if (isPerfectEss(e)) return essReplacePool(st.affixes, e.a).length > 0;
    return st.affixes.length < effLimit('total') && countBy(st, e.a) < effLimit(e.a);
  });
  if (anyEss) push('essence', 'essence', 'Essence\u2026', null);
  return out;
}

/* Stable keybind ordering for the emulator rail. optionsFor lists the tiered
   add-orbs (Transmute/Aug/Regal) before Annul/Divine, so those two jump numbers
   as add-orbs appear and vanish with item fullness. Ranking Annul/Divine first
   pins their keys (they're available whenever the item has mods); the volatile
   add-orbs sort after them. The rest keeps optionsFor's order, so a finished
   rare still reads Annul \u00b7 Divine \u00b7 Infuser \u00b7 Vaal \u00b7 Lock \u00b7 Exalt \u00b7 Chaos \u2026 */
const RAIL_RANK = {
  annul: 0, divine: 1,
  transmute: 2, aug: 3, regal: 4,
  reveal: 5, quality: 6, vaalinfuse: 7, vaal: 8, hinekora: 9,
  exalted: 10, chaos: 11, fracture: 12, bone: 13, essence: 14, architect: 15,
};
const railKey = o => {
  const k = o.kind === 'orb' ? o.cur : o.kind;
  const tierIdx = o.tier === 'III' ? 2 : o.tier === 'II' ? 1 : 0;
  return (RAIL_RANK[k] != null ? RAIL_RANK[k] : 50) * 10 + tierIdx;
};
/** The emulator rail's options in stable keybind order. */
function emRailOpts() {
  return optionsFor(em, true)
    .map((o, i) => [o, i])
    .sort((a, b) => railKey(a[0]) - railKey(b[0]) || a[1] - b[1])
    .map(x => x[0]);
}
/* Keyboard slots for the rail: 1-9, then 0 for the tenth, then top-row letters
   for the rest (a rare weapon can offer ~16 currencies). Skips the keys already
   bound to actions (R U Z S L N M) so nothing collides. */
const RAILKEYS = ['1','2','3','4','5','6','7','8','9','0',
                  'q','w','e','t','y','i','o','p','a','d','f','g','h','j','k'];

/** Modifiers this step could actually roll, with their share of pool weight. */
/**
 * Chance a wanted modifier shows up among the reveal's options.
 *
 * The options are DISTINCT modifiers, so this is weighted sampling without
 * replacement, not three independent rolls. That distinction is not academic
 * here: a desecrated pool is small, so a wanted modifier can hold a fifth of
 * the weight, and pretending the draws are independent understates the real
 * chance by several percent. The pool is small enough to enumerate exactly.
 */
function revealHitChance(P, want) {
  const wantKey = new Set(want.map(m => m.g + '|' + m.a));
  const others = P.list.filter(m => !wantKey.has(m.g + '|' + m.a)).map(m => m.w);
  // fewer distinct modifiers than options means every one of them is shown
  if (others.length < REVEAL_OPTS) return 1;

  // Enumerating n^k paths is fine for a real desecrated pool; fall back to the
  // independent-draw approximation if a pool is ever unexpectedly wide.
  if (others.length > 60) {
    const q = want.reduce((a, m) => a + m.w, 0) / P.tot;
    return 1 - Math.pow(1 - q, REVEAL_OPTS);
  }
  const used = new Array(others.length).fill(false);
  const miss = (left, depth) => {
    if (depth === 0) return 1;
    let acc = 0;
    for (let i = 0; i < others.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      acc += (others[i] / left) * miss(left - others[i], depth - 1);
      used[i] = false;
    }
    return acc;
  };
  return 1 - miss(P.tot, REVEAL_OPTS);
}

function stepPool(s) {
  const i = plan.indexOf(s), D = stepDef(s);
  if (!D || s.kind === 'essence' || s.kind === 'fracture' || s.kind === 'annul'
        || s.kind === 'architect') return null;
  const before = stateBefore(i);
  if (s.kind === 'reveal') {
    const held = before.affixes.find(a => a.un);
    if (!held) return null;
    const c = revealCandidates(before, held);
    const byMod0 = new Map();
    for (const e of c.pool) {
      const k = e.m.g + '|' + e.m.a;
      if (!byMod0.has(k))
        byMod0.set(k, { g: e.m.g, a: e.m.a, name: e.m.n, w: 0, best: e.t[0], u: e.m.u,
                        g2: e.m.g2, tiers: [] });
      const o = byMod0.get(k);
      o.w += e.w; o.best = Math.min(o.best, e.t[0]);
      o.tiers.push({ t: e.t[0], ilvl: e.t[1], v: e.t[2], w: e.w, x: e.m.x });
    }
    for (const o of byMod0.values()) o.tiers.sort((x, y) => x.t - y.t);
    return { list: [...byMod0.values()].sort((x, y) => y.w - x.w), tot: c.tot, reveal: c };
  }
  const affs = before.affixes;
  const probe = asItem({ rarity: D.to || before.rarity, affixes: affs });
  const min = D.bone ? (D.bone.min || 0) : (D.tiered ? minFor(s.cur, s.tier) : 0);
  const max = D.bone && D.bone.max ? D.bone.max : Infinity;
  const src = s.kind === 'vaal' ? COR
            : (s.kind === 'bone' || s.kind === 'reveal') ? DES : MODS;
  let rows = eligible(probe, null, min, max, src);
  rows = omenNarrow(rows, s, stateBefore(i)).pool;
  const tot = rows.reduce((a, e) => a + e.w, 0);
  const byMod = new Map();
  for (const e of rows) {
    const k = e.m.g + '|' + e.m.a;
    if (!byMod.has(k))
      byMod.set(k, { g: e.m.g, a: e.m.a, name: e.m.n, w: 0, best: e.t[0], u: e.m.u,
                     g2: e.m.g2, tiers: [] });
    const o = byMod.get(k);
    o.w += e.w; o.best = Math.min(o.best, e.t[0]);
    o.tiers.push({ t: e.t[0], ilvl: e.t[1], v: e.t[2], w: e.w, x: e.m.x });
  }
  for (const o of byMod.values()) o.tiers.sort((x, y) => x.t - y.t);
  return { list: [...byMod.values()].sort((x, y) => y.w - x.w), tot };
}

/**
 * Share of a tier's window that clears a minimum value.
 *
 * A tier is a uniform window, so demanding "T1 AND at least 105%" is the tier's
 * own weight multiplied by the fraction of that window at or above the
 * threshold. The check is on the FIRST rolled value, which is the stat people
 * actually gate on; a hybrid's second number rides along with it.
 */
function valueFrac(tierTuple, minV) {
  if (!minV) return 1;
  const r = tierTuple[2] && tierTuple[2][0];
  if (!r) return 1;
  const [lo, hi] = r;
  if (minV <= lo) return 1;
  if (minV > hi) return 0;
  // integer rolls, so count the qualifying values rather than the span
  const step = Number.isInteger(lo) && Number.isInteger(hi) ? 1 : 0;
  return step ? (hi - minV + 1) / (hi - lo + 1) : (hi - minV) / (hi - lo);
}

/**
 * What a reveal can actually turn up.
 *
 * The unrevealed line already owns a prefix or suffix slot, so every candidate
 * has to match that side. Beyond that the pool depends on whether an Abyss omen
 * was spent on the bone: with one, the reveal is confined to the desecrated pool
 * (and to a single lich's set if a faction omen was used); with none, it can
 * also surface an ordinary modifier, which is what makes an un-omened bone a way
 * to fish for a normal prefix.
 *
 * The two pools are published on different scales - desecrated modifiers carry
 * no spawn weights at all, ordinary ones run into the thousands - so putting
 * them side by side raw would let the normal pool swamp the desecrated one
 * entirely. They are balanced to contribute equally instead, which is an
 * assumption rather than something the data states.
 */
function revealCandidates(st, held) {
  const rest = st.affixes.filter(a => a !== held);
  const probe = asItem({ rarity: st.rarity, affixes: rest });
  const side = held.a === 'p' || held.a === 's' ? held.a : null;
  let des = eligible(probe, side, 0, Infinity, DES);

  const om = held.rOmen ? omenById(held.rOmen) : null;
  const fx = omenFx(om);
  // Only a faction (lich) omen confines a reveal to the desecrated pool - it was
  // spent to guarantee that lich's modifier. A side-forcing Necromancy omen only
  // chose the slot's side at bone time, so the reveal still mixes the normal pool
  // in, exactly like an un-omened bone.
  if (fx === 'lich') {
    const tag = LICHTAG[om.c];
    des = des.filter(e => (e.m.g2 || []).includes(tag));
    return { pool: des, tot: des.reduce((a, e) => a + e.w, 0), omened: true };
  }

  // a higher-tier bone (Preserved/Ancient) lifts the floor, cutting low tiers of
  // the ordinary pool out of the reveal; desecrated modifiers are unaffected
  let norm = eligible(probe, side, held.rMin || 0, Infinity, MODS);
  const dt = des.reduce((a, e) => a + e.w, 0), nt = norm.reduce((a, e) => a + e.w, 0);
  if (dt && nt) { const k = dt / nt; norm = norm.map(e => ({ ...e, w: e.w * k })); }
  const pool = des.concat(norm);
  return { pool, tot: pool.reduce((a, e) => a + e.w, 0), omened: false, desTot: dt };
}

/** Fill a mod template with its rolled range, e.g. "+(81-90) to maximum ES". */
function renderRange(tmpl, vals) {
  return (tmpl || '').replace(/\{(\d+)\}/g, (_, k) => {
    const v = vals && vals[k];
    if (!v) return 'X';
    return v[0] === v[1] ? v[0] : `${v[0]}-${v[1]}`;
  }).split('\n').join('  +  ');
}

/** Prefix/suffix occupancy against the ceiling the rarity allows. */
function capacity(st) {
  const lim = LIM(st.rarity);
  const np = st.affixes.filter(a => a.a === 'p').length;
  const ns = st.affixes.filter(a => a.a === 's').length;
  if (!lim.total) return `<div class="cap"><span class="capk">no modifiers</span>
    <span class="capn">a Normal item is the bare base</span></div>`;
  const pip = (n, max, cls) => Array.from({ length: max }, (_, i) =>
    `<i class="pip ${cls}${i < n ? ' on' : ''}"></i>`).join('');
  const full = st.affixes.length >= lim.total;
  return `<div class="cap">
    <span class="capk">${np + ns} / ${lim.total}</span>
    <span class="pips">${pip(np, lim.p, 'p')}<b class="sep"></b>${pip(ns, lim.s, 's')}</span>
    <span class="capn${full ? ' full' : ''}">${full ? 'full' : `${lim.p - np}P ${lim.s - ns}S free`}</span>
  </div>`;
}

/** Icon rail of legal next steps, appended after the step at index i. */
function rail(i, afterId) {
  const opts = nextOptions(i);
  if (!opts.length) return '';
  return `<div class="rail">
    <span class="railk">next</span>
    ${opts.map(o => `<button class="railb" title="${esc(o.label)}"
        data-add="${o.kind}:${o.cur}:${o.ref || ''}:${afterId === null ? '' : afterId}:${o.tier || 'I'}"
      >${sigil(o.icon)}${o.tier && o.tier !== 'I'
          ? `<span class="railtier">${ROMAN[o.tier]}</span>` : ''}</button>`).join('')}
  </div>`;
}

/**
 * Snapshot list: the item as it stands after each step. Clicking a row rewinds
 * the plan to that point so a different continuation can be explored from there;
 * the discarded tail is stashed so the rewind itself can be undone.
 */
function drawHistory() {
  const box = document.getElementById('histlist');
  if (!box) return;
  const rows = [];
  const snap = (label, sub, st, idx, cur) => {
    const np = st.affixes.filter(a => a.a === 'p').length;
    const ns = st.affixes.filter(a => a.a === 's').length;
    const fx = st.affixes.filter(a => a.fx).length;
    rows.push(`<div class="hrow${idx === plan.length ? ' now' : ''}" data-hist="${idx}">
      <div class="hn">${idx === 0 ? '&#9679;' : idx}</div>
      <div class="hb">
        <div class="ht">${cur ? `${ICONS[cur] ? `<img class="hico" src="${ICONS[cur]}" alt="">` : ''}` : ''}${esc(label)}</div>
        <div class="hs">${esc(sub)}</div>
        <div class="hpips">
          <span class="hr ${st.rarity}">${RNAME[st.rarity]}</span>
          <span class="hc">${np}P &middot; ${ns}S</span>
          ${fx ? `<span class="hfx">&#128274;${fx}</span>` : ''}
        </div>
      </div>
    </div>`);
  };

  snap('Base item', state.base ? state.base.n : '', stateBefore(0), 0, null);
  plan.forEach((s, i) => {
    const D = stepDef(s);
    if (!D) return;
    const om = s.omen ? omenById(s.omen) : null;
    snap(D.name + (om ? ' + ' + om.n.replace(/^Omen of (the )?/, '') : ''),
         (s.targets && s.targets.length ? s.targets.map(t => t.name).join(', ')
          : s.kind === 'fracture' ? 'lock a modifier' : 'no target'),
         stateBefore(i + 1), i + 1, D.icon);
  });
  box.innerHTML = rows.join('');
  box.querySelectorAll('[data-hist]').forEach(r => r.onclick = () => rewind(+r.dataset.hist));
  const u = document.getElementById('histundo');
  if (u) u.hidden = !histStash.length;
}

let histStash = [];        // steps removed by the most recent rewind

function rewind(n) {
  if (n >= plan.length) return;           // already at or past this point
  histStash = plan.slice(n);
  plan = plan.slice(0, n);
  selStep = plan.length ? plan[plan.length - 1].id : null;
  openPool = new Set(); openTier = new Set();
  tidy();
}

/* Plain-language purpose of each currency, shown on hover so a new player knows
   which does what. Orbs are keyed by their currency; the rest by kind. */
const CURDESC = {
  transmute: 'Turns a Normal item Magic and adds one modifier.',
  aug: 'Adds one modifier to a Magic item.',
  regal: 'Turns a Magic item Rare and adds one modifier.',
  exalted: 'Adds one modifier to a Rare item.',
  chaos: 'Removes one random modifier, then adds a new one in its place.',
  annul: 'Removes one random modifier - it can take one you wanted.',
  divine: 'Rerolls the numeric values of every modifier within their current tiers.',
  vaal: 'Corrupts and seals the item: no change, add a corrupted mod, reroll every value by 0.78x-1.22x (can beat the tier max), or +1 socket on some bases. Nothing may follow.',
  architect: 'Corrupted items only, once: 50% adds Twice Corrupted plus a corruption enchant (never a socket, reroll, or removal; no duplicate mod group), 50% destroys the item.',
  fracture: 'Locks one existing modifier at random so it can never be removed or rerolled.',
  reveal: 'Resolves one unrevealed desecrated modifier - you keep one of three shown.',
  essence: 'Guarantees a specific modifier (an item holds at most one crafted mod).',
  hinekora: "Hinekora's Lock (~1200 div, the game's 2nd most expensive item): foresee the next currency's outcome before committing. Arm it, then use a currency to preview the result - the outcome is seeded by the item's quality, so change quality (an infuser) to re-roll the foresight. In a plan it is a costed marker only; it does not change the odds.",
};
function curDescOf(o) {
  let d = o.kind === 'bone'
    ? 'Adds an unrevealed desecrated modifier. A higher-tier bone (Preserved, then Ancient) raises the minimum level of the ordinary mods a reveal can surface.'
    : (CURDESC[o.kind === 'orb' ? o.cur : o.kind] || '');
  if (o.tier === 'II') d += ' (Greater: skips the lowest tiers.)';
  else if (o.tier === 'III') d += ' (Perfect: only the top tiers.)';
  return d;
}

/* A single cursor-following tooltip for any element carrying data-tip. */
(function () {
  const tip = document.getElementById('tiptip');
  if (!tip) return;
  let cur = null;
  const place = (x, y) => {
    const pad = 12, w = tip.offsetWidth, h = tip.offsetHeight;
    let L = x + 16, T = y + 18;
    if (L + w > innerWidth - pad) L = x - w - 16;
    if (T + h > innerHeight - pad) T = innerHeight - h - pad;
    tip.style.left = Math.max(pad, L) + 'px';
    tip.style.top = Math.max(pad, T) + 'px';
  };
  document.addEventListener('mouseover', e => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t) return;
    cur = t; tip.innerHTML = '';
    const nm = t.getAttribute('data-tipname');
    if (nm) { const b = document.createElement('b'); b.textContent = nm; tip.appendChild(b); }
    tip.appendChild(document.createTextNode(t.getAttribute('data-tip') || ''));
    tip.hidden = false; place(e.clientX, e.clientY);
  });
  document.addEventListener('mousemove', e => { if (!tip.hidden && cur) place(e.clientX, e.clientY); });
  document.addEventListener('mouseout', e => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t && t === cur) { tip.hidden = true; cur = null; }
  });
})();

/** The art for an omen (its poe2db icon), or a category-letter fallback. */
function omenIco(o) {
  const src = ICONS['om:' + o.c];
  if (src) return `<img class="omicoimg" src="${src}" alt="" draggable="false">`;
  const g = o.f === 'prefix' ? 'P' : o.f === 'suffix' ? 'S' : '\u25c8';
  return `<span class="omicofb">${g}</span>`;
}

/**
 * One omen chip: its icon and short name. When armed it takes a red border, the
 * way the game frames an activated omen. `data` is the value put on data-omen
 * (the emulator uses the omen id, a plan step uses "stepId:omenId").
 */
function omenChip(o, active, data, extra) {
  const short = o.n.replace(/^Omen of (the )?/, '');
  // abyss/desecration omens take the acid rim, not the red one, so a bone-omen
  // reads as such before it is spent
  const abyss = /^OmenOnAbyss/.test(o.c || '');
  return `<button class="omchip${abyss ? ' abyss' : ''}${active ? ' on' : ''}" data-omen="${data}"
    data-tipname="${esc(o.n)}" data-tip="${esc(omenExplain(o) || 'A special omen - its effect shows when it is armed.')}">
    <span class="omico">${omenIco(o)}</span>
    <span class="omname">${esc(short)}</span>${extra || ''}
  </button>`;
}

/** Omen chips for a step: click to arm or disarm one. */
function omenRow(s) {
  const list = stepOmens(s);
  if (!list.length) return '';
  const on = s.omen ? omenById(s.omen) : null;
  const short = n => n.replace(/^Omen of (the )?/, '');
  return `<div class="omrow">
    <span class="railk">omen</span>
    ${list.map(o => omenChip(o, s.omen === o.i, s.id + ':' + esc(o.i),
        o.f ? `<i class="omside ${o.f === 'prefix' ? 'p' : 's'}">${o.f === 'prefix' ? 'P' : 'S'}</i>` : '')).join('')}
    ${on ? `<span class="omnote">${esc(omenExplain(on))}</span>` : ''}
  </div>`;
}

/** One line describing what an armed omen does to this roll. */
function omenExplain(o) {
  const fx = omenFx(o);
  if (fx === 'force') return `forces the roll onto a ${o.f} - the other side leaves the pool`;
  if (fx === 'homog') return 'restricts the roll to modifiers sharing a tag with one already on the item';
  if (fx === 'two') return 'acts on two modifiers instead of one (the closed-form odds still count one)';
  if (fx === 'reroll') return 'rerolls the options once, so a miss gets a second set';
  if (fx === 'desec') return 'removes only the desecrated modifier';
  if (fx === 'lich') return 'guarantees this lich&rsquo;s desecrated modifier set';
  if (fx === 'essside') return 'forces a perfect essence to replace one side (Sinistral: prefix, Dextral: suffix)';
  if (fx === 'lowest') return 'targets the lowest-level modifier (not yet reflected in the odds)';
  return '';
}

/** The poe2db currency id for a step, which is what omen reqids are keyed on. */
function stepCurId(s) {
  if (s.kind === 'bone') return 'bone';
  const m = CURID[s.cur];
  return (m && m[s.tier || 'I']) || s.cur;
}

/** Omens that can be armed on this step's currency. */
function stepOmens(s) {
  if (s.kind === 'fracture') return [];
  // Crystallisation pairs with a perfect essence
  if (s.kind === 'essence') return OMENS.filter(o => OMENFX[o.c] === 'essside');
  // The Abyss omens carry no currency ids in the source data, so they would
  // never match by reqid alone; they are keyed on their code instead.
  if (s.kind === 'bone')
    return OMENS.filter(o => /^OmenOnAbyss/.test(o.c || '') &&
                            (OMENFX[o.c] === 'force' || OMENFX[o.c] === 'lich'));
  if (s.kind === 'reveal')
    return OMENS.filter(o => OMENFX[o.c] === 'reroll');
  if (s.kind === 'annul')
    return OMENS.filter(o => (o.r || []).includes('annu') && OMENFX[o.c]);
  const id = stepCurId(s);
  return OMENS.filter(o => (o.r || []).includes(id) && OMENFX[o.c]);
}

/**
 * Which modifiers an Annulment could actually take. A fractured modifier is
 * always immune; an armed omen narrows it further - Sinistral and Dextral
 * Annulment to one side, and Omen of Light to the desecrated modifier alone,
 * which is what makes it a precision tool rather than a gamble.
 */
function annulPool(affixes, s) {
  // corrupted implicit lines are not explicit modifiers and cannot be removed;
  // a fractured modifier is immune too
  let out = affixes.filter(a => !a.fx && a.a !== 'c');
  const o = s && s.omen ? omenById(s.omen) : null;
  const fx = omenFx(o);
  if (fx === 'desec') out = out.filter(a => a.cat === 'desecrated');
  else if (fx === 'force') out = out.filter(a => a.a === (o.f === 'prefix' ? 'p' : 's'));
  else if (fx === 'lowest') {
    // Whittling takes the lowest-LEVEL modifier, not the highest tier number
    const worst = lowestMod(out);
    out = worst ? [worst] : [];
  }
  return out;
}

/**
 * Narrow a step's mod pool by the armed omen. This is the "focusing" players use
 * to beat the flat weights: a Sinistral/Dextral omen forces the roll onto one
 * side, so the whole opposite side leaves the denominator; a Homogenising omen
 * restricts it to modifiers sharing a tag with something already on the item.
 */
function omenNarrow(pool, s, before) {
  const o = s.omen ? omenById(s.omen) : null;
  const fx = omenFx(o);
  if (!fx) return { pool, fx: null, o: null };
  if (fx === 'force') {
    const side = o.f === 'prefix' ? 'p' : 's';
    return { pool: pool.filter(e => e.m.a === side), fx, o, side };
  }
  if (fx === 'lich') {
    const tag = LICHTAG[o.c];
    const nar = pool.filter(e => (e.m.g2 || []).includes(tag));
    return { pool: nar, fx, o, tag, weak: !nar.length };
  }
  if (fx === 'homog') {
    const tags = new Set();
    for (const a of before.affixes) {
      const m = MODS.find(x => x.g === a.g && x.a === a.a && x.c.includes(state.slug))
             || MODS.find(x => x.g === a.g && x.a === a.a);
      for (const t of (m && m.g2) || []) tags.add(t);
    }
    if (!tags.size) return { pool, fx, o, weak: true };
    const nar = pool.filter(e => (e.m.g2 || []).some(t => tags.has(t)));
    return { pool: nar.length ? nar : pool, fx, o, weak: !nar.length };
  }
  return { pool, fx, o };          // 'two' / 'lowest' are shown but not narrowed
}

/** Fracture picker: choose which of the item's own modifiers to lock in gold. */
function fracturePanel(s, before) {
  const isAnn = s.kind === 'annul';
  const locked = before.affixes.filter(a => a.fx);
  // a fracture cannot touch an unrevealed desecrated modifier; an Annul can,
  // but an armed omen may narrow what it is allowed to take
  const annOk = isAnn ? new Set(annulPool(before.affixes, s).map(a => a.g + '|' + a.a)) : null;
  const legal = a => isAnn ? annOk.has(a.g + '|' + a.a) : (!a.fx && !a.un);
  const free = before.affixes.filter(legal);
  const blocked = before.affixes.filter(a => !a.fx && !legal(a));
  const pick = s.fxPick;
  const row = (a, ok) => {
    const on = ok && pick && pick.g === a.g && pick.a === a.a;
    const nm = a.name || (MODS.find(x => x.g === a.g && x.a === a.a) || {}).n || a.g;
    return `<div class="prow${on ? ' on' : ''}${ok ? '' : ' off'}"${
      ok ? ` data-fx="${s.id}:${esc(a.g)}|${a.a}"` : ''}>
      <span></span>
      <span class="tag ${a.a}">${a.a === 'p' ? 'P' : 'S'}</span>
      <span class="pn">${a.rand ? '<i>random modifier</i>' : esc(nm)}${
        a.un ? ' <span class="unrev">unrevealed</span>' : ''}</span>
      <span class="pt">${a.tier ? 'T' + a.tier : ''}</span>
      <span class="pp">${on ? (isAnn ? 'remove' : 'lock') : (ok ? '' : 'safe')}</span>
    </div>`;
  };
  const rows = free.map(a => row(a, true)).join('') +
               blocked.map(a => row(a, false)).join('');
  const foot = isAnn
    ? `an Annulment strips one modifier at random; fractured modifiers are immune &mdash; ${
        pick ? 'chance it takes the one you picked is 1 in ' + free.length
             : 'pick the modifier you are trying to remove'}`
    : `a fracture locks the chosen modifier in gold so Chaos, Annulment and other currency can
       never move it &mdash; ${pick ? 'chance the random lock hits it is 1 in ' + free.length
       : 'pick which modifier you want kept'}${blocked.length
       ? `. ${blocked.length} unrevealed desecrated modifier${blocked.length === 1 ? '' : 's'}
          cannot be fractured, which is what shortens these odds` : ''}`;
  return `<div class="trow" style="border:0">
      <span class="tag op">${isAnn ? 'REMOVE' : 'LOCK'}</span>
      <span>${free.length} ${isAnn ? 'removable' : 'fracturable'}${
        locked.length ? `, ${locked.length} fractured` : ''}${
        blocked.length ? `, ${blocked.length} unrevealed` : ''}</span>
    </div>
    <div class="pool">
      <div class="poollist">${rows || `<div class="m ghost">nothing here can be ${
        isAnn ? 'removed' : 'fractured'}</div>`}</div>
      <div class="poolfoot">${foot}</div>
    </div>`;
}

/** Inline modifier list for a step: every mod it can roll, with pool share. */
function poolPanel(s) {
  const P = stepPool(s);
  if (!P) return '';
  const q = (poolQ[s.id] || '').toLowerCase();
  const chosen = new Set(s.targets.map(t => t.g + '|' + t.a));
  const rows = P.list.filter(m => !q || m.name.toLowerCase().includes(q));
  return `<div class="pool">
    <input class="poolq" placeholder="filter ${P.list.length} modifiers\u2026"
      value="${esc(poolQ[s.id] || '')}" data-poolq="${s.id}">
    <div class="poollist">
      ${rows.length ? rows.map(m => {
        const k = m.g + '|' + m.a, on = chosen.has(k);
        const tgt = s.targets.find(t => t.g === m.g && t.a === m.a);
        const pct = P.tot ? (m.w / P.tot * 100) : 0;
        const tk = s.id + ':' + k, isOpen = openTier.has(tk);
        return `<div class="prow${on ? ' on' : ''}">
          <span class="chev${isOpen ? ' open' : ''}" data-tier="${esc(tk)}"
            title="show tiers">&rsaquo;</span>
          <span class="tag ${m.a}" data-pick="${s.id}:${esc(k)}">${m.a === 'p' ? 'P' : 'S'}</span>
          <span class="pn" data-pick="${s.id}:${esc(k)}">${esc(m.name)}${
            tgt && tgt.maxTier ? ` <span class="tgt">T${tgt.maxTier}+</span>` : ''}</span>
          <span class="pt" data-pick="${s.id}:${esc(k)}">T${m.best}</span>
          <span class="pp" data-pick="${s.id}:${esc(k)}">${m.u ? '&mdash;' : pct.toFixed(1) + '%'}</span>
        </div>` + (isOpen ? m.tiers.map(t => `<div class="trow2${
            tgt && tgt.maxTier === t.t ? ' on' : ''}" data-ptier="${esc(tk)}:${t.t}">
            <span class="tb">T${t.t}</span>
            <span class="tv">${esc(renderRange(t.x, t.v))}</span>
            <span class="ti">i${t.ilvl}${tgt && tgt.minV
              ? ' &middot; ' + Math.round(valueFrac([t.t, t.ilvl, t.v], tgt.minV) * 100) + '% clears'
              : ''}</span>
            <span class="pp">${m.u ? '&mdash;' : (P.tot ? (t.w / P.tot * 100).toFixed(2) : '0') + '%'}</span>
          </div>`).join('') : '');
      }).join('') : '<div class="m ghost">nothing matches that filter</div>'}
    </div>
    <div class="poolfoot">click to add or remove a target &middot; share is of this step's
      ${P.tot ? P.tot.toLocaleString() + ' weight' : 'pool'}</div>
  </div>`;
}

/** Target picker reuses the step dropdown row, swapping in modifier options. */
function openTargetPicker(id) {
  const s = plan.find(x => x.id === id);
  if (!s) return;
  const i = plan.indexOf(s);
  const D = stepDef(s);
  if (!D || s.kind === 'essence' || s.kind === 'fracture') return;
  const probe = asItem({ rarity: D.to || stateBefore(i).rarity, affixes: stateBefore(i).affixes });
  const min = D.tiered ? minFor(s.cur, s.tier) : 0;
  const src = s.kind === 'bone' ? DES : MODS;
  const seen = new Map();
  for (const e of eligible(probe, null, D.bone ? (D.bone.min || 0) : min,
                           D.bone && D.bone.max ? D.bone.max : Infinity, src)) {
    const k = e.m.g + '|' + e.m.a;
    if (!seen.has(k)) seen.set(k, { g: e.m.g, a: e.m.a, name: e.m.n, best: e.t[0] });
    else seen.get(k).best = Math.min(seen.get(k).best, e.t[0]);
  }
  const opts = [...seen.values()].sort((x, y) => x.name.localeCompare(y.name));
  const sel = document.getElementById('stepadd');
  sel.dataset.mode = 'target:' + id;
  sel.innerHTML = `<option value="">choose a modifier for this step…</option>` +
    `<option value="__back">← back to adding steps</option>` +
    opts.map(o => `<option value="${esc(o.g)}|${o.a}">${o.a === 'p' ? 'prefix' : 'suffix'} — ${
      esc(o.name)} (best T${o.best})</option>`).join('');
}

function stepMenu() {
  const sel = document.getElementById('stepadd');
  sel.dataset.mode = 'step';
  const last = plan.length ? (stepDef(plan[plan.length - 1]) || {}).to || state.rarity
                           : state.rarity;
  const nMods = stateBefore(plan.length).affixes.length;
  const g = [];

  const orbs = [];
  for (const [k, C] of Object.entries(STEPCUR)) {
    const usable = C.from.includes(last);
    for (const t of (C.tiered ? ['I', 'II', 'III'] : ['I'])) {
      orbs.push(`<option value="orb:${k}:${t}"${usable ? '' : ' disabled'}>${
        esc(curName(k, t))}${usable ? '' : ' — needs ' + C.from.map(r => RNAME[r]).join('/')}</option>`);
    }
  }
  g.push(`<optgroup label="Orbs">${orbs.join('')}</optgroup>`);

  const ess = ESS.filter(e => e.c.includes(state.slug) && e.rl <= state.ilvl);
  if (ess.length) {
    const rows = ess.map(e => {
      const needRare = e.ti === 'perfect' || e.ti === 'special';
      const ok = last === (needRare ? 'rare' : 'magic');
      return `<option value="ess:${esc(e.i)}"${ok ? '' : ' disabled'}>${esc(e.n)}${
        ok ? '' : ' — needs ' + (needRare ? 'Rare' : 'Magic')}</option>`;
    });
    g.push(`<optgroup label="Essences — guaranteed modifier">${rows.join('')}</optgroup>`);
  }

  const bones = BONES.filter(b => b.classes.includes(state.slug));
  if (bones.length) {
    const rows = bones.map(b => {
      const ok = last === 'rare';
      const win = b.max ? ` (\u2264 ${b.max})` : b.min ? ` (\u2265 ${b.min})` : '';
      return `<option value="bone:${esc(b.id)}"${ok ? '' : ' disabled'}>${esc(b.name)}${win}${
        ok ? '' : ' — needs Rare'}</option>`;
    });
    g.push(`<optgroup label="Abyssal bones — desecrated pool">${rows.join('')}</optgroup>`);
  }

  const canFrac = last === 'rare' && nMods >= 4;
  g.push(`<optgroup label="Other"><option value="frac:"${canFrac ? '' : ' disabled'}>` +
         `Fracturing Orb${canFrac ? '' : ` — needs Rare with 4+ mods (have ${nMods})`}</option></optgroup>`);

  sel.innerHTML = `<option value="">add a step…</option>` + g.join('');
}

function addStep(cur, tier, at = null, kind = 'orb', ref = null) {
  // failing an Architect's Orb destroys the item, so the policy is not optional
  const forcedFail = kind === 'architect' ? 'brick' : 'retry';
  const i = at === null || at > plan.length ? plan.length : Math.max(0, at);
  plan.splice(i, 0, { id: ++planSeq, kind, cur, tier, ref, targets: [], mode: 'either',
                      fail: forcedFail, rec: null, x: 0, y: 0 });
  selStep = planSeq;
  // Only the step being worked on keeps its modifier list open: with the flow
  // running top to bottom, several open lists push the chain off the screen.
  openPool = new Set();
  openTier = new Set();
  if (kind !== 'essence' && kind !== 'fracture') openPool.add(planSeq);
  tidy();                       // inserting mid-chain would otherwise overlap
  stepMenu();
}

function tidy() {
  // Arrangement is automatic now, so Tidy just re-frames: redraw, then bring the
  // card being worked on into view without scrolling the page.
  drawPlan();
  const card = document.querySelector('.card.sel'), cv = document.getElementById('canvas');
  if (card && cv) {
    const want = card.offsetLeft * zoom + card.offsetWidth * zoom - cv.clientWidth + 40;
    if (want > cv.scrollLeft) cv.scrollLeft = Math.max(0, want);
    else if (card.offsetLeft * zoom < cv.scrollLeft) cv.scrollLeft = Math.max(0, card.offsetLeft * zoom - 40);
    const wantY = card.offsetTop * zoom + card.offsetHeight * zoom - cv.clientHeight + 40;
    if (wantY > cv.scrollTop) cv.scrollTop = Math.max(0, wantY);
    else if (card.offsetTop * zoom < cv.scrollTop) cv.scrollTop = Math.max(0, card.offsetTop * zoom - 40);
  }
}

/** Essences are numerous, so the rail opens a filtered list instead of icons. */
function openEssencePick(at) {
  const st = stateBefore(at);
  const rows = ESS.filter(e => {
    if (!e.c.includes(state.slug) || e.rl > state.ilvl) return false;
    const needRare = e.ti === 'perfect' || e.ti === 'special';
    return needRare ? st.rarity === 'rare' : st.rarity === 'magic';
  });
  if (!rows.length) return;
  const sel = document.getElementById('stepadd');
  sel.dataset.mode = 'insert:' + at;
  sel.innerHTML = `<option value="">choose an essence to insert\u2026</option>` +
    `<option value="__back">\u2190 back to adding steps</option>` +
    rows.map(e => `<option value="ess:${esc(e.i)}">${esc(e.n)} &mdash; ${
      esc(e.x.replace(/\{\d+\}/g, 'X').split('\n')[0])}</option>`).join('');
  sel.focus();
}

function setView(v) {
  view = v;
  document.getElementById('benchview').classList.toggle('hidden', v !== 'bench');
  document.getElementById('graphview').classList.toggle('hidden', v !== 'graph');
  document.getElementById('desecview').classList.toggle('hidden', v !== 'desec');
  const pv = document.getElementById('pricesview');
  if (pv) pv.classList.toggle('hidden', v !== 'prices');
  document.querySelectorAll('#viewpick button').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  if (v === 'graph') { stepMenu(); drawPlan(); }
  if (v === 'bench') { drawItem(); drawOdds(); }
  if (v === 'desec') drawDesec();
  if (v === 'prices') drawPrices();
}

document.querySelectorAll('#viewpick button').forEach(b =>
  b.onclick = () => setView(b.dataset.v));
document.querySelectorAll('#excpick button').forEach(b => b.onclick = () => {
  exceptional = b.dataset.exc || null;
  document.querySelectorAll('#excpick button').forEach(x =>
    x.setAttribute('aria-pressed', String((x.dataset.exc || null) === exceptional)));
  state.exceptional = exceptional;
  draw();
  if (view === 'graph') { stepMenu(); drawPlan(); }
  if (em) { em.exceptional = exceptional;
    if (!document.getElementById('emu').classList.contains('hidden')) drawEmu(); }
});
document.querySelectorAll('#runepick button').forEach(b => b.onclick = () => {
  const k = b.dataset.rune;
  if (runeSockets() < 1) return;              // nowhere to socket a rune
  if (runes[k]) { runes[k] = 0; }             // toggle this rune off
  else {
    runes[k] = 1;                             // one of each is allowed
    // but the total socketed cannot exceed the item's sockets; if it would,
    // drop the other rune to make room (each rune uses one socket)
    const on = Object.keys(runes).filter(x => runes[x]);
    if (on.length > runeSockets())
      for (const x of on) if (x !== k) runes[x] = 0;
  }
  document.querySelectorAll('#runepick button').forEach(x =>
    x.setAttribute('aria-pressed', String(!!runes[x.dataset.rune])));
  // caps just changed, so re-solve whatever is on screen
  draw();
  if (view === 'graph') { stepMenu(); drawPlan(); }
  if (em && !document.getElementById('emu').classList.contains('hidden')) drawEmu();
});
/* ---- first-run wizard: the two-step story of the tool ---- */
const OB_LS = 'poe2planner.onboard.v1';
let obIdx = 0;
/* scene builders for the illustrated wizard - plain string concat so the
   visuals carry no template-literal traps */
function obOrbChip(color, label) {
  return '<span class="oborb"><span class="obod" style="background:' + color + '"></span>' + label + '</span>';
}
function obItem(name, rar, mods, foot) {
  var rows = mods.map(function (m) {
    var badge = m.p ? '<span class="obmp">' + m.p + '</span>' : '';
    return '<div class="obm ' + (m.k || '') + '">' + badge + m.t + '</div>';
  }).join('');
  return '<div class="obitem ' + rar + '"><div class="obih">' + name + '</div>' +
    '<div class="obms">' + rows + '</div>' +
    (foot ? '<div class="obif">' + foot + '</div>' : '') + '</div>';
}
function obDistScene() {
  var hs = [7, 12, 20, 32, 48, 66, 83, 95, 100, 93, 81, 67, 53, 41, 31, 23, 17, 12, 8];
  var bars = hs.map(function (h, i) {
    var z = i < 4 ? 'luck' : i > 11 ? 'unluck' : 'exp';
    return '<span class="obbar ' + z + '" style="height:' + h + '%"></span>';
  }).join('');
  return '<div class="obdist"><div class="obbars">' + bars + '</div>' +
    '<div class="obaxis">' +
    '<span class="obmk luck"><b>&#127808; Luckiest</b><span>~120 div</span></span>' +
    '<span class="obmk exp"><b>&#9878; Expected</b><span>~380 div</span></span>' +
    '<span class="obmk unluck"><b>&#128128; Unluckiest</b><span>~1200 div</span></span>' +
    '</div></div>';
}
const OB = [
  { title: 'Welcome to the PoE2 Craft Planner',
    visual:
      '<div class="obflowt step1"><div class="obfn">&#128220;</div><div class="obft">1 &middot; Design</div>' +
      '<div class="obfs">on the Craft Graph</div></div>' +
      '<div class="obarrow">&#10142;</div>' +
      '<div class="obflowt step2"><div class="obfn">&#127922;</div><div class="obft">2 &middot; Emulate</div>' +
      '<div class="obfs">roll it for real</div></div>',
    body: `Crafting here is <b>two moves</b>. First you <b>design</b> the item you want &mdash; seeing every modifier that could land and its exact odds. Then you <b>emulate</b> that plan to find what it would <b>really cost</b> once the game&rsquo;s dice get involved.<br><br>Here&rsquo;s the whole thing in five quick screens.` },

  { kick: 'Step one &middot; The Craft Graph', title: 'Design your perfect item',
    visual:
      obItem('Vile Robe', 'normal', [{ t: '&mdash; white base, no mods yet &mdash;' }]) +
      '<div class="obmid"><span class="oborb"><span class="obod" style="background:#d7c07a"></span>Regal Orb</span>' +
      '<span class="obprob">62% this mod</span></div>' +
      obItem('Vile Robe', 'rare', [{ p: 'P', t: '+90 to maximum Life' }, { p: 'S', t: '+38% to Cold Resistance' }], 'every % solved from the pool'),
    body: `Pick a <b>base</b> up top, then <b>add currency steps</b> &mdash; Transmute, Regal, Exalt, essences, bones. Each step shows the <b>real mod pool</b> and the <b>exact odds</b> of every outcome, solved from poe2db and never guessed.<br><br>Chain them until the graph draws your dream item.` },

  { kick: 'Step two &middot; The Emulator', title: 'Now roll it for real',
    visual:
      obItem('Vile Robe', 'rare', [{ p: 'P', t: '+90 to maximum Life' }, { p: 'S', t: '+38% to Cold Resistance' }, { p: 'P', t: '+64 to maximum Mana' }]) +
      '<div class="oblog">' +
        '<div class="oborbs">' + obOrbChip('#d7c07a', 'Regal') + obOrbChip('#c8542a', 'Exalt') + obOrbChip('#7a4fb0', 'Vaal') + '</div>' +
        '<div class="oblogline"><b>Exalted Orb</b> &rarr; +38% to Cold Resistance</div>' +
        '<span class="obundo">&#8635; Undo last step</span>' +
      '</div>',
    body: `Happy with the plan? Hit <b>&#9654; Emulate a craft</b> and roll <b>one real item</b>, orb by orb &mdash; same pool, same weights, same luck as the game. Undo a bad step, socket runes, push quality, even corrupt it.<br><br>This is where the dream meets the dice.` },

  { kick: 'Luckiest &middot; Expected &middot; Unluckiest', title: 'See what luck really costs',
    visual: obDistScene(),
    body: `Behind the plan runs a <b>Monte&nbsp;Carlo</b> of a thousand crafts, so it quotes not one price but <b>three</b>. The bars show how often each total came up &mdash; your own bill lands somewhere on that curve depending on how the dice fall. <i>(Divine figures here are an example.)</i>` },

  { title: 'That&rsquo;s the whole idea',
    visual:
      '<div class="obrecap"><div class="obflowrow">' +
        '<div class="obflowt"><div class="obfn">&#128220;</div><div class="obft">Design</div></div>' +
        '<div class="obarrow">&#10142;</div>' +
        '<div class="obflowt"><div class="obfn">&#127922;</div><div class="obft">Emulate</div></div>' +
        '<div class="obarrow">&#10142;</div>' +
        '<div class="obflowt step2"><div class="obfn">&#128176;</div><div class="obft">True cost</div></div>' +
      '</div><div class="obcosts">' +
        '<span class="obcost luck">&#127808; ~120 div</span>' +
        '<span class="obcost exp">&#9878; ~380 div</span>' +
        '<span class="obcost unluck">&#128128; ~1200 div</span>' +
      '</div></div>',
    body: `<b>Design</b> it on the graph, then <b>emulate</b> it to see the luckiest, expected and unluckiest cost in <b>divines</b>. That gap <i>is</i> the thrill of crafting &mdash; and now you can see it before spending a single orb.<br><br>Reopen this guide anytime with <b>Guide</b> up top.` }
];
function obRender() {
  const st = document.getElementById('obstage'); if (!st) return;
  const c = OB[obIdx];
  let h = c.visual ? `<div class="obscene">${c.visual}</div>` : `<div class="obicon">${c.icon}</div>`;
  if (c.kick) h += `<div class="obkick">${c.kick}</div>`;
  h += `<div class="obtitle">${c.title}</div>`;
  if (c.body) h += `<div class="obbody">${c.body}</div>`;
  if (c.cards) h += `<div class="obcards">` + c.cards.map(x =>
    `<div class="obcard"><div class="obcico">${x.i}</div><div class="obcname">${x.n}</div>` +
    `<div class="obcdesc">${x.d}</div></div>`).join('') + `</div>`;
  st.innerHTML = h;
  const dots = document.getElementById('obdots');
  dots.innerHTML = OB.map((_, i) => `<span class="obdot${i === obIdx ? ' on' : ''}" data-i="${i}"></span>`).join('');
  dots.querySelectorAll('[data-i]').forEach(d => d.onclick = () => { obIdx = +d.dataset.i; obRender(); });
  document.getElementById('obprev').classList.toggle('gone', obIdx === 0);
  document.getElementById('obnext').innerHTML = obIdx === OB.length - 1 ? 'Start crafting &rarr;' : 'Next &rarr;';
}
function obOpen(i) { obIdx = i || 0; document.getElementById('onboard').classList.remove('hidden'); obRender(); }
function obClose() { document.getElementById('onboard').classList.add('hidden');
  try { localStorage.setItem(OB_LS, '1'); } catch (e) {} }
document.getElementById('obopen').onclick = () => obOpen(0);
document.getElementById('obclose').onclick = obClose;
document.getElementById('obprev').onclick = () => { if (obIdx > 0) { obIdx--; obRender(); } };
document.getElementById('obnext').onclick = () => { if (obIdx < OB.length - 1) { obIdx++; obRender(); } else obClose(); };
document.getElementById('onboard').addEventListener('click', e => { if (e.target.id === 'onboard') obClose(); });

document.getElementById('emuopen').onclick = () => emStart(!em);
document.getElementById('startopen').onclick = openStartEdit;
document.getElementById('startclose').onclick = closeStartEdit;
document.getElementById('startgo').onclick = startEmulate;
document.getElementById('emuclose').onclick = emCloseModal;
document.getElementById('emureset').onclick = () => emStart(true);
document.getElementById('emusnap').onclick = emSnapshot;
document.getElementById('emututor').onclick = () => document.getElementById('emututorial').classList.remove('hidden');
document.getElementById('tutclose').onclick = () => document.getElementById('emututorial').classList.add('hidden');
document.getElementById('emututorial').addEventListener('click', e => {
  if (e.target.id === 'emututorial') e.currentTarget.classList.add('hidden');
});
document.getElementById('emulock').onclick = () => {
  emLock = !emLock;
  if (!emLock && emPend && emPend.kind === 'preview') emPend = null;
  drawEmu();
};
document.getElementById('emugraph').onclick = () => { emCloseModal(); setView('graph'); };
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !document.getElementById('onboard').classList.contains('hidden')) return obClose();
  if (e.key === 'Escape' && !document.getElementById('mcfix').classList.contains('hidden')) return closeMcFix();
  if (e.key === 'Escape' && !document.getElementById('well').classList.contains('hidden')) return emCloseReveal();
  if (e.key === 'Escape' && !document.getElementById('emu').classList.contains('hidden')) return emCloseModal();
  emuKey(e);
});

/* Emulator keyboard shortcuts, live only while the emulator is open and the user
   is not typing in a field. Deliberately single-key for speed; a legend under the
   currency rail keeps them discoverable. */
function emuKey(e) {
  if (document.getElementById('emu').classList.contains('hidden') || !em || emPend) return;
  const t = e.target;
  if (t && (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable)) return;
  const meta = e.metaKey || e.ctrlKey;
  // Cmd/Ctrl+D and Cmd/Ctrl+Z are the two chorded ones; the rest are bare keys.
  if (meta && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); return emReuse(); }
  if (meta && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); return emUndo(); }
  if (meta) return;                                   // leave other browser chords alone
  const k = e.key.toLowerCase();
  const ki = RAILKEYS.indexOf(k);                       // 1-9, 0, then letters
  if (ki >= 0) {                                        // apply the Nth currency (Shift = burst)
    const opts = emRailOpts(), opt = opts[ki];
    if (opt) { e.preventDefault(); (e.shiftKey && bulkable(opt.kind)) ? emBulk(opt, Math.max(emRepeat, 10)) : emApply(opt); return; }
    // no currency in that slot: fall through (letters here aren't action keys)
  }
  const map = {
    r: emReuse, u: emUndo, z: emUndo, s: emSnapshot,
    l: () => emApply({ kind: 'hinekora' }),           // toggle Hinekora's Lock
    n: () => emStart(true), m: () => { emRecording = !emRecording; drawEmu(); },
  };
  const fn = map[k.toLowerCase()];
  if (fn) { e.preventDefault(); fn(); }
}
document.getElementById('stepadd').onchange = e => {
  const sel = e.target, v = sel.value;
  if (!v) return;
  if ((sel.dataset.mode || 'step').startsWith('target:')) {
    if (v === '__back') { stepMenu(); sel.value = ''; return; }
    const id = +sel.dataset.mode.split(':')[1];
    const s = plan.find(x => x.id === id);
    const [g, a] = v.split('|');
    const i = plan.indexOf(s);
    const probe = asItem({ rarity: stepDef(s).to || stateBefore(i).rarity, affixes: stateBefore(i).affixes });
    const D2 = stepDef(s);
    const hit = eligible(probe, null, D2.bone ? (D2.bone.min || 0) : (D2.tiered ? minFor(s.cur, s.tier) : 0),
                         D2.bone && D2.bone.max ? D2.bone.max : Infinity,
                         s.kind === 'bone' ? DES : MODS)
      .find(e => e.m.g === g && e.m.a === a);
    if (s && hit) s.targets.push({ g, a, name: hit.m.n, maxTier: 0 });
    stepMenu(); drawPlan();
  } else if ((sel.dataset.mode || '').startsWith('insert:')) {
    if (v === '__back') { stepMenu(); sel.value = ''; return; }
    const at = +sel.dataset.mode.split(':')[1];
    if (v.startsWith('ess:')) addStep(null, 'I', at, 'essence', v.slice(4));
    stepMenu(); drawPlan();
  } else if (v.startsWith('orb:')) {
    const [, cur, tier] = v.split(':');
    addStep(cur, tier, null);
  } else if (v.startsWith('ess:')) {
    addStep(null, 'I', null, 'essence', v.slice(4));
  } else if (v.startsWith('bone:')) {
    addStep(null, 'I', null, 'bone', v.slice(5));
  } else if (v.startsWith('frac:')) {
    addStep(null, 'I', null, 'fracture');
  }
  sel.value = '';
};
document.getElementById('planclear').onclick = () => {
  plan = []; selStep = null; openPool = new Set(); openTier = new Set(); poolQ = {};
  histStash = [];
  drawPlan(); stepMenu();
};
document.getElementById('plantidy').onclick = tidy;
document.getElementById('vsave').onclick = () => {
  const inp = document.getElementById('vname');
  if (!plan.length) { document.getElementById('vnote').textContent = 'Build a plan first.'; return; }
  const label = (inp.value || '').trim() || `Plan ${variants.length + 1}`;
  variants.push(planSnapshot(label));
  inp.value = '';
  document.getElementById('vnote').textContent = `saved "${label}"`;
  drawVariants();
};
document.getElementById('vgo').onclick = () => {
  const note = document.getElementById('vnote');
  if (!variants.length && !plan.length) { note.textContent = 'Nothing to compare.'; return; }
  note.textContent = 'running\u2026';
  setTimeout(() => {
    drawCompare(compareVariants(+document.getElementById('mctrials').value || 5000));
    note.textContent = '';
  }, 10);
};
/**
 * Work out why a plan cannot be simulated and describe each fault in a way the
 * player can act on. Returns [] when the plan is ready to run.
 */
function mcDiagnose() {
  const problems = [];
  if (!plan.length) {
    problems.push({ empty: true, title: 'The plan is empty',
      detail: 'A simulation needs at least one step. Add one from the &ldquo;add a step&rdquo; ' +
              'menu &mdash; a typical start is Transmutation \u2192 Regal \u2192 Exalted.' });
    return problems;
  }
  const { steps } = evaluate();
  plan.forEach((st, i) => {
    const D = stepDef(st);
    const name = D ? D.name : (st.cur || st.kind);
    const untargeted = (st.kind === 'orb' || st.kind === 'bone') && !st.targets.length;
    if (untargeted) {
      problems.push({ id: st.id, index: i, title: `Step ${i + 1} \u00b7 ${name} has no target`,
        detail: 'This step adds a modifier, but nothing tells the simulator which modifier counts ' +
                'as success. Open the step and tick one or more target modifiers.',
        action: 'Go to this step &amp; pick a target' });
    } else if (!(steps[i] && steps[i].p > 0)) {
      problems.push({ id: st.id, index: i, title: `Step ${i + 1} \u00b7 ${name} can\u2019t land here`,
        detail: (steps[i] && steps[i].why) ||
                'No modifier this step can produce is available on the item as it enters this step ' +
                '(the pool may be empty at this rarity, item level, or after the mods already placed).',
        action: 'Go to this step' });
    }
  });
  return problems;
}

function showMcFix(problems) {
  const head = document.getElementById('mcfixtitle');
  head.innerHTML = problems.length === 1 ? '1 thing to fix before simulating'
    : problems.length + ' things to fix before simulating';
  document.getElementById('mcfixbody').innerHTML = problems.map(p => `
    <div class="mcfixrow">
      <div class="mcfixk">${p.title}</div>
      <div class="mcfixd">${p.detail}</div>
      ${p.id != null ? `<button class="ghost mcfixgo" data-go="${p.id}">${p.action || 'Go to this step'}</button>`
        : `<button class="ghost mcfixgo" data-addstep="1">Add a step</button>`}
    </div>`).join('');
  document.getElementById('mcfixbody').querySelectorAll('[data-go]').forEach(b =>
    b.onclick = () => mcGotoStep(+b.dataset.go));
  document.getElementById('mcfixbody').querySelectorAll('[data-addstep]').forEach(b =>
    b.onclick = () => { closeMcFix(); setView('graph');
      const sel = document.getElementById('stepadd'); if (sel) sel.focus(); });
  document.getElementById('mcfix').classList.remove('hidden');
}
function closeMcFix() { document.getElementById('mcfix').classList.add('hidden'); }
function mcGotoStep(id) {
  closeMcFix();
  setView('graph');
  selStep = id; openPool.add(id);
  drawPlan();
  const card = document.querySelector(`.card[data-step="${id}"]`);
  if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
document.getElementById('mcfixclose').onclick = closeMcFix;
document.getElementById('mcfix').onclick = e => { if (e.target.id === 'mcfix') closeMcFix(); };

document.getElementById('mcgo').onclick = () => {
  const note = document.getElementById('mcnote');
  // anything wrong with the plan (no steps, missing targets, a step that cannot
  // land) is explained in a popup with a jump-to-the-step button, rather than a
  // note the player has to decode
  const problems = mcDiagnose();
  if (problems.length) { note.textContent = ''; drawMC(null); return showMcFix(problems); }
  const n = +document.getElementById('mctrials').value || 5000;
  note.textContent = 'running\u2026';
  setTimeout(() => {
    const r = runMC(n);
    note.textContent = '';
    drawMC(r);
    // the plan is well-formed yet nothing finished: a removal loop eats progress
    // faster than it is made. Point at the offending step.
    if (!r.ok) {
      const { steps } = evaluate();
      const bad = steps.map((st, i) => ({ i, w: stepWalk(st) })).filter(x => !isFinite(x.w.uses));
      const problems = bad.length ? bad.map(({ i }) => {
        const st = plan[i], D = stepDef(st);
        return { id: st.id, index: i, title: `Step ${i + 1} \u00b7 ${(D ? D.name : st.cur)} never gets ahead`,
          detail: 'This step lands often enough, but its Annul recovery removes one of your target ' +
                  'modifiers more often than the step adds one, so the item loses ground every loop. ' +
                  'Drop the Annul recovery on this step, or land it earlier while fewer targets are on ' +
                  'the item.', action: 'Go to this step' };
      }) : [{ title: 'No run could finish this plan',
              detail: 'Every simulated attempt got stuck. Check that each step can act on the rarity it ' +
                      'receives (Transmutation needs Normal, Regal needs Magic, Exalted/Chaos need Rare) ' +
                      'and that a corruption is the last step.' }];
      showMcFix(problems);
    }
  }, 10);
};
document.getElementById('histundo').onclick = () => {
  if (!histStash.length) return;
  plan = plan.concat(histStash);      // put the rewound tail back
  histStash = [];
  tidy();
};
document.getElementById('zoomin').onclick = () => setZoom(zoom + 0.15);
document.getElementById('zoomout').onclick = () => setZoom(zoom - 0.15);
document.getElementById('zoomfit').onclick = zoomFit;
document.getElementById('canvas').addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;          // plain scroll still pans
  e.preventDefault();
  const r = e.currentTarget.getBoundingClientRect();
  setZoom(zoom - e.deltaY * 0.0015, { x: e.clientX - r.left, y: e.clientY - r.top });
}, { passive: false });
document.getElementById('strictbtn').onclick = e => {
  strict = !strict;
  e.currentTarget.setAttribute('aria-pressed', String(strict));
  drawPlan();
};

/* ---------------- wiring ---------------- */

const clsSel = document.getElementById('cls');
const baseSel = document.getElementById('base');

const label = s => (BASES[s].ic || s) + ' — ' + s.replace(/^[A-Za-z]+_?/, m => m).replace(/_/g, ' ');
const keys = Object.keys(BASES).sort();
clsSel.innerHTML = keys.map(k => `<option value="${k}">${esc(k.replace(/_/g,' '))}</option>`).join('');
clsSel.value = keys.includes('Body_Armours_int') ? 'Body_Armours_int' : keys[0];

// Rune-modified variants share a name prefix; default to the highest plain base.
const isPlain = n => !/^Rune(forged|mastered) /.test(n);

function fillBases() {
  const rows = BASES[clsSel.value].b;
  baseSel.innerHTML = rows.map(b => {
    const lv = b.r && b.r.level ? ` (lv ${b.r.level})` : '';
    return `<option value="${esc(b.n)}">${esc(b.n)}${lv}</option>`;
  }).join('');
  const plain = rows.filter(b => isPlain(b.n));
  const pool = plain.length ? plain : rows;
  const best = pool.reduce((a, b) => ((b.r && b.r.level) || 0) >= ((a.r && a.r.level) || 0) ? b : a);
  baseSel.value = best.n;
}

function reset() {
  step = 0; hist = []; open = new Set(); omen = ''; state = newItem();
  mcPoolCache.clear();                 // pools are base-specific; never reuse across bases
  // the plan is built on top of the item, so resetting the item must drop it
  plan = []; selStep = null; openPool = new Set(); openTier = new Set(); poolQ = {};
  histStash = [];
  // a live emulation was rolled on the old base, so it no longer applies
  if (typeof em !== 'undefined' && em) {
    em = null; emHist = []; emLog = []; emOmen = ''; emPend = null; emBaseCost = null;
    if (!document.getElementById('emu').classList.contains('hidden')) emStart(true);
  }
  draw();
  if (view === 'graph') { stepMenu(); drawPlan(); }
}
document.getElementById('essgo').onclick = applyEssence;

function syncRunes() {
  if (!state) return;
  const sk = runeSockets();
  // drop any runes the current base cannot socket (e.g. moving to a 1-socket base)
  let on = Object.keys(runes).filter(k => runes[k]);
  while (on.length > sk) { runes[on.pop()] = 0; }
  document.querySelectorAll('#runepick button').forEach(x => {
    x.disabled = sk < 1;
    x.setAttribute('aria-pressed', String(!!runes[x.dataset.rune]));
    x.title = sk >= 1 ? (x.dataset.rune === 'suffix'
                  ? 'A Rare item may hold a 4th suffix'
                  : 'A Rare item may hold a 2nd crafted (essence) modifier')
                : 'This base has no sockets for runes';
  });
}
clsSel.onchange = () => { plan = []; fillBases(); reset(); syncRunes(); };
baseSel.onchange = reset;
document.getElementById('ilvl').onchange = () => {
  state.ilvl = Math.min(100, Math.max(1, +document.getElementById('ilvl').value || 1));
  document.getElementById('ilvl').value = state.ilvl;
  mcPoolCache.clear();
  draw();
  if (view === 'graph') { stepMenu(); drawPlan(); }
};
document.getElementById('reset').onclick = reset;

for (const [id, v] of [['f-all','all'], ['f-pre','p'], ['f-suf','s']]) {
  document.getElementById(id).onclick = () => {
    filter = v;
    for (const [i2] of [['f-all'],['f-pre'],['f-suf']])
      document.getElementById(i2).setAttribute('aria-pressed', String(i2 === id));
    drawOdds();
  };
}

fillBases();
reset();
setView('graph');
drawPrices();
try { if (!localStorage.getItem(OB_LS)) obOpen(0); } catch (e) {}

/* ===========================================================================
 * Cloud layer wiring (accounts + save/sync/share). Additive: if Supabase is
 * unreachable the app keeps working exactly as before. Lives at the end so it
 * can see every engine binding it touches (plan, state, PRICES, emStartFrom…).
 * ======================================================================== */
const DATA_VERSION = (DB && (DB.version || DB.v)) || null;

// --- prices: push to cloud (debounced) after any local price/rate change -----
let _pricePushT = null;
function cloudPushPricesDebounced() {
  if (typeof auth === 'undefined' || !auth.getUser()) return;   // only when signed in
  clearTimeout(_pricePushT);
  _pricePushT = setTimeout(() => {
    sync.pushPrices(PRICES, loadRates() || {}).catch(e => console.warn('price push failed', e));
  }, 800);
}

// --- read the Aldur-rune toggles so a saved plan remembers its caps ----------
function readRuneFlags() {
  const o = {};
  document.querySelectorAll('#runepick .chip').forEach(c => {
    o[c.dataset.rune] = c.getAttribute('aria-pressed') === 'true';
  });
  return o;
}

// --- load a cloud plan's graph back onto the canvas --------------------------
function loadCloudPlan(p) {
  const note = document.getElementById('vnote');
  try {
    plan = JSON.parse(JSON.stringify(p.graph || []));
    selStep = null; openPool = new Set(); openTier = new Set(); poolQ = {}; histStash = [];
    for (const s of plan) if (typeof s.id === 'number' && s.id > planSeq) planSeq = s.id;
    setView('graph');
    drawPlan(); stepMenu();
    if (note) note.textContent = `loaded "${p.title}"` +
      (p.base_class && state && p.base_class !== state.slug ? ' — built for a different base' : '');
  } catch (e) {
    if (note) note.textContent = 'could not load plan: ' + (e.message || e);
  }
}

// --- render the "my plans / my snapshots" panel ------------------------------
async function renderCloud() {
  const box = document.getElementById('cloudwrap');
  if (!box) return;
  if (!auth.getUser()) {
    box.innerHTML = '<div class="cloudhint">Sign in (top&#8209;right) or hit &#9729; <b>Save to account</b> ' +
      'to keep plans in the cloud and open them on any device.</div>';
    return;
  }
  box.innerHTML = '<div class="cloudhint">Loading your saved plans&hellip;</div>';
  let plans, snaps;
  try { [plans, snaps] = await Promise.all([sync.listPlans(), sync.listSnapshots()]); }
  catch (e) { box.innerHTML = '<div class="cloudhint">Could not load cloud data: ' +
      esc(String(e.message || e)) + '</div>'; return; }

  const planHTML = plans.length
    ? plans.map(p => `<span class="cloudchip${p.is_public ? ' shared' : ''}">
        <b>${esc(p.title)}</b>
        <span class="cloudmeta">${p.base_class ? esc(p.base_class) + ' &middot; ' : ''}${(p.graph || []).length} steps</span>
        <button class="cloudact" data-load="${p.id}">load</button>
        <button class="cloudact" data-share="${p.id}">${p.is_public ? '&#128279; copy link' : '&#128279; share'}</button>
        ${p.is_public ? `<button class="cloudact" data-unshare="${p.id}" title="stop sharing">unshare</button>` : ''}
        <button class="cloudx" data-delplan="${p.id}" title="delete">&times;</button></span>`).join('')
    : '<span class="mcnote">No saved plans yet.</span>';

  const snapHTML = snaps.length
    ? `<div class="cloudsub">My snapshots</div>` + snaps.map(s => `<span class="cloudchip">
        <b>${esc(s.label || 'snapshot')}</b>
        <span class="cloudmeta">${s.ctx && s.ctx.baseName ? esc(s.ctx.baseName) : ''}</span>
        <button class="cloudact" data-emu="${s.id}">&#9654; emulate</button>
        <button class="cloudx" data-delsnap="${s.id}" title="delete">&times;</button></span>`).join('')
    : '';

  box.innerHTML = `<div class="cloudsub">My plans (cloud)</div><div class="cloudlist">${planHTML}</div>` +
    (snapHTML ? `<div class="cloudlist">${snapHTML}</div>` : '');

  box.querySelectorAll('[data-load]').forEach(b => b.onclick = () =>
    loadCloudPlan(plans.find(p => p.id === b.dataset.load)));
  box.querySelectorAll('[data-delplan]').forEach(b => b.onclick = async () => {
    try { await sync.deletePlan(b.dataset.delplan); renderCloud(); } catch (e) { console.error(e); } });
  box.querySelectorAll('[data-emu]').forEach(b => b.onclick = () => {
    const s = snaps.find(x => x.id === b.dataset.emu);
    if (s) emStartFrom(s.item, 'saved snapshot', s.ctx); });
  box.querySelectorAll('[data-delsnap]').forEach(b => b.onclick = async () => {
    try { await sync.deleteSnapshot(b.dataset.delsnap); renderCloud(); } catch (e) { console.error(e); } });
  box.querySelectorAll('[data-share]').forEach(b => b.onclick = () => sharePlan(b.dataset.share));
  box.querySelectorAll('[data-unshare]').forEach(b => b.onclick = async () => {
    try { await sync.unpublishPlan(b.dataset.unshare); renderCloud(); } catch (e) { console.error(e); } });
}

// Make a plan public and put its share link on the clipboard.
async function sharePlan(id) {
  try {
    const slug = await sync.makePlanPublic(id);
    const url = router.shareUrl(slug);
    let copied = false;
    try { await navigator.clipboard.writeText(url); copied = true; } catch (e) {}
    showShareBanner(
      `<b>Share link ${copied ? 'copied' : 'ready'}:</b> ` +
      `<a href="${esc(url)}">${esc(url)}</a> — anyone with it can open this plan.`, true);
    renderCloud();
  } catch (e) {
    showShareBanner('Could not create share link: ' + esc(String(e.message || e)), true);
  }
}

// --- on sign-in: reconcile prices (cloud wins if present, else seed from local)
async function hydratePrices() {
  try {
    const cp = await sync.pullPrices();
    if (cp && cp.prices && Object.keys(cp.prices).length) {
      Object.assign(PRICES, cp.prices);
      if (cp.rates && cp.rates.ex) {
        const pr = document.getElementById('pirate'), pc = document.getElementById('piratec');
        if (pr && cp.rates.ex) pr.value = cp.rates.ex;
        if (pc && cp.rates.c != null) pc.value = cp.rates.c;
        try { localStorage.setItem(RATE_LS, JSON.stringify({ ex: cp.rates.ex, c: cp.rates.c })); } catch (e) {}
      }
      try { localStorage.setItem(PRICE_LS, JSON.stringify(PRICES)); } catch (e) {}
      drawPrices();
    } else {
      await sync.pushPrices(PRICES, loadRates() || {});   // first sign-in: seed the cloud
    }
  } catch (e) { console.warn('price hydrate failed', e); }
}

// --- buttons -----------------------------------------------------------------
const _cloudSaveBtn = document.getElementById('cloudsave');
if (_cloudSaveBtn) _cloudSaveBtn.onclick = async () => {
  const note = document.getElementById('vnote');
  if (!plan.length) { if (note) note.textContent = 'Build a plan first.'; return; }
  const nameInp = document.getElementById('vname');
  const title = (nameInp && nameInp.value.trim()) ||
    `${(state && state.base && state.base.n) || 'Plan'} · ${plan.length} steps`;
  if (note) note.textContent = 'saving…';
  try {
    await sync.savePlan({
      title,
      graph: JSON.parse(JSON.stringify(plan)),
      base_class: state && state.slug,
      base_id: state && state.base && state.base.id,
      ilvl: state && state.ilvl,
      rune_flags: readRuneFlags(),
      data_version: DATA_VERSION,
    });
    if (nameInp) nameInp.value = '';
    if (note) note.textContent = 'saved to your account';
    renderCloud();
  } catch (e) { if (note) note.textContent = 'save failed: ' + (e.message || e); }
};

const _cloudSnapBtn = document.getElementById('emucloudsnap');
if (_cloudSnapBtn) _cloudSnapBtn.onclick = async () => {
  if (typeof em === 'undefined' || !em) return;
  const label0 = _cloudSnapBtn.innerHTML;
  _cloudSnapBtn.disabled = true;
  try {
    await sync.saveSnapshot({
      label: `${em.corrupted ? 'corrupted ' : ''}${RNAME[em.rarity]} item`,
      item: emCopyItem(em),
      ctx: { slug: state.slug, baseName: state.base && state.base.n,
             ilvl: state.ilvl, exceptional: state.exceptional },
    });
    _cloudSnapBtn.innerHTML = '✓ saved';
    renderCloud();
    setTimeout(() => { _cloudSnapBtn.innerHTML = label0; _cloudSnapBtn.disabled = false; }, 1500);
  } catch (e) {
    console.error(e);
    _cloudSnapBtn.innerHTML = 'save failed';
    setTimeout(() => { _cloudSnapBtn.innerHTML = label0; _cloudSnapBtn.disabled = false; }, 1500);
  }
};

// --- sharing: banner + loading a shared plan by slug -------------------------
function showShareBanner(html, dismissible) {
  const b = document.getElementById('sharebanner');
  if (!b) return;
  b.innerHTML = html + (dismissible ? ' <button class="sharex" id="sharex" title="dismiss">&times;</button>' : '');
  b.classList.remove('hidden');
  const x = document.getElementById('sharex');
  if (x) x.onclick = () => b.classList.add('hidden');
}

async function loadSharedPlan(slug) {
  try {
    const p = await sync.getPublicPlan(slug);
    if (!p) { showShareBanner('That shared plan could not be found — it may have been unshared.', true); return; }
    loadCloudPlan(p);
    showShareBanner(`Viewing shared plan <b>${esc(p.title)}</b>` +
      (p.base_class ? ` — built for <b>${esc(p.base_class)}</b>${p.ilvl ? ` at ilvl ${p.ilvl}` : ''}` : '') +
      '. Changes stay on your screen unless you save your own copy.', true);
  } catch (e) {
    showShareBanner('Could not load the shared plan: ' + esc(String(e.message || e)), true);
  }
}
function handleRoute(route) { if (route && route.view === 'plan') loadSharedPlan(route.slug); }

// --- boot the cloud layer (never blocks the app) -----------------------------
let _hydratedUser = null;
function handleAuth(session) {
  renderCloud();
  const u = session && session.user;
  if (u && u.id !== _hydratedUser) { _hydratedUser = u.id; hydratePrices(); }
  if (!u) _hydratedUser = null;
}
try {
  auth.onAuthChange(handleAuth);
  auth.initAuth().catch(e => console.warn('auth init failed', e));
  renderCloud();
  const runRoute = router.onRoute(handleRoute);
  runRoute();                       // handle a share link present on first load
} catch (e) { console.warn('cloud layer disabled:', e); }
