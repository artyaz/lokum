// Logic test for the totalprice.js graceful-heuristic fallback.
// Verifies heuristicEstimate() (pure, no DB / network): every listing with
// a rent gets a total even when description + params are empty, the utility
// guess scales with size inside a sane band, and price<=0 yields null.
// Run: FAKE_DB=1 node backend/test/test_totalprice_heuristic.mjs
// (FAKE_DB=1 keeps the db.js import from requiring a DATABASE_URL.)

import { heuristicEstimate } from '../src/services/totalprice.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' ' + extra : ''}`); }
  else { fail++; console.error(`  ✗ FAIL: ${name}${extra ? ' ' + extra : ''}`); }
}

console.log('T1: area-based estimate');
{
  const r = heuristicEstimate({ price: 2500, area: 40, rooms: 2 });
  ok('returns a result', !!r);
  ok('rent echoes price', r?.rent === 2500);
  ok('utilities ~= area*7 (280)', r?.extras?.[0]?.amount === 280, `(${r?.extras?.[0]?.amount})`);
  ok('marked estimated', r?.extras?.[0]?.estimated === true);
  ok('total = rent + utilities', r?.total_monthly === 2780, `(${r?.total_monthly})`);
  ok('currency PLN', r?.currency === 'PLN');
}

console.log('T2: rooms-only fallback');
{
  const r = heuristicEstimate({ price: 2000, area: null, rooms: 2 });
  ok('utilities = rooms*90 (180)', r?.extras?.[0]?.amount === 180, `(${r?.extras?.[0]?.amount})`);
  ok('total = 2180', r?.total_monthly === 2180);
}

console.log('T3: no size info fallback');
{
  const r = heuristicEstimate({ price: 3000, area: null, rooms: null });
  ok('utilities default 250', r?.extras?.[0]?.amount === 250, `(${r?.extras?.[0]?.amount})`);
}

console.log('T4: clamp band');
{
  const big = heuristicEstimate({ price: 5000, area: 100, rooms: 4 });
  ok('large flat clamped to 500', big?.extras?.[0]?.amount === 500, `(${big?.extras?.[0]?.amount})`);
  const small = heuristicEstimate({ price: 1500, area: 12, rooms: 1 });
  ok('tiny flat floored to 150', small?.extras?.[0]?.amount === 150, `(${small?.extras?.[0]?.amount})`);
}

console.log('T5: no honest total without rent');
{
  ok('price 0 -> null', heuristicEstimate({ price: 0, area: 40 }) === null);
  ok('missing price -> null', heuristicEstimate({ area: 40 }) === null);
}

console.log(`\n--- Done: ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
