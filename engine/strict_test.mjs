import { solveStrict, stepWalk } from './strict_model.mjs';
let pass=0, fail=0;
const ok=(l,c,x='')=>{c?pass++:fail++;console.log(`${c?' ok ':'FAIL'}  ${l}${x?'  '+x:''}`);};
const rel=(a,b)=>Math.abs(a-b)/Math.max(Math.abs(b),1e-9);

/** Simulate one step's walk: how many applications to net one more target. */
function simStep(s, runs=30000){
  let uses=0, recs=0;
  const r=Math.min(1,(s.landed||0)/Math.max(1,s.mods));
  for(let n=0;n<runs;n++){
    let L=0, guard=0;               // net progress for this step
    while(L<1 && guard++<200000){
      uses++;
      const hit=Math.random()<s.p;
      if(s.kind==='chaos'){
        const took=Math.random()<r;
        if(took&&hit) {} else if(took&&!hit) L--; else if(!took&&hit) L++;
      } else if(hit) L++;
      else if(s.rec==='annul'){ recs++; if(Math.random()<r) L--; }
    }
  }
  return {uses:uses/runs, rec:recs/runs};
}

const check=(label,s)=>{
  const w=stepWalk(s), m=simStep(s);
  const eu=rel(w.uses,m.uses), er=s.rec==='annul'?rel(w.rec,m.rec):0;
  ok(label, eu<0.04 && er<0.04,
     `uses ${w.uses.toFixed(2)} vs ${m.uses.toFixed(2)} (${(eu*100).toFixed(1)}%)`);
};

// convergent walks: net drift must be positive for the mean to exist
check('plain retry, no removal',       {p:0.25,mods:0,landed:0,kind:'orb'});
check('annul recovery, light risk',    {p:0.30,mods:10,landed:1,rec:'annul',kind:'orb'});
check('annul recovery, real risk',     {p:0.45,mods:8,landed:2,rec:'annul',kind:'orb'});
check('chaos, low target density',     {p:0.35,mods:12,landed:1,kind:'chaos'});
check('chaos, moderate density',       {p:0.50,mods:8,landed:2,kind:'chaos'});

// the drift condition itself: a step converges only while p > (1-p)*r
{
  const near={p:0.30,mods:10,landed:2,rec:'annul',kind:'orb'};   // r=0.2, net=0.30-0.14
  const w=stepWalk(near);
  ok('drift condition matches p > (1-p)r', w.net > 0 && rel(w.net, 0.30-0.7*0.2) < 1e-9,
     `net ${w.net.toFixed(3)}`);
}

// an unwinnable step must be reported, not silently returned
{
  const w=stepWalk({p:0.05,mods:4,landed:4,rec:'annul',kind:'orb'});
  ok('step that cannot converge is flagged', !isFinite(w.uses), `net ${w.net.toFixed(4)}`);
  ok('and the plan solves to null',
     solveStrict([{cur:'exalted',p:0.05,mods:4,landed:4,rec:'annul',fail:'retry',kind:'orb'}])===null);
}
// with no removal risk strict must equal the simple 1/p answer
{
  const s=[{cur:'exalted',p:0.2,mods:0,landed:0,rec:null,fail:'retry',kind:'orb'}];
  ok('no risk means strict == simple', rel(solveStrict(s).perGoal.exalted,5)<1e-9);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
