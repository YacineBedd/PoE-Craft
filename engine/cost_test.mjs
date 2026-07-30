import { solvePlan, totalSpend } from './cost_model.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

/** Brute-force the same plan by simulation, counting currency use. */
function simulate(steps, runs = 300000, baseCost = 1) {
  let use = {}, bricks = 0, goals = 0;
  const bump = (k, v = 1) => use[k] = (use[k] || 0) + v;
  for (let g = 0; g < runs; g++) {
    let i = 0;
    bump('base', baseCost);
    while (i < steps.length) {
      const s = steps[i];
      bump(s.cur);
      if (Math.random() < s.p) { i++; continue; }
      if (s.fail === 'brick') { bricks++; bump('base', baseCost); i = 0; }
      else if (s.rec) bump(s.rec);
    }
    goals++;
  }
  const per = {}; for (const k in use) per[k] = use[k] / goals;
  return { per, bricks: bricks / goals, spend: totalSpend(per) };
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- 1. single retry step: expected uses is the classic 1/p
{
  const steps = [{ cur: 'exalted', p: 0.2, fail: 'retry', rec: null }];
  const r = solvePlan(steps);
  ok('retry step costs 1/p', near(r.perGoal.exalted, 5, 1e-9), `${r.perGoal.exalted}`);
  ok('retry step never bricks', r.bricks === 0);
}

// ---- 2. retry with a recovery currency
{
  const steps = [{ cur: 'exalted', p: 0.25, fail: 'retry', rec: 'annul' }];
  const r = solvePlan(steps);
  ok('recovery uses (1-p)/p', near(r.perGoal.annul, 3, 1e-9), `${r.perGoal.annul}`);
}

// ---- 3. single brick step: 1/p attempts, (1-p)/p bricks
{
  const steps = [{ cur: 'regal', p: 0.1, fail: 'brick' }];
  const r = solvePlan(steps);
  ok('brick step uses 1/p currency', near(r.perGoal.regal, 10, 1e-9), `${r.perGoal.regal}`);
  ok('bricks = (1-p)/p', near(r.bricks, 9, 1e-9), `${r.bricks}`);
}

// ---- 4. a mixed three-step plan, closed form vs simulation
{
  const steps = [
    { cur: 'transmute', p: 0.14, fail: 'brick' },
    { cur: 'aug',       p: 0.30, fail: 'retry', rec: 'annul' },
    { cur: 'exalted',   p: 0.085, fail: 'brick' },
  ];
  const r = solvePlan(steps);
  const m = simulate(steps);
  const rel = (a, b) => Math.abs(a - b) / Math.max(b, 1e-9);
  ok('mixed plan: total spend matches simulation',
     rel(r.spend, m.spend) < 0.02, `closed ${r.spend.toFixed(2)} vs mc ${m.spend.toFixed(2)}`);
  ok('mixed plan: bricks match simulation',
     rel(r.bricks, m.bricks) < 0.02, `closed ${r.bricks.toFixed(2)} vs mc ${m.bricks.toFixed(2)}`);
  for (const k of ['transmute', 'aug', 'annul', 'exalted']) {
    ok(`  per-currency ${k}`, rel(r.perGoal[k], m.per[k]) < 0.03,
       `${r.perGoal[k].toFixed(2)} vs ${m.per[k].toFixed(2)}`);
  }
  ok('pRun is the product of brick-step probabilities',
     near(r.pRun, 0.14 * 0.085, 1e-12), `${r.pRun}`);
  ok('wasted share is in (0,1)', r.wasted > 0 && r.wasted < 1,
     `${(r.wasted * 100).toFixed(1)}%`);
}

// ---- 5. all-retry plan can never brick, so nothing is wasted
{
  const steps = [
    { cur: 'aug', p: 0.4, fail: 'retry', rec: 'annul' },
    { cur: 'exalted', p: 0.2, fail: 'retry', rec: 'annul' },
  ];
  const r = solvePlan(steps);
  ok('all-retry plan wastes nothing', r.bricks === 0 && r.wasted === 0);
  ok('all-retry survives every run', near(r.pRun, 1, 1e-12));
}

// ---- 6. degenerate guards
ok('impossible step returns null', solvePlan([{ cur: 'x', p: 0, fail: 'brick' }]) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
