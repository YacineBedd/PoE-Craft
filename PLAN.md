# PoE2 Crafting Bench — Full Hosting + Supabase Implementation Plan

> Status: **draft for review** (written 2026-07-30). Nothing below is built yet
> except the local git repo + a GitHub Pages workflow (Phase 0, staged).
> This document is written to be executed in one pass once you approve it and
> hand over the few human-only credentials called out in **§9**.

---

## 1. What we have today (the honest starting point)

The app in `web/` is a **mature, ~5,000-line vanilla ES-module app** with no
framework and no build step. It is already "standalone" in the technical sense:

- Relative paths only (`./data/DATA.json`, `styles.css`), so it runs under any
  URL prefix without changes.
- All icons are embedded as `data:` URIs inside `DATA.json`; **zero external
  requests**.
- Serves cleanly over plain static HTTP (verified: index/css/js/DATA all 200).

**What does NOT survive a reload today** (all in-memory only):

| State | Where it lives now | Persisted? |
|-------|--------------------|------------|
| Craft **plans / graph variants** (`variants[]`) | RAM | ❌ lost on reload |
| Emulator **snapshots** (`emSnaps[]`) | RAM | ❌ lost on reload |
| **Prices + exchange rates** (`PRICES`, `RATES`) | `localStorage` | ✅ this device only |
| Onboarding-seen flag | `localStorage` | ✅ this device only |

So the single biggest user-visible win from a backend is simply: **your plans,
snapshots and prices are saved, follow you across devices, and can be shared by
link.** Everything else (community gallery, live prices) is upside on top.

The data shapes are already clean JSON blobs — ideal for `jsonb` storage:

```txt
plan variant  = { id, label, steps: [ ...craft-graph nodes... ] }
emu snapshot  = { id, label, item: {...}, ctx: { slug, baseName, ilvl, exceptional } }
price table   = { <currencyKey>: <divineValue>, ... }  + rates { ex, c }
```

---

## 2. Guiding principles

1. **Local-first, cloud-optional.** The app must stay 100% usable with no
   account, exactly as today. Sign-in is *progressive enhancement*: it turns on
   sync, cross-device, and sharing. We never gate the core tool behind auth.
2. **No rewrite.** Keep the vanilla ES-module app. We *add* a thin data layer,
   we do not port to React/Vue/etc. Rewriting a working 5k-line engine buys the
   user nothing and risks everything.
3. **No build step if we can avoid one.** Vendor a pinned copy of the Supabase
   client into `web/vendor/` so "just refresh" still works and there is no
   runtime CDN dependency.
4. **Public data stays static.** `DATA.json` is versioned game reference data —
   it belongs on the CDN, not in Postgres. Postgres holds *user* data only.
5. **Security by RLS, not by secrecy.** The only key in the frontend is the
   Supabase **anon** key (safe to publish). Row-Level Security is what actually
   protects data. The `service_role` key never touches the frontend.

---

## 3. Target architecture

```txt
                         ┌────────────────────────────────────────┐
   Browser (your app) ── │  web/  static site (unchanged engine)  │
                         │   + web/js/auth.js     (session, UI)    │
                         │   + web/js/sync.js      (data layer)    │
                         │   + web/js/config.js    (URL + anon key)│
                         │   + web/vendor/supabase.js (pinned)     │
                         └───────────────┬────────────────────────┘
                                         │ HTTPS (anon key + user JWT)
                                         ▼
                         ┌────────────────────────────────────────┐
   Supabase (managed)    │  Auth  (Discord / Google / email / anon)│
                         │  Postgres + Row-Level Security          │
                         │    profiles · plans · snapshots · prices│
                         │    plan_stars · comments (optional)     │
                         │  Edge Functions (optional: price feed)  │
                         └────────────────────────────────────────┘

   Static host = GitHub Pages (default) or Cloudflare Pages / Vercel (if custom domain)
```

- **Frontend:** the current `web/` app + ~3 small new JS modules. No framework.
- **Backend:** Supabase (Auth + Postgres + RLS). Optional Edge Functions later.
- **Static host:** GitHub Pages by default (we already scaffolded the workflow).
  Upgrade path to Cloudflare Pages / Vercel if you want a custom domain and
  preview deploys — see §7.

---

## 4. The stack (and why each piece)

| Concern | Choice | Why this over the alternatives |
|--------|--------|--------------------------------|
| Frontend framework | **None (keep vanilla ESM)** | Working 5k-line engine; a rewrite is pure risk. |
| Backend / DB | **Supabase (Postgres)** | You asked for it, and it's the right call: Auth + Postgres + RLS + row-level realtime in one free tier. |
| Auth | **Supabase Auth**: Discord + Google + email magic-link + anonymous | Discord is the PoE community's native login. Anonymous lets people save before committing to an account. |
| Client lib | **`@supabase/supabase-js` v2, vendored** | One dependency; ESM; works with our no-build setup. |
| Static host | **GitHub Pages** (default) | Free, already wired up, zero new accounts. Cloudflare/Vercel if custom domain wanted. |
| Routing (for share links) | **Hash routing, hand-rolled** (`#/p/<slug>`) | ~30 lines; no router library, no build. |
| CI/CD | **GitHub Actions** | Pages deploy on push (done) + `supabase db push` for migrations. |
| Migrations | **`supabase/migrations/*.sql` (Supabase CLI)** | Schema is code, reviewable, reproducible. |
| Analytics (optional) | **Cloudflare Web Analytics or Plausible** | Privacy-friendly, no cookie banner. |

