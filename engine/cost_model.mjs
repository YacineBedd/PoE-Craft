/**
 * Expected-cost model for a linear craft plan, with recoverable failures and bricks.
 *
 * A plan is steps S0..S(n-1). Each step costs one unit of its currency and
 * succeeds with probability p. On failure it either:
 *   'retry' — pay a recovery currency (e.g. an Annul) and try the step again
 *   'brick' — the item is dead; throw it away and restart from a fresh base
 *
 * Let E_i be the expected currency-usage vector from step i to a landed goal.
 *   E_n = 0
 *   retry:  E_i = ( e(c_i) + (1-p)·e(rec_i) ) / p  +  E_{i+1}
 *   brick:  E_i = e(c_i) + p·E_{i+1} + (1-p)·( e(base) + E_0 )
 *
 * Every E_i is therefore  A_i + B_i·E_0  with A a vector and B a scalar, so
 *   E_0 = A_0 / (1 - B_0)
 * which is exact — no simulation.
 */

const add = (t, k, v) => { if (v) t[k] = (t[k] || 0) + v; return t; };
const scale = (t, f) => { const o = {}; for (const k in t) o[k] = t[k] * f; return o; };
const merge = (a, b) => { const o = { ...a }; for (const k in b) add(o, k, b[k]); return o; };
const total = t => Object.entries(t)
  .filter(([k]) => k !== 'brick').reduce((s, [, v]) => s + v, 0);

export function solvePlan(steps, { baseCost = 1 } = {}) {
  for (const s of steps) if (!(s.p > 0)) return null;   // unreachable step

  let A = {}, B = 0;                                    // E_n = 0
  const tail = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i], p = s.p, q = 1 - p;
    if (s.fail === 'brick') {
      // one use of c_i, then advance or die
      let Ai = merge(add({}, s.cur, 1), scale(A, p));
      Ai = merge(Ai, scale(add(add({}, 'base', baseCost), 'brick', 1), q));
      B = p * B + q;
      A = Ai;
    } else {
      const per = merge(add({}, s.cur, 1), s.rec ? add({}, s.rec, q) : {});
      A = merge(scale(per, 1 / p), A);
      // B unchanged: a retry step never restarts the plan
    }
    tail[i] = { A, B };
  }

  if (B >= 1) return null;                              // never terminates
  const E0 = scale(A, 1 / (1 - B));

  // Per-run view: probability one fresh base carries all the way through,
  // counting only the steps that can actually kill it.
  let pRun = 1, successRun = {};
  for (const s of steps) {
    if (s.fail === 'brick') { pRun *= s.p; add(successRun, s.cur, 1); }
    else {
      add(successRun, s.cur, 1 / s.p);
      if (s.rec) add(successRun, s.rec, (1 - s.p) / s.p);
    }
  }
  add(successRun, 'base', baseCost);

  const bricks = E0.brick || 0;
  const spend = total(E0);
  const clean = total(successRun);
  const wasted = spend > 0 ? Math.max(0, (spend - clean) / spend) : 0;

  return {
    perGoal: E0,          // expected uses of each currency per landed goal
    spend,                // total expected currency items per landed goal
    bricks,               // expected dead items per landed goal
    pRun,                 // chance one fresh base survives the whole plan
    wasted,               // share of spend burned on runs that bricked
    cleanRun: successRun, // spend of a single clean pass
  };
}

export { total as totalSpend };
