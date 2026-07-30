// router.js — minimal hash routing for shared plans. No framework, ~30 lines.
//
// A shared plan lives at  <site>/#/p/<slug>  — the hash keeps it a pure static
// site (no server rewrites) and works identically on GitHub Pages or any host.

/** Parse the current hash. Returns { view:'plan', slug } or null. */
export function parseHash() {
  const m = location.hash.match(/^#\/p\/([A-Za-z0-9_-]{4,64})$/);
  return m ? { view: 'plan', slug: m[1] } : null;
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

/** Set the hash without adding a history entry (used after loading a share). */
export function clearRoute() {
  history.replaceState(null, '', location.pathname + location.search);
}