---

## 5. Database schema (Supabase Postgres)

All tables live in `public`. `auth.users` is Supabase-managed. RLS **on** for
every table. Full SQL goes in `supabase/migrations/0001_init.sql`; sketch below.

```sql
-- 1. profiles: one row per auth user, public-readable handle + prefs
create table profiles (
  id          uuid primary key references auth.users on delete cascade,
  username    citext unique,
  avatar_url  text,
  prefs       jsonb not null default '{}',        -- league, default rune flags, etc.
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 2. plans: saved craft graphs (the core save feature)
create table plans (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  title        text not null,
  notes        text,
  base_class   text,            -- item class slug
  base_id      text,            -- base item id
  ilvl         int,
  rune_flags   jsonb default '{}',
  graph        jsonb not null,  -- the plan `steps[]` blob, verbatim
  data_version text,            -- which DATA.json / patch this targets
  is_public    boolean not null default false,
  slug         text unique,     -- short id for share URL, set when made public
  fork_of      uuid references plans(id) on delete set null,
  star_count   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on plans (user_id);
create index on plans (is_public) where is_public;

-- 3. snapshots: emulator item states
create table snapshots (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  plan_id    uuid references plans(id) on delete set null,
  label      text,
  item       jsonb not null,   -- emCopyItem(em)
  ctx        jsonb not null,   -- { slug, baseName, ilvl, exceptional }
  is_public  boolean not null default false,
  slug       text unique,
  created_at timestamptz not null default now()
);
create index on snapshots (user_id);

-- 4. prices: replaces the localStorage price/rate table, per user per league
create table prices (
  user_id    uuid not null references auth.users on delete cascade,
  league     text not null default 'standard',
  prices     jsonb not null default '{}',
  rates      jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, league)
);

-- 5. plan_stars (optional, community): upvotes on public plans
create table plan_stars (
  plan_id uuid references plans(id) on delete cascade,
  user_id uuid references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  primary key (plan_id, user_id)
);

-- 6. comments (optional): on public plans
create table comments (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references plans(id) on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);
```

### RLS policy summary

| Table | SELECT | INSERT / UPDATE / DELETE |
|-------|--------|--------------------------|
| `profiles` | anyone (public handles) | owner only (`id = auth.uid()`) |
| `plans` | `is_public` **or** owner | owner only |
| `snapshots` | `is_public` **or** owner | owner only |
| `prices` | owner only | owner only |
| `plan_stars` | anyone | own row only; star only public plans |
| `comments` | anyone on public plans | own row only |

`profiles` is auto-created on signup via a `handle_new_user()` trigger on
`auth.users`. `star_count` maintained by a trigger on `plan_stars`.

---

## 6. Frontend integration (surgical, additive)

New files under `web/` — the existing `app.js` is touched only at a few clean
hook points:

```txt
web/
├── js/
│   ├── config.js     # export SUPABASE_URL, SUPABASE_ANON_KEY (public, committed)
│   ├── auth.js       # session bootstrap, sign-in/out UI, anonymous fallback
│   ├── sync.js       # save/load/list plans, snapshots, prices; local↔cloud merge
│   └── router.js     # hash routing for #/p/<slug> share links (~30 lines)
├── vendor/
│   └── supabase.js   # pinned @supabase/supabase-js v2 (vendored, no CDN at runtime)
└── app.js            # + ~6 hook points (see below)
```

**Hook points in `app.js`** (all additive, feature-flagged so the app still runs
with the backend unreachable):

1. On load: `auth.init()` → if a session exists, hydrate prices/plans/snapshots
   from cloud; else fall back to `localStorage` exactly as today.
2. `savePrices()` / `saveRates()` (lines ~1315–1317): after the `localStorage`
   write, `sync.pushPrices()` when signed in (debounced).
3. `planSnapshot()` / `variants` save (line ~1393): add a **"Save to account"**
   affordance → `sync.savePlan()`.
4. `emSnapshot()` (line ~2142): add **"Save snapshot"** → `sync.saveSnapshot()`.
5. New **"My plans / snapshots"** panel: `sync.listPlans()` to load them back.
6. New **"Share"** button on a plan: `sync.makePublic()` → copies `#/p/<slug>`.

**Load-a-shared-plan flow:** `router.js` sees `#/p/<slug>` → `sync.getPublicPlan(slug)`
(anon read allowed by RLS) → feeds it into the existing plan-rendering path. No
login required to *view* a shared plan.

**Migration on first login:** detect existing `localStorage` prices/plans and
offer a one-click "import your local data into this account."

---

## 7. Hosting & deployment

**Frontend (static):**

- **Default — GitHub Pages.** Workflow already written
  (`.github/workflows/deploy.yml`): every push to `main` publishes `web/`. Site
  lands at `https://<you>.github.io/poe2-crafting-bench/`. Zero new accounts,
  zero secrets (anon key is public).
