/**
 * Strict step model: a removal can undo progress, and you re-climb with the
 * SAME currency you are already holding.
 *
 * Earlier steps are not re-run. If an Exalt's Annul strips the Life modifier a
 * Regal put on, you do not go back and Regal again — the item is already Rare,
 * so you Exalt until that modifier is back. Each step is therefore a biased
 * random walk in "targets landed", driven by one currency:
 *
 *   add + Annul recovery   up = p            down = (1-p)*r
 *   chaos                  up = (1-r)*p      down = r*(1-p)
 *   otherwise              up = p            down = 0
 *
 * with r = L/M the chance a removal takes a landed target rather than junk.
 * Expected applications to gain one net target is 1/(up-down); if down >= up
 * the step never converges and the plan is impossible.
 *
 * Bricking is unchanged and still restarts the whole plan, so it stays in the
 * outer solver.
 */
export function stepWalk(s) {
  const p = s.p, r = Math.min(1, (s.mods > 0 ? (s.landed || 0) / s.mods : 0));
  let up, down;
  if (s.kind === 'chaos') { up = (1 - r) * p; down = r * (1 - p); }
  else if (s.rec === 'annul' && s.fail !== 'brick') { up = p; down = (1 - p) * r; }
  else { up = p; down = 0; }
  const net = up - down;
  if (!(net > 0)) return { uses: Infinity, rec: Infinity, net };
  const uses = 1 / net;
  return { uses, rec: s.rec === 'annul' ? (1 - p) * uses : 0, net, up, down };
}

export function solveStrict(steps, { baseCost = 1 } = {}) {
  const add = (t, k, v) => { if (v) t[k] = (t[k] || 0) + v; return t; };
  const scale = (t, f) => { const o = {}; for (const k in t) o[k] = t[k] * f; return o; };
  const merge = (a, b) => { const o = { ...a }; for (const k in b) add(o, k, b[k]); return o; };

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
                     .reduce((a, [, v]) => a + v, 0);
  return { perGoal, spend: sum(perGoal), bricks: perGoal.brick || 0, pRun,
           walks, strict: true };
}
