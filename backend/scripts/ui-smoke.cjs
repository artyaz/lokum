// Browser smoke test for the Lokum UI against FAKE_DB backend.
// Run: FAKE_DB backend on :9120, then `node scripts/ui-smoke.js`.

const { chromium } = require('playwright');

const BASE = 'http://localhost:9120';
let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  // ---------- desktop ----------
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(BASE + '/');
  await page.waitForTimeout(600);
  ok(page.url().includes('#/login'), 'redirects to login when unauthenticated');

  await page.fill('#email', 'demo@lokum.dev');
  await page.fill('#pw', 'demo1234');
  await page.click('button[type=submit]');
  await page.waitForSelector('.cards-grid .listing-card', { timeout: 10000 });
  ok(true, 'login -> feed renders cards');

  const cardCount = await page.locator('.cards-grid .listing-card').count();
  ok(cardCount >= 10, `feed has ${cardCount} cards (first page)`);

  const meta = await page.textContent('.meta-row');
  ok(/listings in Warsaw/.test(meta), 'feed meta row shows count + city');

  // grid should be multi-column on desktop
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.cards-grid')).gridTemplateColumns.split(' ').length);
  ok(cols >= 2, `desktop grid has ${cols} columns`);

  // scroll deep into the feed (triggers infinite scroll)
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(1200);
  const scrollBefore = await page.evaluate(() => window.scrollY);
  const countAfterScroll = await page.locator('.cards-grid .listing-card').count();
  ok(scrollBefore > 2000, `scrolled deep (y=${Math.round(scrollBefore)})`);
  ok(countAfterScroll > cardCount, `infinite scroll loaded more (${cardCount} -> ${countAfterScroll})`);

  // open a listing detail
  await page.evaluate(() => document.querySelector('.cards-grid .listing-card .action-btn.primary').click());
  await page.waitForSelector('.detail-grid .title', { timeout: 8000 });
  ok(page.url().includes('#/listing/'), 'detail route opened');
  const detailTitle = await page.textContent('.detail-grid .title');
  ok(detailTitle.length > 5, 'detail shows title');
  const detailCols = await page.evaluate(() => getComputedStyle(document.querySelector('.detail-grid')).gridTemplateColumns.split(' ').length);
  ok(detailCols === 2, 'detail uses 2-column desktop layout');

  // go back -> feed scroll restored
  await page.goBack();
  await page.waitForSelector('.cards-grid .listing-card', { timeout: 8000 });
  await page.waitForTimeout(500);
  const scrollAfterBack = await page.evaluate(() => window.scrollY);
  ok(Math.abs(scrollAfterBack - scrollBefore) < 80, `scroll restored on back (${Math.round(scrollBefore)} -> ${Math.round(scrollAfterBack)})`);
  const countAfterBack = await page.locator('.cards-grid .listing-card').count();
  ok(countAfterBack === countAfterScroll, 'feed data kept (no refetch/reset)');

  // saved page
  await page.click('.app-bar-actions button[aria-label="Saved"]');
  await page.waitForTimeout(700);
  ok(page.url().includes('#/saved'), 'saved page opens');
  ok((await page.locator('.listing-card').count()) >= 1, 'saved shows cards');

  // back to feed, scroll still preserved
  await page.goBack();
  await page.waitForTimeout(500);
  const scrollAfterSaved = await page.evaluate(() => window.scrollY);
  ok(Math.abs(scrollAfterSaved - scrollBefore) < 80, 'scroll preserved after saved round-trip');

  // filters page
  await page.click('.filters .chip >> nth=0');
  await page.waitForSelector('.city-grid', { timeout: 8000 });
  ok(true, 'filters page renders');
  await page.click('.footer-bar .btn-primary');
  await page.waitForTimeout(400);
  ok(page.url().includes('#/feed'), 'filters -> show listings returns to feed');

  // regions (leaflet map)
  await page.click('.app-bar-actions button[aria-label="Regions"]');
  await page.waitForSelector('.leaflet-container', { timeout: 10000 });
  await page.waitForTimeout(800);
  const tiles = await page.locator('.leaflet-container img').count();
  ok(tiles > 0, `regions map renders (${tiles} tiles)`);

  // settings
  await page.click('.app-bar-actions button[aria-label="Settings"]');
  await page.waitForTimeout(900);
  ok(page.url().includes('#/settings'), 'settings page opens');

  // duplicates
  await page.goto(BASE + '/#/duplicates');
  await page.waitForTimeout(900);
  const dupText = await page.textContent('body');
  ok(/duplicate/i.test(dupText), 'duplicates page renders');

  // import
  await page.goto(BASE + '/#/import');
  await page.waitForTimeout(700);
  ok(page.url().includes('#/import'), 'import page opens');

  // run dropdown on feed
  await page.goto(BASE + '/#/feed');
  await page.waitForSelector('.filters .chip', { timeout: 8000 });
  await page.waitForTimeout(400);

  // ---------- mobile ----------
  const mob = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mob.on('pageerror', (e) => errors.push('mobile pageerror: ' + e.message));
  await mob.goto(BASE + '/#/login');
  await mob.fill('#email', 'demo@lokum.dev');
  await mob.fill('#pw', 'demo1234');
  await mob.click('button[type=submit]');
  await mob.waitForSelector('.cards-grid .listing-card', { timeout: 10000 });
  const mobCols = await mob.evaluate(() => getComputedStyle(document.querySelector('.cards-grid')).gridTemplateColumns.split(' ').length);
  ok(mobCols === 1, 'mobile grid is single column');

  // mobile: scroll, open detail, back
  for (let i = 0; i < 4; i++) { await mob.mouse.wheel(0, 1200); await mob.waitForTimeout(200); }
  await mob.waitForTimeout(1000);
  const mobScroll = await mob.evaluate(() => window.scrollY);
  await mob.evaluate(() => document.querySelector('.cards-grid .listing-card .action-btn.primary').click());
  await mob.waitForSelector('.detail-grid .title', { timeout: 8000 });
  await mob.goBack();
  await mob.waitForSelector('.cards-grid .listing-card', { timeout: 8000 });
  await mob.waitForTimeout(500);
  const mobScrollBack = await mob.evaluate(() => window.scrollY);
  ok(Math.abs(mobScrollBack - mobScroll) < 80, `mobile scroll restored (${Math.round(mobScroll)} -> ${Math.round(mobScrollBack)})`);

  await browser.close();

  const realErrors = errors.filter(e =>
    !e.includes('favicon') && !e.includes('tile.openstreetmap') && !e.includes('net::ERR') && !e.includes('401'));
  ok(realErrors.length === 0, `no page errors (${realErrors.length})`);
  if (realErrors.length) console.log(realErrors.slice(0, 10).join('\n'));

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('SMOKE CRASH:', e); process.exit(1); });