- **Upgrade path — Cloudflare Pages or Vercel.** Choose this if you want a
  **custom domain** (e.g. `poe2craft.app`), preview deploys per branch, and a
  faster global edge. Both are free for this; migration is just "point the host
  at `web/`." No code changes — the app is path-relative.

**Backend — Supabase:**

- One free project (500 MB Postgres, 1 GB storage, 50k monthly active users —
  far beyond our needs).
- Schema managed as `supabase/migrations/*.sql`, applied by the Supabase CLI
  (`supabase db push`) locally and/or in CI.
- Auth providers configured in the Supabase dashboard (Discord/Google need an
  OAuth app each — see §9).

**CI/CD:**

- `deploy.yml` (Pages) — done.
- `migrate.yml` (optional) — run `supabase db push` on changes to
  `supabase/migrations/**`, using `SUPABASE_ACCESS_TOKEN` + project ref from
  GitHub Actions secrets.

**Cost: $0** across the whole stack at expected usage. First real cost would be
a custom domain (~$10–15/yr) if you want one — optional.

---

## 8. Phased execution (built to run in one pass)

Each phase is independently shippable; the app stays live and usable throughout.

| Phase | Deliverable | Human input needed |
|-------|-------------|--------------------|
| **0. Foundation** *(staged)* | git repo + Pages workflow → frontend live as-is | GitHub auth (§9) |
| **1. Supabase project** | project created, `0001_init.sql` schema + RLS applied, auth providers on | Supabase project + OAuth creds (§9) |
| **2. Auth** | `config.js`, `vendor/supabase.js`, `auth.js`; sign-in/out UI; anonymous session; app still 100% works logged-out | — |
| **3. Persistence** | `sync.js`; prices, plans, snapshots save & load to cloud; localStorage→account migration | — |
| **4. Sharing** | `router.js`; public plans, slugs, `#/p/<slug>` share links, view-without-login | — |
| **5. Community** *(optional)* | browse public plans, stars, comments | — |
| **6. Live prices** *(optional)* | Edge Function pulling poe.ninja/official trade on a cron → community price defaults | — |
| **7. Polish** *(optional)* | custom domain, privacy-friendly analytics, SEO/meta for share links | domain + DNS |

Phases 0–4 are the real product ("save, sync, share"). 5–7 are upside.

---

## 9. What I need from you (the only non-automatable bits)

These require *your* accounts/credentials — I can't create them headlessly.
Have these ready and the rest runs autonomously:

1. **GitHub auth** — run in this session:  `!gh auth login`  (or paste a PAT).
   Then I create the repo, push, and the Pages site goes live.
2. **Supabase project** — create a free project at supabase.com, then give me:
   - Project **URL** and **anon** key (public — safe to paste; goes in `config.js`).
   - Optionally a **`SUPABASE_ACCESS_TOKEN`** (for CLI migrations) — treat as secret.
3. **OAuth apps** (only for the providers you want):
   - **Discord** (recommended): create an app at discord.com/developers → client
     id + secret → paste into Supabase dashboard.
   - **Google** (optional): OAuth client in Google Cloud console.
   - Email magic-link needs nothing beyond enabling it.
4. **Custom domain** (optional, Phase 7): buy it, I'll give you the DNS records.

Everything else — schema, RLS, all frontend code, wiring, migration, tests — I
build without further input.

---

## 10. Open decisions for your review

Answer these when you're back and I'll lock the plan and execute:

1. **Static host:** stick with **GitHub Pages** (simplest), or go
   **Cloudflare Pages / Vercel** now for a custom domain? *(Recommend: Pages now,
   move later if you want a domain — costs nothing to switch.)*
2. **Auth providers:** which do you want on day one? *(Recommend: Discord +
   email magic-link; add Google later.)*
3. **Scope for the first build:** Phases 0–4 (save/sync/share) only, or include
   the **community gallery** (Phase 5) too? *(Recommend: 0–4 first, ship it,
   then decide on community.)*
4. **Anonymous accounts:** enable "use & save before signing up" (nice UX, tiny
   extra complexity)? *(Recommend: yes.)*
5. **Repo visibility:** you already chose **Public** — confirm that's still right
   given the code will be readable by anyone. *(Fine; there are no secrets in it.)*

---

## 11. Risks & how the plan handles them

- **Google Drive working dir is slow** (staging 35 MB timed out once). Mitigation:
  the repo lives fine; large `scraper/raw/` HTML is optional to commit — we can
  `.gitignore` it to keep the repo lean if pushes are sluggish.
- **Backend down / offline:** every cloud call is feature-flagged with a
  localStorage fallback, so the tool never hard-depends on Supabase.
- **Data/patch drift:** plans store `data_version`; when `DATA.json` updates for
  a new patch, old plans still load and we can warn if mods moved.
- **Public anon key exposure:** by design — RLS is the real boundary. The
  `service_role` key is never shipped to the browser.
- **Scope creep (community features):** explicitly fenced into optional phases so
  the core "save/sync/share" ships first.
```
