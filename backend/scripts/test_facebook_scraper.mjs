import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isLikelyRental,
  normalizeFacebookPost,
  parseArea,
  parseFloor,
  parsePrice,
  parseRooms,
} from '../src/services/scrapers/facebook.js';
import { decryptFacebookCookies, encryptFacebookCookies, parseFacebookCookies as parseVaultCookies } from '../src/services/facebook-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');

test('the DOCX directory import contains 365 unique groups', () => {
  const directory = JSON.parse(fs.readFileSync(path.join(backendRoot, 'data/facebook_groups.json'), 'utf8'));
  assert.equal(directory.group_count, 365);
  assert.equal(directory.groups.length, 365);
  assert.equal(new Set(directory.groups.map(group => group.group_id)).size, 365);
  assert.equal(directory.groups.filter(group => group.essential).length, 15);
  assert.equal(directory.groups.filter(group => !group.group_id).length, 0);
});

test('migration seeds every canonical Facebook group', () => {
  const directory = JSON.parse(fs.readFileSync(path.join(backendRoot, 'data/facebook_groups.json'), 'utf8'));
  const migration = fs.readFileSync(path.join(backendRoot, 'src/sql/migration_005_facebook.sql'), 'utf8');
  const seeded = new Set([...migration.matchAll(/^  \('([^']+)',/gm)].map(match => match[1]));
  assert.equal(seeded.size, 365);
  for (const group of directory.groups) assert.ok(seeded.has(group.group_id), `missing ${group.group_id}`);
});

test('Facebook rental text is normalized into Lokum fields', () => {
  const group = {
    group_id: 'demo-group',
    name: 'Demo Warsaw Rentals',
    category: 'Test',
    categories: ['Essential Groups (Tier 1)', 'Test'],
  };
  const city = { id: 1 };
  const post = {
    post_id: '123456',
    post_url: 'https://mbasic.facebook.com/groups/demo-group/posts/123456',
    text: 'Mokotów, 2 pokoje — 45 m2, cena 3 800 zł/miesiąc, piętro 3',
    images: ['https://example.test/a.jpg', 'https://example.test/a.jpg'],
    username: 'Demo user',
    time: '2026-08-28T10:00:00Z',
  };
  const listing = normalizeFacebookPost(post, group, city);

  assert.equal(listing.externalId, 'fb:demo-group:123456');
  assert.equal(listing.sourceId, 7);
  assert.equal(listing.cityId, 1);
  assert.equal(listing.price, 3800);
  assert.equal(listing.rooms, 2);
  assert.equal(listing.area, 45);
  assert.equal(listing.floor, 3);
  assert.equal(listing.district, 'Mokotów');
  assert.equal(listing.url, 'https://www.facebook.com/groups/demo-group/posts/123456');
  assert.deepEqual(listing.images, ['https://example.test/a.jpg']);
});

test('parsers handle common Polish and English forms', () => {
  assert.equal(parsePrice('2 pokoje, 45 m2, 3 800 zł'), 3800);
  assert.equal(parsePrice('Cena: 12.000 zł'), 12000);
  assert.equal(parseRooms('3-room flat'), 3);
  assert.equal(parseRooms('kawalerka'), 1);
  assert.equal(parseArea('45,5 m2'), 45.5);
  assert.equal(parseFloor('floor 5'), 5);
  assert.equal(isLikelyRental('Apartment for rent in Wola'), true);
  assert.equal(isLikelyRental('Sprzedam mieszkanie'), false);
});

test('Python bridge emits deterministic dry-run JSON lines', () => {
  const input = {
    dry_run: true,
    groups: [{
      group_id: 'demo-group',
      name: 'Demo Warsaw Rentals',
      url: 'https://www.facebook.com/groups/demo-group',
    }],
  };
  const result = spawnSync('python3', [path.join(__dirname, 'facebook_scraper_bridge.py')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(event => event.type), ['group_start', 'post', 'group_done', 'done']);
  assert.equal(events.at(-1).posts, 1);
});

test('Python bridge reports missing auth instead of crashing when require_auth has no cookies', () => {
  // Regression: has_auth() previously called cookie_source() with no argument,
  // crashing with TypeError and masking the real "no session configured" state.
  const input = {
    dry_run: false,
    require_auth: true,
    groups: [{
      group_id: 'demo-group',
      name: 'Demo Warsaw Rentals',
      url: 'https://www.facebook.com/groups/demo-group',
    }],
  };
  const result = spawnSync('python3', [path.join(__dirname, 'facebook_scraper_bridge.py')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  assert.equal(result.status, 2, result.stderr);
  const events = result.stdout.trim().split('\n').map(JSON.parse);
  const fatal = events.find(event => event.type === 'fatal');
  assert.ok(fatal, 'expected a fatal event');
  assert.match(fatal.error, /No authenticated Facebook session/);
});

test('Facebook cookie vault accepts common exports and encrypts payloads', () => {
  const parsed = parseVaultCookies([
    { name: 'xs', value: 'xs-secret', domain: '.facebook.com', expirationDate: 1900000000 },
    { name: 'c_user', value: '1000000001', domain: '.facebook.com', expirationDate: 1900000000 },
    { name: 'tracker', value: 'no', domain: '.example.com' },
  ]);
  assert.equal(parsed.cookies.length, 2);
  assert.equal(parsed.expiresAt?.getTime(), 1900000000000);

  const headerParsed = parseVaultCookies('c_user=1000000001; xs=xs-secret');
  assert.equal(headerParsed.cookies.length, 2);

  const encrypted = encryptFacebookCookies(parsed.cookies);
  assert.equal(decryptFacebookCookies(encrypted).at(0).name, 'xs');
});
