-- ============================================================================
-- PoE2 Crafting Bench — initial schema
-- ----------------------------------------------------------------------------
-- User data only. Game reference data (DATA.json) stays on the CDN, not here.
-- Row-Level Security is ON for every table; the browser only ever holds the
-- public anon key, so RLS is the real security boundary.
--
-- Tables: profiles · plans · snapshots · prices · plan_stars · comments
-- ============================================================================

create extension if not exists citext;      -- case-insensitive usernames
-- pgcrypto (gen_random_uuid) is already enabled on Supabase projects.

-- ---------------------------------------------------------------------------
-- Shared helper: keep updated_at fresh on UPDATE
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ===========================================================================
-- 1. profiles — one row per auth user (public handle + prefs)
-- ===========================================================================
create table public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  username    citext unique,
  avatar_url  text,
  prefs       jsonb not null default '{}',   -- league, default rune flags, ...
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles are readable by everyone"
  on public.profiles for select
  using (true);

create policy "users insert their own profile"
  on public.profiles for insert to authenticated
  with check (id = auth.uid());

create policy "users update their own profile"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-create a profile row whenever a new auth user signs up (incl. anonymous)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===========================================================================
-- 2. plans — saved craft graphs (the core "save" feature)
-- ===========================================================================
create table public.plans (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  title        text not null,
  notes        text,
  base_class   text,                          -- item class slug
  base_id      text,                          -- base item id
  ilvl         int,
  rune_flags   jsonb not null default '{}',
  graph        jsonb not null,                -- the plan `steps[]` blob, verbatim
  data_version text,                          -- DATA.json / patch this targets
  is_public    boolean not null default false,
  slug         text unique,                   -- short id for share URL (set when public)
  fork_of      uuid references public.plans(id) on delete set null,
  star_count   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index plans_user_id_idx on public.plans (user_id);
create index plans_public_idx  on public.plans (is_public) where is_public;
create index plans_slug_idx     on public.plans (slug) where slug is not null;

alter table public.plans enable row level security;

create policy "plans are readable when public or owned"
  on public.plans for select
  using (is_public or user_id = auth.uid());

create policy "users insert their own plans"
  on public.plans for insert to authenticated
  with check (user_id = auth.uid());

create policy "users update their own plans"
  on public.plans for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users delete their own plans"
  on public.plans for delete to authenticated
  using (user_id = auth.uid());

create trigger plans_set_updated_at
  before update on public.plans
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- 3. snapshots — emulator item states
-- ===========================================================================
create table public.snapshots (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  plan_id    uuid references public.plans(id) on delete set null,
  label      text,
  item       jsonb not null,                  -- emCopyItem(em)
  ctx        jsonb not null,                  -- { slug, baseName, ilvl, exceptional }
  is_public  boolean not null default false,
  slug       text unique,
  created_at timestamptz not null default now()
);

create index snapshots_user_id_idx on public.snapshots (user_id);

alter table public.snapshots enable row level security;

create policy "snapshots are readable when public or owned"
  on public.snapshots for select
  using (is_public or user_id = auth.uid());

create policy "users insert their own snapshots"
  on public.snapshots for insert to authenticated
  with check (user_id = auth.uid());

create policy "users update their own snapshots"
  on public.snapshots for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users delete their own snapshots"
  on public.snapshots for delete to authenticated
  using (user_id = auth.uid());

-- ===========================================================================
-- 4. prices — per-user, per-league price table + rates (replaces localStorage)
-- ===========================================================================
create table public.prices (
  user_id    uuid not null references auth.users on delete cascade,
  league     text not null default 'standard',
  prices     jsonb not null default '{}',
  rates      jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, league)
);

alter table public.prices enable row level security;

create policy "users read their own prices"
  on public.prices for select to authenticated
  using (user_id = auth.uid());

create policy "users write their own prices"
  on public.prices for insert to authenticated
  with check (user_id = auth.uid());

create policy "users update their own prices"
  on public.prices for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users delete their own prices"
  on public.prices for delete to authenticated
  using (user_id = auth.uid());

create trigger prices_set_updated_at
  before update on public.prices
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- 5. plan_stars — upvotes on public plans (optional / community)
-- ===========================================================================
create table public.plan_stars (
  plan_id    uuid not null references public.plans(id) on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  primary key (plan_id, user_id)
);

alter table public.plan_stars enable row level security;

create policy "stars are readable by everyone"
  on public.plan_stars for select
  using (true);

create policy "users star public plans as themselves"
  on public.plan_stars for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.plans p where p.id = plan_id and p.is_public)
  );

create policy "users remove their own stars"
  on public.plan_stars for delete to authenticated
  using (user_id = auth.uid());

-- Keep plans.star_count in sync
create or replace function public.sync_star_count()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if (tg_op = 'INSERT') then
    update public.plans set star_count = star_count + 1 where id = new.plan_id;
  elsif (tg_op = 'DELETE') then
    update public.plans set star_count = greatest(0, star_count - 1) where id = old.plan_id;
  end if;
  return null;
end;
$$;

create trigger plan_stars_count_ins
  after insert on public.plan_stars
  for each row execute function public.sync_star_count();

create trigger plan_stars_count_del
  after delete on public.plan_stars
  for each row execute function public.sync_star_count();

-- ===========================================================================
-- 6. comments — notes on public plans (optional / community)
-- ===========================================================================
create table public.comments (
  id         uuid primary key default gen_random_uuid(),
  plan_id    uuid not null references public.plans(id) on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  body       text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index comments_plan_id_idx on public.comments (plan_id);

alter table public.comments enable row level security;

create policy "comments on public plans are readable"
  on public.comments for select
  using (
    user_id = auth.uid()
    or exists (select 1 from public.plans p where p.id = plan_id and p.is_public)
  );

create policy "users comment as themselves on public plans"
  on public.comments for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.plans p where p.id = plan_id and p.is_public)
  );

create policy "users delete their own comments"
  on public.comments for delete to authenticated
  using (user_id = auth.uid());
