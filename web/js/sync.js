// sync.js — cloud data layer over Supabase (plans, snapshots, prices).
//
// Pure data API: functions take/return plain objects and never touch app state
// directly — app.js owns the wiring so the engine stays self-contained. Every
// write goes through ensureSession() so an anonymous account is created on first
// use; reads no-op (return []/null) when there is no session.
import { getClient, ensureSession, getUser } from './auth.js';

const LEAGUE = 'standard';   // single league for now; schema is keyed per-league

// ---- plans -----------------------------------------------------------------
export async function savePlan(p) {
  await ensureSession();
  const u = getUser();
  const row = {
    user_id: u.id,
    title: (p.title || 'Untitled plan').slice(0, 200),
    notes: p.notes ?? null,
    base_class: p.base_class ?? null,
    base_id: p.base_id ?? null,
    ilvl: p.ilvl ?? null,
    rune_flags: p.rune_flags ?? {},
    graph: p.graph,
    data_version: p.data_version ?? null,
  };
  const { data, error } = await getClient().from('plans').insert(row).select().single();
  if (error) throw error;
  return data;
}

export async function listPlans() {
  if (!getUser()) return [];
  const { data, error } = await getClient()
    .from('plans').select('*').order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function deletePlan(id) {
  const { error } = await getClient().from('plans').delete().eq('id', id);
  if (error) throw error;
}

// ---- snapshots -------------------------------------------------------------
export async function saveSnapshot(s) {
  await ensureSession();
  const u = getUser();
  const row = {
    user_id: u.id,
    plan_id: s.plan_id ?? null,
    label: (s.label || 'Snapshot').slice(0, 200),
    item: s.item,
    ctx: s.ctx ?? {},
  };
  const { data, error } = await getClient().from('snapshots').insert(row).select().single();
  if (error) throw error;
  return data;
}

export async function listSnapshots() {
  if (!getUser()) return [];
  const { data, error } = await getClient()
    .from('snapshots').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function deleteSnapshot(id) {
  const { error } = await getClient().from('snapshots').delete().eq('id', id);
  if (error) throw error;
}

// ---- prices ----------------------------------------------------------------
export async function pushPrices(prices, rates) {
  if (!getUser()) return;
  const { error } = await getClient().from('prices').upsert(
    { user_id: getUser().id, league: LEAGUE, prices, rates: rates || {} },
    { onConflict: 'user_id,league' });
  if (error) throw error;
}

export async function pullPrices() {
  if (!getUser()) return null;
  const { data, error } = await getClient()
    .from('prices').select('prices,rates').eq('league', LEAGUE).maybeSingle();
  if (error) throw error;
  return data;   // { prices, rates } | null
}
