// auth.js — Supabase session handling + a small account control in the header.
//
// Design: the app is fully usable signed-out (local-first). This module only
// *adds* an account. A real session is created lazily — anonymously on the first
// cloud write (see ensureSession), or for real when the user asks to sign in.
// The client library is the vendored UMD build, exposed as window.supabase.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

let client = null;
let session = null;
const listeners = new Set();

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Lazily construct the Supabase client. Throws if the library never loaded. */
export function getClient() {
  if (client) return client;
  if (!window.supabase || !window.supabase.createClient)
    throw new Error('Supabase client library not loaded (vendor/supabase.js)');
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,      // completes the magic-link redirect
      storageKey: 'poe2planner.auth',
    },
  });
  return client;
}

export function getUser() { return session ? session.user : null; }
export function isSignedIn() { return !!session; }
export function isAnonymous() {
  const u = getUser();
  return !!(u && (u.is_anonymous || (u.role === 'authenticated' && !u.email)));
}

/** Subscribe to session changes. Returns an unsubscribe fn. */
export function onAuthChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) { try { fn(session); } catch (e) { console.error(e); } } }

/** Guarantee *some* session exists (anonymous if needed) before a cloud write. */
export async function ensureSession() {
  if (session) return session;
  const { data, error } = await getClient().auth.signInAnonymously();
  if (error) throw error;
  session = data.session;
  return session;
}

/**
 * Start an email sign-in. If the user is currently an anonymous guest, convert
 * that same account in place (keeping everything they already saved); otherwise
 * send a normal magic link that creates/loads the account.
 */
export async function signInWithEmail(email) {
  const c = getClient();
  const redirect = location.href.split('#')[0];
  if (isAnonymous()) {
    const { error } = await c.auth.updateUser({ email }, { emailRedirectTo: redirect });
    if (error) throw error;
    return { converted: true };
  }
  const { error } = await c.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect } });
  if (error) throw error;
  return { converted: false };
}

export async function signOut() { await getClient().auth.signOut(); }

/** Boot: read any stored session and start listening. Safe to call once. */
export async function initAuth() {
  const c = getClient();
  const { data } = await c.auth.getSession();
  session = data.session;
  c.auth.onAuthStateChange((_event, s) => { session = s; renderAcct(); emit(); });
  renderAcct();
  emit();
}

// ---------------------------------------------------------------------------
// Account control (rendered into #acct)
// ---------------------------------------------------------------------------
function box() { return document.getElementById('acct'); }

function renderAcct() {
  const b = box();
  if (!b) return;
  const u = getUser();
  if (u && !isAnonymous() && u.email) {
    b.innerHTML =
      `<span class="acctwho" title="Signed in — plans, snapshots and prices sync to this account">` +
      `&#9729; ${esc(u.email)}</span>` +
      `<button class="ghost acctbtn" id="acctout">Sign out</button>`;
    b.querySelector('#acctout').onclick = doSignOut;
  } else if (u) {                                   // anonymous guest
    b.innerHTML =
      `<span class="acctwho acctguest" title="Guest — your data is saved to the cloud under a ` +
      `temporary account. Add an email to keep it and reach it from other devices.">&#9729; Guest</span>` +
      `<button class="ghost acctbtn" id="acctlink">Keep my account</button>` +
      `<button class="ghost acctbtn" id="acctout">Sign out</button>`;
    b.querySelector('#acctlink').onclick = openEmailForm;
    b.querySelector('#acctout').onclick = doSignOut;
  } else {                                          // signed out
    b.innerHTML = `<button class="ghost acctbtn" id="acctin">&#9729; Sign in</button>`;
    b.querySelector('#acctin').onclick = openEmailForm;
  }
}

function openEmailForm() {
  const b = box();
  if (!b) return;
  b.innerHTML =
    `<form class="acctform" id="acctform">` +
    `<input type="email" id="acctemail" placeholder="you@email.com" required autocomplete="email">` +
    `<button class="ghost acctbtn" type="submit">Email me a link</button>` +
    `<button class="ghost acctbtn" type="button" id="acctcancel">Cancel</button>` +
    `<span class="acctmsg" id="acctmsg"></span></form>`;
  const form = b.querySelector('#acctform');
  const msg = b.querySelector('#acctmsg');
  b.querySelector('#acctcancel').onclick = renderAcct;
  b.querySelector('#acctemail').focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const email = b.querySelector('#acctemail').value.trim();
    if (!email) return;
    msg.textContent = 'sending…';
    try {
      const { converted } = await signInWithEmail(email);
      msg.textContent = converted
        ? 'Check your email to confirm and keep this account.'
        : 'Check your email for the sign-in link.';
    } catch (err) {
      msg.textContent = 'Could not send: ' + (err.message || err);
    }
  };
}

async function doSignOut() {
  try { await signOut(); } catch (e) { console.error(e); }
}
