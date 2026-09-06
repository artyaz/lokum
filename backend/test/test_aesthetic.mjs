// Logic test for aesthetic.js eligibility + rating parse (pure, no DB /
// network — rateImages itself is exercised live, not here).
// Run: FAKE_DB=1 node backend/test/test_aesthetic.mjs

import { isEligible, parseRating } from '../src/services/aesthetic.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' ' + extra : ''}`); }
  else { fail++; console.error(`  ✗ FAIL: ${name}${extra ? ' ' + extra : ''}`); }
}

console.log('T1: price eligibility (<3000 PLN total)');
{
  ok('2999 eligible', isEligible({ total_estimate: 2999, metro_distance_m: 5000, centrum_distance_m: 9000 }));
  ok('3000 not by price', !isEligible({ total_estimate: 3000, metro_distance_m: 5000, centrum_distance_m: 9000 }));
  ok('null total falls through', !isEligible({ total_estimate: null, metro_distance_m: 5000, centrum_distance_m: 9000 }));
}

console.log('T2: metro proximity eligibility (<=800m)');
{
  ok('800m eligible', isEligible({ total_estimate: 5000, metro_distance_m: 800, centrum_distance_m: 9000 }));
  ok('801m not by metro', !isEligible({ total_estimate: 5000, metro_distance_m: 801, centrum_distance_m: 9000 }));
}

console.log('T3: centrum proximity eligibility (<=2500m)');
{
  ok('2500m eligible', isEligible({ total_estimate: 5000, metro_distance_m: 5000, centrum_distance_m: 2500 }));
  ok('2501m not eligible', !isEligible({ total_estimate: 5000, metro_distance_m: 5000, centrum_distance_m: 2501 }));
}

console.log('T4: rating parse');
{
  const r = parseRating('{"score": 8, "notes": "Bright and modern."}');
  ok('parses score', r?.score === 8, `(${r?.score})`);
  ok('parses notes', r?.notes === 'Bright and modern.');
  ok('fences tolerated', parseRating('```json\n{"score":5,"notes":null}\n```')?.score === 5);
  ok('out-of-range rejected', parseRating('{"score": 11}') === null);
  ok('garbage rejected', parseRating('no json here') === null);
  ok('empty rejected', parseRating('') === null);
}

console.log(`\n--- Done: ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
