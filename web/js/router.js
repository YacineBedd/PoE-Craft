// router.js — minimal hash routing for shared plans. No framework, ~30 lines.
//
// A shared plan lives at  <site>/#/p/<slug>  — the hash keeps it a pure static
// site (no server rewrites) and works identically on GitHub Pages or any host.

/** Parse the current hash. Returns { view:'plan', slug } | { view:'item', data } | null. */
export function parseHash() {
  const p = location.hash.match(/^#\/p\/([A-Za-z0-9_-]{4,64})$/);
  if (p) return { view: 'plan', slug: p[1] };
  // a self-contained shared item: the whole crafted item + spend is base64url in the hash
  const i = location.hash.match(/^#\/i\/([A-Za-z0-9_-]+)$/);
  if (i) return { view: 'item', data: i[1] };
  return null;
}

/** Register a route handler; call the returned fn once for the initial route. */
export function onRoute(handler) {
  const run = () => handler(parseHash());
  window.addEventListener('hashchange', run);
  return run;
}

/** Build the shareable URL for a slug (origin + path + hash). */
export function shareUrl(slug) {
  return location.origin + location.pathname + '#/p/' + slug;
}

/** Build the self-contained shareable URL for an encoded item payload. */
export function itemShareUrl(enc) {
  return location.origin + location.pathname + '#/i/' + enc;
}

/** Set the hash without adding a history entry (used after loading a share). */
export function clearRoute() {
  history.replaceState(null, '', location.pathname + location.search);
}
