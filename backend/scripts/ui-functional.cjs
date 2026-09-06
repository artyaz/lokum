const { chromium } = require('playwright');
let failures = 0;
const ok = (c, l) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) failures++; };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  await page.goto('http://localhost:9120/#/login');
  await page.fill('#email', 'demo@lokum.dev');
  await page.fill('#pw', 'demo1234');
  await page.click('button[type=submit]');
  await page.waitForSelector('.cards-grid .listing-card');

  // change city via Filters -> feed must reload with Kraków
  await page.click('.filters .chip >> nth=1');
  await page.waitForSelector('.city-grid');
  await page.click('.city-grid .chip:has-text("Kraków")');
  await page.click('.footer-bar .btn-primary');
  await page.waitForTimeout(900);
  const meta = await page.textContent('.meta-row');
  ok(/Kraków/.test(meta), `city filter applied (${meta.trim()})`);

  // back to Warsaw
  await page.click('.filters .chip >> nth=1');
  await page.waitForSelector('.city-grid');
  await page.click('.city-grid .chip:has-text("Warsaw")');
  await page.click('.footer-bar .btn-primary');
  await page.waitForTimeout(900);

  // run dropdown: pick an older run -> feed shows that run's listings
  await page.click('.filters .chip:has-text("Latest run"), .filters .chip:has-text("Today"), .filters .chip:has-text("Yesterday")');
  await page.waitForSelector('.date-dropdown');
  const items = await page.locator('.date-item').count();
  ok(items >= 5, `run dropdown lists runs (${items})`);
  await page.locator('.date-item').nth(3).click();
  await page.waitForTimeout(900);
  const chipActive = await page.locator('.filters .chip-active').count();
  ok(chipActive >= 1, 'historical run chip highlighted');
  await page.click('.filters .chip-active');
  await page.waitForSelector('.date-dropdown');
  await page.locator('.date-item:has-text("Latest run")').click();
  await page.waitForTimeout(700);

  // dedupe: feed hides the 4 loser sources, keeps the preferred one (OLX)
  const feedTitles = await page.evaluate(async () => {
    const r = await fetch('/api/listings?city=warsaw&limit=200');
    return (await r.json()).listings.map(l => l.title);
  });
  const loserTitles = ['Przestronne 2 pokoje, Śródmieście', 'Mieszkanie 2-pokojowe do wynajęcia', 'Wynajem 2 pokoje centrum', '2 rooms, great location'];
  ok(feedTitles.filter(t => loserTitles.includes(t)).length === 0, 'feed hides duplicate losers');
  ok(feedTitles.includes('2-room flat near the centre'), 'feed keeps preferred source (OLX)');

  // duplicates page shows the 5-source group detected from matching photos
  await page.goto('http://localhost:9120/#/duplicates');
  await page.waitForTimeout(900);
  const dupBody = await page.textContent('body');
  ok(/OLX/i.test(dupBody) && /Otodom/i.test(dupBody), 'duplicate group shows both sources');
  const groupSize = await page.evaluate(async () => {
    const r = await fetch('/api/duplicates?city=warsaw');
    const d = await r.json();
    return Math.max(0, ...d.groups.map(g => g.listings.length));
  });
  ok(groupSize === 5, `same-flat group has all 5 sources (${groupSize})`);

  // settings content
  await page.goto('http://localhost:9120/#/settings');
  await page.waitForTimeout(1000);
  const setBody = await page.textContent('body');
  ok(/Morning & evening fetch|cron|fetch/i.test(setBody), 'settings shows cron job section');
  ok(/demo@lokum.dev/.test(setBody), 'settings shows account email');

  // import flow with fake parser
  await page.goto('http://localhost:9120/#/import');
  await page.waitForSelector('textarea');
  await page.fill('textarea', 'Wynajmę kawalerkę 28 m2, Wola, 2600 zł, od zaraz.');
  await page.click('button:has-text("Parse")');
  await page.waitForSelector('text=Parsed listing');
  const priceVal = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('.label')];
    const priceLabel = labels.find(l => /price/i.test(l.textContent));
    const input = priceLabel?.parentElement?.querySelector('input') || document.querySelectorAll('input[type=number]')[0];
    return input?.value;
  });
  ok(String(priceVal) === '2600', `import parsed price shown (${priceVal})`);

  // public share page (no auth)
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pub = await ctx2.newPage();
  await pub.goto('http://localhost:9120/#/s/demo0share0token');
  await pub.waitForTimeout(1200);
  const pubBody = await pub.textContent('body');
  ok(/Shared listing/.test(pubBody), 'public share page renders');
  ok(/Open on/.test(pubBody), 'public share has source button');

  // logout -> back to login
  await page.goto('http://localhost:9120/#/settings');
  await page.waitForTimeout(800);
  const logoutBtn = page.locator('button:has-text("Log out"), button:has-text("Logout")');
  if (await logoutBtn.count()) {
    await logoutBtn.first().click();
    await page.waitForTimeout(800);
    ok(page.url().includes('#/login'), 'logout returns to login');
  } else {
    ok(false, 'logout button found');
  }

  await browser.close();
  console.log(failures === 0 ? '\nALL FUNCTIONAL CHECKS PASSED' : `\n${failures} FAILURES`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('CRASH:', e); process.exit(1); });
