// Logic test for metro.js — static Warsaw dataset + haversine lookup.
// No DB / network. Run: FAKE_DB=1 node backend/test/test_metro.mjs

import { stationCount, haversineMeters, nearestMetro } from '../src/services/metro.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' ' + extra : ''}`); }
  else { fail++; console.error(`  ✗ FAIL: ${name}${extra ? ' ' + extra : ''}`); }
}

console.log('T1: dataset completeness');
ok('38 unique stations (M1 21 + M2 18 - 1 shared)', stationCount() === 38, `(${stationCount()})`);

console.log('T2: haversine sanity');
{
  // ~111.2 km per degree of latitude.
  const d = haversineMeters(52.0, 21.0, 53.0, 21.0);
  ok('1 deg latitude ~= 111km', d > 110000 && d < 112000, `(${d}m)`);
  ok('same point = 0m', haversineMeters(52.23, 21.01, 52.23, 21.01) === 0);
}

console.log('T3: station identity lookups');
{
  // OSM node coords straight from the dataset — must resolve to themselves.
  const centrum = nearestMetro(52.231007, 21.010186);
  ok('Centrum node -> Centrum', centrum?.name === 'Centrum', `(${centrum?.name})`);
  ok('Centrum distance ~0m', (centrum?.distance_m ?? 999) < 5, `(${centrum?.distance_m}m)`);
  const mlociny = nearestMetro(52.29077, 20.929868);
  ok('Młociny node -> Młociny M1', mlociny?.name === 'Młociny' && mlociny?.line === 'M1');
  const brodno = nearestMetro(52.293585, 21.028939);
  ok('Bródno node -> Bródno M2', brodno?.name === 'Bródno' && brodno?.line === 'M2');
  const interchange = nearestMetro(52.235095, 21.007899);
  ok('Świętokrzyska interchange line M1/M2', interchange?.name === 'Świętokrzyska' && interchange?.line === 'M1/M2');
}

console.log('T4: real-world proximity');
{
  // Palace of Culture (52.2319, 21.0067) sits ~400m from Centrum station.
  const pk = nearestMetro(52.2319, 21.0067);
  ok('PKiN -> Centrum', pk?.name === 'Centrum', `(${pk?.name} ${pk?.distance_m}m)`);
  ok('PKiN within 600m of metro', (pk?.distance_m ?? 9999) < 600);
  // Białołęka depths (no metro): nearest should be far (>3km).
  const bia = nearestMetro(52.325, 21.025);
  ok('Białołęka far from metro (>3km)', (bia?.distance_m ?? 0) > 3000, `(${bia?.name} ${bia?.distance_m}m)`);
}

console.log('T5: invalid input');
{
  ok('null -> null', nearestMetro(null, null) === null);
  ok('NaN -> null', nearestMetro(NaN, 21) === null);
}

console.log(`\n--- Done: ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
