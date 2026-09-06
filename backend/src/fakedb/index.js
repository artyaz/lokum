// In-memory fake Postgres, plugged into db.js when FAKE_DB=1.
// Implements the exact query shapes used by the app against an in-memory
// table store seeded with sample data — no SQL parsing, deterministic.

import { randomUUID } from 'node:crypto';
import { buildSeed } from './seed.js';

const store = buildSeed();
const t = (name) => store.tables[name];

const norm = (text) => text.replace(/\s+/g, ' ').trim();

// Find which $n a clause binds to, then return that param value.
function arg(sql, params, re) {
  const m = sql.match(re);
  return m ? params[parseInt(m[1], 10) - 1] : undefined;
}

const byId = (rows, id) => rows.find(r => r.id === id);
const clone = (r) => (r ? { ...r } : r);

function latestRealRun() {
  return t('cron_runs')
    .filter(r => ['success', 'partial'].includes(r.status) && ['cron', 'manual'].includes(r.triggered_by))
    .sort((a, b) => b.started_at - a.started_at)[0] || null;
}

function joinListing(l) {
  const s = byId(t('sources'), l.source_id);
  const c = byId(t('cities'), l.city_id);
  return {
    ...l,
    source_name: s?.name, source_slug: s?.slug, source_color: s?.color,
    city_name: c?.name, city_name_pl: c?.name_pl, city_slug: c?.slug
  };
}

// ---- feed filtering shared by list + count ----
function feedRows(sql, params) {
  const citySlug = arg(sql, params, /c\.slug = \$(\d+)/);
  const sourceSlug = arg(sql, params, /s\.slug = \$(\d+)/);
  const maxPrice = arg(sql, params, /l\.price <= \$(\d+)/);
  const minRooms = arg(sql, params, /l\.rooms >= \$(\d+)/);
  const maxRooms = arg(sql, params, /l\.rooms <= \$(\d+)/);
  const runId = arg(sql, params, /crl\.cron_run_id = \$(\d+)/);
  const joinsRuns = sql.includes('JOIN cron_run_listings crl');

  const latest = latestRealRun();
  const targetRunId = runId || (joinsRuns ? latest?.id : null);

  // feed hides duplicate losers (id_b of every stored pair)
  const losers = new Set(t('listing_duplicates').map(d => d.id_b));

  const seenIn = new Set();
  if (targetRunId) {
    for (const crl of t('cron_run_listings')) {
      if (crl.cron_run_id === targetRunId && crl.was_new) seenIn.add(crl.listing_id);
    }
  }
  const isNewIn = new Set();
  if (latest) {
    for (const crl of t('cron_run_listings')) {
      if (crl.cron_run_id === latest.id && crl.was_new) isNewIn.add(crl.listing_id);
    }
  }

  let rows = t('listings').filter(l => {
    if (losers.has(l.id)) return false;
    if (!runId && l.is_active !== true) return false;
    const city = byId(t('cities'), l.city_id);
    const src = byId(t('sources'), l.source_id);
    if (citySlug && city?.slug !== citySlug) return false;
    if (sourceSlug && src?.slug !== sourceSlug) return false;
    if (maxPrice != null && l.price > maxPrice) return false;
    if (minRooms != null && (l.rooms == null || l.rooms < minRooms)) return false;
    if (maxRooms != null && (l.rooms == null || l.rooms > maxRooms)) return false;
    if (targetRunId && !seenIn.has(l.id)) return false;
    return true;
  });

  rows = rows.map(l => ({ ...joinListing(l), is_new: isNewIn.has(l.id) }));

  if (!joinsRuns && !runId) {
    // "all" mode — newest first
    rows.sort((a, b) => b.first_seen_at - a.first_seen_at);
    return rows;
  }

  // Interleave sources (ROW_NUMBER OVER PARTITION BY source_id ORDER BY first_seen_at DESC)
  const bySource = new Map();
  for (const r of rows) {
    (bySource.get(r.source_id) || bySource.set(r.source_id, []).get(r.source_id)).push(r);
  }
  for (const list of bySource.values()) {
    list.sort((a, b) => (b.first_seen_at - a.first_seen_at) || ((b.posted_at || 0) - (a.posted_at || 0)));
  }
  const queues = [...bySource.values()];
  const out = [];
  let added = true;
  while (added) {
    added = false;
    for (const q of queues) {
      if (q.length) { out.push(q.shift()); added = true; }
    }
  }
  return out;
}

const handlers = [
  // ---------- users / sessions / passkeys ----------
  {
    match: (s) => s.startsWith('INSERT INTO users'),
    run: (p) => {
      let u = t('users').find(x => x.email === p[0]);
      if (u) { u.name = p[1]; if (p[2]) u.password_hash = p[2]; }
      else {
        u = { id: randomUUID(), email: p[0], name: p[1], password_hash: p[2] || null, created_at: new Date() };
        t('users').push(u);
      }
      return [{ id: u.id, email: u.email, name: u.name, has_password: !!u.password_hash }];
    }
  },
  {
    match: (s) => s.includes('FROM users WHERE email ='),
    run: (p) => {
      const u = t('users').find(x => x.email === p[0]);
      return u ? [{ id: u.id, email: u.email, name: u.name, password_hash: u.password_hash, has_password: !!u.password_hash }] : [];
    }
  },
  {
    match: (s) => s.includes('FROM users WHERE id ='),
    run: (p) => {
      const u = byId(t('users'), p[0]);
      return u ? [{ id: u.id, email: u.email, name: u.name, has_password: !!u.password_hash }] : [];
    }
  },
  {
    match: (s) => s.startsWith('INSERT INTO sessions'),
    run: (p) => {
      t('sessions').push({ id: p[0], user_id: p[1], created_at: new Date(), expires_at: p[2], last_seen_at: new Date() });
      return [];
    }
  },
  {
    match: (s) => s.includes('FROM sessions s JOIN users u'),
    run: (p) => {
      const s = byId(t('sessions'), p[0]);
      if (!s) return [];
      const u = byId(t('users'), s.user_id);
      return [{ sid: s.id, user_id: s.user_id, expires_at: s.expires_at, email: u?.email, name: u?.name }];
    }
  },
  {
    match: (s) => s.startsWith('DELETE FROM sessions'),
    run: (p) => {
      const i = t('sessions').findIndex(x => x.id === p[0]);
      if (i >= 0) t('sessions').splice(i, 1);
      return [];
    }
  },
  {
    match: (s) => s.startsWith('UPDATE sessions SET last_seen_at'),
    run: (p) => {
      const s = byId(t('sessions'), p[0]);
      if (s) s.last_seen_at = new Date();
      return [];
    }
  },
  {
    match: (s) => s.startsWith('INSERT INTO passkeys'),
    run: (p) => {
      t('passkeys').push({
        id: randomUUID(), user_id: p[0], credential_id: p[1], public_key: p[2],
        counter: p[3] || 0, transports: p[4] || [], device_type: p[5] || null, created_at: new Date()
      });
      return [];
    }
  },
  {
    match: (s) => s.includes('FROM passkeys WHERE credential_id'),
    run: (p) => t('passkeys').filter(x => x.credential_id === p[0]).map(clone)
  },
  {
    match: (s) => s.includes('FROM passkeys WHERE user_id'),
    run: (p) => t('passkeys').filter(x => x.user_id === p[0]).sort((a, b) => b.created_at - a.created_at).map(clone)
  },
  {
    match: (s) => s.startsWith('UPDATE passkeys SET counter'),
    run: (p) => {
      const k = t('passkeys').find(x => x.credential_id === p[0]);
      if (k) k.counter = p[1];
      return [];
    }
  },

  // ---------- feed ----------
  {
    match: (s) => s.startsWith('SELECT COUNT(*) as cnt FROM'),
    run: (p, s) => [{ cnt: String(feedRows(s, p).length) }]
  },
  {
    match: (s) => s.includes('ROW_NUMBER() OVER'),
    run: (p, s) => {
      const rows = feedRows(s, p);
      const limit = arg(s, p, /LIMIT \$(\d+)/);
      const offset = arg(s, p, /OFFSET \$(\d+)/);
      return rows.slice(offset || 0, (offset || 0) + (limit || rows.length));
    }
  },
  {
    match: (s) => s === 'SELECT id, name, name_pl, slug, lat, lng FROM cities ORDER BY id',
    run: () => t('cities').map(clone)
  },
  {
    match: (s) => s === 'SELECT id, name, slug, color, base_url FROM sources ORDER BY id',
    run: () => t('sources').map(clone)
  },
  {
    match: (s) => s.includes('FROM cron_runs cr LEFT JOIN sources') && s.includes("cr.triggered_by IN ('cron','manual')"),
    run: (p) => t('cron_runs')
      .filter(r => ['cron', 'manual'].includes(r.triggered_by))
      .sort((a, b) => b.started_at - a.started_at)
      .slice(0, p[0] || 12)
      .map(r => ({ ...r, source_name: null, source_slug: null, city_name: null, city_slug: null }))
  },
  {
    match: (s) => s.includes('FROM listings l JOIN sources s') && s.includes('WHERE l.id = $1'),
    run: (p) => {
      const l = byId(t('listings'), p[0]);
      return l ? [joinListing(l)] : [];
    }
  },

  // ---------- saved ----------
  {
    match: (s) => s.includes('FROM saved_listings sl JOIN listings l'),
    run: (p) => t('saved_listings')
      .filter(sl => sl.user_id === p[0])
      .sort((a, b) => b.created_at - a.created_at)
      .map(sl => {
        const l = byId(t('listings'), sl.listing_id);
        return l ? { ...joinListing(l), saved_at: sl.created_at } : null;
      })
      .filter(Boolean)
  },
  {
    match: (s) => s.startsWith('INSERT INTO saved_listings'),
    run: (p) => {
      if (!t('saved_listings').find(x => x.user_id === p[0] && x.listing_id === p[1])) {
        t('saved_listings').push({ user_id: p[0], listing_id: p[1], created_at: new Date() });
      }
      return [];
    }
  },
  {
    match: (s) => s.startsWith('DELETE FROM saved_listings'),
    run: (p) => {
      const i = t('saved_listings').findIndex(x => x.user_id === p[0] && x.listing_id === p[1]);
      if (i >= 0) t('saved_listings').splice(i, 1);
      return [];
    }
  },
  {
    match: (s) => s.includes('FROM saved_listings WHERE user_id'),
    run: (p) => t('saved_listings')
      .filter(x => x.user_id === p[0] && (p[1] || []).includes(x.listing_id))
      .map(x => ({ listing_id: x.listing_id }))
  },

  // ---------- listing images / conveniences ----------
  {
    match: (s) => s.includes('FROM listing_images WHERE listing_id = ANY'),
    run: (p) => t('listing_images')
      .filter(i => (p[0] || []).includes(i.listing_id))
      .sort((a, b) => (a.listing_id === b.listing_id ? a.position - b.position : a.listing_id < b.listing_id ? -1 : 1))
      .map(i => ({ listing_id: i.listing_id, url: i.url }))
  },
  {
    match: (s) => s.includes('FROM listing_conveniences WHERE listing_id = ANY'),
    run: (p) => t('listing_conveniences')
      .filter(c => (p[0] || []).includes(c.listing_id))
      .map(c => ({ listing_id: c.listing_id, type: c.type, label: c.label }))
  },
  {
    match: (s) => s.startsWith('SELECT url FROM listing_images') && s.includes('LIMIT 1'),
    run: (p) => {
      const img = t('listing_images').filter(i => i.listing_id === p[0]).sort((a, b) => a.position - b.position)[0];
      return img ? [{ url: img.url }] : [];
    }
  },
  {
    match: (s) => s.startsWith('SELECT url FROM listing_images'),
    run: (p) => t('listing_images')
      .filter(i => i.listing_id === p[0])
      .sort((a, b) => a.position - b.position)
      .map(i => ({ url: i.url }))
  },
  {
    match: (s) => s.startsWith('INSERT INTO listing_images'),
    run: (p, s) => {
      // Task A2: production `persistListing` now uses a single batched
      // INSERT ... SELECT FROM unnest($2, $3) for whole-listing image
      // rows. Support both forms so fakedb stays compatible.
      if (s.includes('FROM unnest')) {
        const [listingId, urls, positions] = p;
        if (Array.isArray(urls)) {
          for (let i = 0; i < urls.length; i++) {
            t('listing_images').push({
              id: randomUUID(),
              listing_id: listingId,
              url: urls[i],
              position: positions[i]
            });
          }
        }
        return [];
      }
      // Per-row form (legacy): p = [listingId, url, position]
      t('listing_images').push({ id: randomUUID(), listing_id: p[0], url: p[1], position: p[2] });
      return [];
    }
  },
  {
    match: (s) => s.startsWith('INSERT INTO listing_conveniences'),
    run: (p, s) => {
      // Task A2: same batched-INSERT pattern as listing_images.
      if (s.includes('FROM unnest')) {
        const [listingId, types, labels] = p;
        if (Array.isArray(types)) {
          for (let i = 0; i < types.length; i++) {
            t('listing_conveniences').push({
              id: randomUUID(),
              listing_id: listingId,
              type: types[i],
              label: labels[i]
            });
          }
        }
        return [];
      }
      // Per-row form (legacy): p = [listingId, type, label]
      t('listing_conveniences').push({ id: randomUUID(), listing_id: p[0], type: p[1], label: p[2] });
      return [];
    }
  },

  // ---------- regions ----------
  {
    match: (s) => s === 'SELECT id, city_id, name, color, polygon FROM regions',
    run: () => t('regions').map(r => ({ id: r.id, city_id: r.city_id, name: r.name, color: r.color, polygon: r.polygon }))
  },
  {
    match: (s) => s.includes('FROM regions r JOIN cities c'),
    run: (p, s) => {
      const citySlug = arg(s, p, /c\.slug = \$(\d+)/);
      return t('regions')
        .filter(r => r.user_id === p[0])
        .filter(r => !citySlug || byId(t('cities'), r.city_id)?.slug === citySlug)
        .sort((a, b) => b.created_at - a.created_at)
        .map(r => ({ ...clone(r), city_slug: byId(t('cities'), r.city_id)?.slug, city_name: byId(t('cities'), r.city_id)?.name }));
    }
  },
  {
    match: (s) => s.startsWith('INSERT INTO regions'),
    run: (p) => {
      const r = {
        id: randomUUID(), user_id: p[0], city_id: p[1], name: p[2], color: p[3],
        polygon: typeof p[4] === 'string' ? JSON.parse(p[4]) : p[4],
        created_at: new Date()
      };
      t('regions').push(r);
      return [clone(r)];
    }
  },
  {
    match: (s) => s.includes('FROM regions WHERE id ='),
    run: (p) => t('regions').filter(r => r.id === p[0] && r.user_id === p[1]).map(clone)
  },
  {
    match: (s) => s.startsWith('UPDATE regions SET name'),
    run: (p) => {
      const r = byId(t('regions'), p[0]);
      if (!r) return [];
      r.name = p[1]; r.color = p[2];
      r.polygon = typeof p[3] === 'string' ? JSON.parse(p[3]) : p[3];
      return [clone(r)];
    }
  },
  {
    match: (s) => s.startsWith('DELETE FROM regions'),
    run: (p) => {
      const i = t('regions').findIndex(r => r.id === p[0] && r.user_id === p[1]);
      if (i >= 0) t('regions').splice(i, 1);
      return [];
    }
  },
  {
    match: (s) => s.includes('FROM regions WHERE user_id = ANY'),
    run: (p) => t('regions').filter(r => (p[0] || []).includes(r.user_id)).map(clone)
  },

  // ---------- share tokens ----------
  {
    match: (s) => s.includes('FROM share_tokens WHERE listing_id') && s.includes('AND user_id'),
    run: (p) => t('share_tokens').filter(x => x.listing_id === p[0] && x.user_id === p[1]).map(clone)
  },
  {
    match: (s) => s.includes('FROM share_tokens WHERE listing_id') && s.includes('LIMIT 1'),
    run: (p) => t('share_tokens').filter(x => x.listing_id === p[0]).slice(0, 1).map(clone)
  },
  {
    match: (s) => s.includes('FROM share_tokens WHERE token ='),
    run: (p) => t('share_tokens').filter(x => x.token === p[0]).map(clone)
  },
  {
    match: (s) => s.startsWith('INSERT INTO share_tokens'),
    run: (p) => {
      if (!t('share_tokens').find(x => x.token === p[0])) {
        t('share_tokens').push({ token: p[0], listing_id: p[1], user_id: p[2] || null, created_at: new Date() });
      }
      return [];
    }
  },

  // ---------- cron jobs ----------
  {
    match: (s) => s.includes('ARRAY(SELECT row_to_json(c)'),
    run: (p) => t('cron_jobs')
      .filter(j => j.user_id === p[0])
      .sort((a, b) => b.created_at - a.created_at)
      .map(j => {
        // Task G — attach last_run for THIS job (cron_runs.cron_job_id).
        // Fakedb seed sets cron_job_id on the newest run so the Crons UI
        // has something to show; falls back to null when no run exists.
        const lastRun = t('cron_runs')
          .filter(r => r.cron_job_id === j.id)
          .sort((a, b) => b.started_at - a.started_at)[0] || null;
        return {
          ...clone(j),
          cities: t('cities').filter(c => (j.city_ids || []).includes(c.id)).map(clone),
          sources: t('sources').filter(x => (j.source_ids || []).includes(x.id)).map(clone),
          last_run: lastRun ? {
            id: lastRun.id,
            started_at: lastRun.started_at,
            finished_at: lastRun.finished_at,
            status: lastRun.status,
            new_count: lastRun.new_count,
            total_count: lastRun.total_count,
            duration_ms: lastRun.duration_ms,
            error: lastRun.error,
            triggered_by: lastRun.triggered_by
          } : null
        };
      })
  },
  {
    match: (s) => s.includes('FROM cron_jobs WHERE id =') && s.includes('AND user_id'),
    run: (p) => t('cron_jobs').filter(j => j.id === p[0] && j.user_id === p[1]).map(clone)
  },
  {
    match: (s) => s.startsWith('INSERT INTO cron_jobs'),
    run: (p) => {
      const j = {
        id: randomUUID(), user_id: p[0], name: p[1], schedule: p[2],
        source_ids: p[3] || [], city_ids: p[4] || [],
        filters: typeof p[5] === 'string' ? JSON.parse(p[5]) : (p[5] || {}),
        enabled: !!p[6], last_run_at: null, next_run_at: null, created_at: new Date()
      };
      t('cron_jobs').push(j);
      return [clone(j)];
    }
  },
  {
    match: (s) => s.startsWith('UPDATE cron_jobs SET name='),
    run: (p) => {
      const j = byId(t('cron_jobs'), p[0]);
      if (!j) return [];
      j.name = p[1]; j.schedule = p[2]; j.source_ids = p[3]; j.city_ids = p[4];
      j.filters = typeof p[5] === 'string' ? JSON.parse(p[5]) : p[5];
      j.enabled = !!p[6];
      return [clone(j)];
    }
  },
  {
    match: (s) => s.startsWith('DELETE FROM cron_jobs'),
    run: (p) => {
      const i = t('cron_jobs').findIndex(j => j.id === p[0] && j.user_id === p[1]);
      if (i >= 0) t('cron_jobs').splice(i, 1);
      return [];
    }
  },
  {
    match: (s) => s === 'SELECT schedule FROM cron_jobs WHERE id = $1',
    run: (p) => {
      const j = byId(t('cron_jobs'), p[0]);
      return j ? [{ schedule: j.schedule }] : [];
    }
  },
  {
    match: (s) => s.startsWith('UPDATE cron_jobs SET next_run_at = NULL'),
    run: (p) => {
      const j = byId(t('cron_jobs'), p[0]);
      if (j) j.next_run_at = null;
      return [];
    }
  },
  {
    match: (s) => s.startsWith('UPDATE cron_jobs SET next_run_at = $2'),
    run: (p) => {
      const j = byId(t('cron_jobs'), p[0]);
      if (j) j.next_run_at = p[1];
      return [];
    }
  },
  {
    match: (s) => s === 'SELECT * FROM cron_jobs WHERE enabled = TRUE',
    run: () => t('cron_jobs').filter(j => j.enabled).map(clone)
  },

  // ---------- cron runs ----------
  {
    match: (s) => s.includes('FROM cron_runs cr LEFT JOIN sources') && s.includes('WHERE cr.id ='),
    run: (p) => {
      const r = byId(t('cron_runs'), p[0]);
      return r ? [{ ...clone(r), source_name: null, source_slug: null, city_name: null, city_slug: null }] : [];
    }
  },
  {
    match: (s) => s.includes('FROM cron_runs cr LEFT JOIN sources'),
    run: (p) => t('cron_runs')
      .sort((a, b) => b.started_at - a.started_at)
      .slice(0, p[0] || 20)
      .map(r => ({ ...clone(r), source_name: null, source_slug: null, city_name: null, city_slug: null }))
  },
  {
    match: (s) => s.includes('FROM cron_run_listings crl JOIN listings l ON l.id = crl.listing_id JOIN sources s'),
    run: (p) => t('cron_run_listings')
      .filter(c => c.cron_run_id === p[0])
      .sort((a, b) => (b.was_new - a.was_new))
      .slice(0, 100)
      .map(c => {
        const l = byId(t('listings'), c.listing_id);
        const s = byId(t('sources'), l?.source_id);
        return { id: l?.id, title: l?.title, price: l?.price, first_seen_at: l?.first_seen_at, was_new: c.was_new, source_name: s?.name, source_slug: s?.slug, source_color: s?.color };
      })
  },
  {
    match: (s) => s.startsWith('INSERT INTO cron_runs'),
    run: (p) => {
      const r = {
        id: randomUUID(), started_at: p[0], finished_at: null, status: 'running',
        source_id: p[3] ?? null, city_id: p[4] ?? null,
        cron_job_id: p[5] ?? null,
        new_count: 0, total_count: 0, duration_ms: null,
        error: null, triggered_by: p[1],
        filters: typeof p[2] === 'string' ? JSON.parse(p[2]) : (p[2] || {})
      };
      t('cron_runs').push(r);
      return [clone(r)];
    }
  },
  {
    match: (s) => s.startsWith('UPDATE cron_runs SET'),
    run: (p, s) => {
      const id = arg(s, p, /WHERE id = \$(\d+)/);
      const r = byId(t('cron_runs'), id);
      if (r) Object.assign(r, { status: p[0], finished_at: p[1], new_count: p[2], total_count: p[3], duration_ms: p[4], error: p[5] });
      return r ? [clone(r)] : [];
    }
  },

  // ---------- cities lookups ----------
  {
    match: (s) => s.includes('FROM cities WHERE slug ='),
    run: (p) => t('cities').filter(c => c.slug === p[0]).map(clone)
  },
  {
    match: (s) => s.includes('FROM cities WHERE id = ANY'),
    run: (p) => t('cities').filter(c => (p[0] || []).includes(c.id)).map(clone)
  },
  {
    match: (s) => s === 'SELECT id FROM cities',
    run: () => t('cities').map(c => ({ id: c.id }))
  },
  {
    match: (s) => s.includes('FROM sources WHERE id = ANY'),
    run: (p) => t('sources').filter(x => (p[0] || []).includes(x.id)).map(clone)
  },

  // ---------- listings misc ----------
  {
    match: (s) => s === 'SELECT id FROM listings WHERE id = $1',
    run: (p) => {
      const l = byId(t('listings'), p[0]);
      return l ? [{ id: l.id }] : [];
    }
  },
  // Task F: lightweight lookup for the POI-route (only need lat/lng).
  {
    match: (s) => s.includes('SELECT id, lat, lng FROM listings WHERE id = $1'),
    run: (p) => {
      const l = byId(t('listings'), p[0]);
      return l ? [{ id: l.id, lat: l.lat, lng: l.lng }] : [];
    }
  },
  {
    match: (s) => s.includes('SELECT id, price, description, rooms, area, raw FROM listings'),
    run: (p) => {
      const l = byId(t('listings'), p[0]);
      return l ? [{ id: l.id, price: l.price, description: l.description, rooms: l.rooms, area: l.area, raw: l.raw }] : [];
    }
  },
  {
    match: (s) => s.startsWith('UPDATE listings SET total_estimate'),
    run: (p) => {
      const l = byId(t('listings'), p[2]);
      if (l) {
        l.total_estimate = p[0];
        l.total_breakdown = typeof p[1] === 'string' ? JSON.parse(p[1]) : p[1];
      }
      return [];
    }
  },
  {
    match: (s) => s.startsWith('INSERT INTO listings'),
    run: (p) => {
      const l = {
        id: p[0], source_id: p[1], external_id: p[2], city_id: p[3], url: p[4],
        title: p[5], description: p[6], price: p[7], currency: 'PLN',
        rooms: p[8], area: p[9], floor: p[10], district: p[11], street: null, address: p[12],
        lat: null, lng: null, posted_at: null,
        first_seen_at: new Date(), last_seen_at: new Date(), is_active: true,
        raw: typeof p[13] === 'string' ? JSON.parse(p[13]) : p[13],
        description_en: null, params_en: null, total_estimate: null, total_breakdown: null
      };
      t('listings').push(l);
      return [];
    }
  },
  {
    match: (s) => s.includes('SELECT DISTINCT city_id FROM listings'),
    run: () => [...new Set(t('listings').filter(l => l.is_active).map(l => l.city_id))].map(id => ({ city_id: id }))
  },

  // ---------- duplicates ----------
  {
    match: (s) => s.includes('FROM listing_duplicates d JOIN listings la'),
    run: (p) => {
      const active = new Set(t('listings').filter(l => l.is_active).map(l => l.id));
      return t('listing_duplicates')
        .filter(d => active.has(d.id_a) && active.has(d.id_b))
        .filter(d => byId(t('listings'), d.id_a)?.city_id === p[0])
        .map(d => ({ id_a: d.id_a, id_b: d.id_b, score: d.score, reasons: d.reasons }));
    }
  },
  {
    match: (s) => s.includes('AS image FROM listings l JOIN sources s'),
    run: (p) => t('listings')
      .filter(l => (p[0] || []).includes(l.id))
      .map(l => {
        const s = byId(t('sources'), l.source_id);
        const img = t('listing_images').filter(i => i.listing_id === l.id).sort((a, b) => a.position - b.position)[0];
        return {
          id: l.id, title: l.title, price: l.price, rooms: l.rooms, area: l.area,
          district: l.district, url: l.url,
          source_name: s?.name, source_color: s?.color, source_slug: s?.slug,
          image: img?.url || null
        };
      })
  },
  {
    match: (s) => s.startsWith('SELECT DISTINCT listing_id FROM listing_images'),
    run: (p) => {
      const urls = new Set(p[0] || []);
      const ids = new Set();
      for (const i of t('listing_images')) {
        if (urls.has(i.url) && i.listing_id !== p[1]) ids.add(i.listing_id);
      }
      return [...ids].map(listing_id => ({ listing_id }));
    }
  },
  {
    match: (s) => s.includes('COALESCE(array_agg(li.url)'),
    run: (p, s) => {
      let rows = t('listings').filter(l => l.is_active);
      if (s.includes('l.id = ANY')) rows = rows.filter(l => (p[0] || []).includes(l.id));
      else if (s.includes('LIMIT 500')) {
        rows = rows
          .filter(l => l.city_id === p[0])
          .sort((a, b) => b.first_seen_at - a.first_seen_at)
          .slice(0, 500);
      } else if (s.includes('l.city_id = $1')) {
        rows = rows.filter(l => l.city_id === p[0] && l.id !== p[1] && l.source_id !== p[2]
          && (p[3] == null ? l.rooms == null : l.rooms === p[3])
          && l.price >= p[4] && l.price <= p[5]);
      }
      return rows.map(l => ({
        id: l.id, source_id: l.source_id, city_id: l.city_id, title: l.title, price: l.price,
        rooms: l.rooms, area: l.area, lat: l.lat, lng: l.lng, street: l.street, address: l.address,
        images: t('listing_images').filter(i => i.listing_id === l.id).sort((a, b) => a.position - b.position).map(i => i.url)
      }));
    }
  },
  {
    match: (s) => s.startsWith('INSERT INTO listing_duplicates'),
    run: (p) => {
      const existing = t('listing_duplicates').find(d => d.id_a === p[0] && d.id_b === p[1]);
      if (existing) { existing.score = p[2]; existing.reasons = typeof p[3] === 'string' ? JSON.parse(p[3]) : p[3]; }
      else {
        t('listing_duplicates').push({
          id_a: p[0], id_b: p[1], score: p[2],
          reasons: typeof p[3] === 'string' ? JSON.parse(p[3]) : p[3],
          created_at: new Date()
        });
      }
      return [];
    }
  },

  // ---------- telegram / app settings ----------
  {
    match: (s) => s.includes("FROM app_settings WHERE key = 'telegram_bot_token'"),
    run: () => {
      const row = t('app_settings').find(x => x.key === 'telegram_bot_token');
      return row ? [{ value: row.value }] : [];
    }
  },
  {
    match: (s) => s.startsWith('INSERT INTO app_settings'),
    run: (p) => {
      const row = t('app_settings').find(x => x.key === 'telegram_bot_token');
      if (row) { row.value = p[0]; row.updated_at = new Date(); }
      else t('app_settings').push({ key: 'telegram_bot_token', value: p[0], updated_at: new Date() });
      return [];
    }
  },
  {
    match: (s) => s.includes('FROM telegram_settings WHERE user_id'),
    run: (p) => t('telegram_settings').filter(x => x.user_id === p[0]).map(clone)
  },
  {
    match: (s) => s.startsWith('INSERT INTO telegram_settings'),
    run: (p) => {
      let row = t('telegram_settings').find(x => x.user_id === p[0]);
      if (!row) {
        row = { user_id: p[0], created_at: new Date() };
        t('telegram_settings').push(row);
      }
      Object.assign(row, {
        enabled: !!p[1], chat_id: p[2], min_price: p[3], max_price: p[4],
        region_ids: p[5] || [], updated_at: new Date()
      });
      return [clone(row)];
    }
  },
  {
    match: (s) => s.includes('FROM telegram_settings ts JOIN users u'),
    run: () => t('telegram_settings')
      .filter(x => x.enabled && x.chat_id != null)
      .map(x => ({ ...clone(x), user_name: byId(t('users'), x.user_id)?.name }))
  },
  {
    match: (s) => s.includes('SELECT 1 AS x FROM telegram_sent'),
    run: (p) => t('telegram_sent').filter(x => x.user_id === p[0] && x.listing_id === p[1]).map(() => ({ x: 1 }))
  },
  {
    match: (s) => s.startsWith('INSERT INTO telegram_sent'),
    run: (p) => {
      if (!t('telegram_sent').find(x => x.user_id === p[0] && x.listing_id === p[1])) {
        t('telegram_sent').push({ user_id: p[0], listing_id: p[1], sent_at: new Date() });
      }
      return [];
    }
  },

  // ---------- POIs (Task F) — starred_pois CRUD only. Cache reads/writes
  //             never fire in FAKE_DB mode because services/pois.js#getPOIs
  //             short-circuits to sample data when FAKE_DB=1. The handlers
  //             below keep the starring flow exercised end-to-end. ----------
  {
    match: (s) => s.includes('FROM starred_pois') && s.includes('user_id IS NOT DISTINCT FROM'),
    run: (p) => t('starred_pois').filter(r => (r.user_id ?? null) === (p[0] ?? null)).map(clone)
  },
  {
    match: (s) => s.startsWith('INSERT INTO starred_pois') && s.includes('ON CONFLICT (user_id, place_id)'),
    run: (p) => {
      const [userId, placeId, name, type, lat, lng, address] = p;
      let row = t('starred_pois').find(r =>
        r.user_id === (userId ?? null) && r.place_id === placeId && placeId != null
      );
      if (!row) {
        row = {
          id: randomUUID(), user_id: userId ?? null, place_id: placeId ?? null,
          name, type, lat, lng, address: address ?? null, created_at: new Date()
        };
        t('starred_pois').push(row);
      } else {
        Object.assign(row, { name, type, lat, lng, address: address ?? null });
      }
      return [];
    }
  },
  {
    match: (s) => s.startsWith('INSERT INTO starred_pois') && s.includes('ON CONFLICT (user_id, name, lat, lng)'),
    run: (p) => {
      // SQL: VALUES ($1, NULL, $2, $3, $4, $5, $6) — only 6 placeholders
      // (NULL is a SQL literal, not a param). So p[0]=userId, p[1]=name,
      // p[2]=type, p[3]=lat, p[4]=lng, p[5]=address.
      const [userId, name, type, lat, lng, address] = p;
      let row = t('starred_pois').find(r =>
        (r.user_id ?? null) === (userId ?? null) && r.name === name &&
        r.lat === lat && r.lng === lng && r.place_id == null
      );
      if (!row) {
        row = {
          id: randomUUID(), user_id: userId ?? null, place_id: null,
          name, type, lat, lng, address: address ?? null, created_at: new Date()
        };
        t('starred_pois').push(row);
      } else {
        Object.assign(row, { type, address: address ?? null });
      }
      return [];
    }
  },
  {
    match: (s) => s.startsWith('DELETE FROM starred_pois WHERE id ='),
    run: (p) => {
      const i = t('starred_pois').findIndex(r =>
        r.id === p[0] && (r.user_id ?? null) === (p[1] ?? null)
      );
      if (i >= 0) t('starred_pois').splice(i, 1);
      return [];
    }
  },
  {
    match: (s) => s.startsWith('DELETE FROM starred_pois WHERE place_id ='),
    run: (p) => {
      const i = t('starred_pois').findIndex(r =>
        r.place_id === p[0] && (r.user_id ?? null) === (p[1] ?? null)
      );
      if (i >= 0) t('starred_pois').splice(i, 1);
      return [];
    }
  },
  {
    match: (s) => s.startsWith('DELETE FROM starred_pois') && s.includes('AND place_id IS NULL'),
    run: (p) => {
      const [name, lat, lng, userId] = p;
      const i = t('starred_pois').findIndex(r =>
        r.name === name && r.lat === lat && r.lng === lng &&
        r.place_id == null && (r.user_id ?? null) === (userId ?? null)
      );
      if (i >= 0) t('starred_pois').splice(i, 1);
      return [];
    }
  },
  // Defensive: poi_cache queries should never fire in FAKE_DB mode (getPOIs
  // short-circuits), but if a future caller calls getCachedType directly
  // we return a cache-miss so the next layer can react.
  {
    match: (s) => s.includes('FROM poi_cache WHERE lat ='),
    run: () => []
  },
  {
    match: (s) => s.startsWith('INSERT INTO poi_cache'),
    run: () => []
  },

  // ---------- runner (used by getSinceTime / prev-run lookups) ----------
  {
    match: (s) => s.startsWith('SELECT started_at FROM cron_runs'),
    run: () => {
      const r = latestRealRun();
      return r ? [{ started_at: r.started_at }] : [];
    }
  },
  {
    match: (s) => s.includes('SELECT id FROM cron_runs') && s.includes('OFFSET 1'),
    run: () => {
      const runs = t('cron_runs')
        .filter(r => ['success', 'partial'].includes(r.status) && ['cron', 'manual'].includes(r.triggered_by))
        .sort((a, b) => b.started_at - a.started_at);
      return runs[1] ? [{ id: runs[1].id }] : [];
    }
  },
  {
    match: (s) => s.includes('SELECT crl.listing_id FROM cron_run_listings crl'),
    run: (p) => t('cron_run_listings')
      .filter(c => c.cron_run_id === p[0] && byId(t('listings'), c.listing_id)?.source_id === p[1])
      .map(c => ({ listing_id: c.listing_id }))
  },
  {
    match: (s) => s.includes('FROM cron_run_listings crl JOIN listings l JOIN sources s JOIN cities c'),
    run: (p) => t('cron_run_listings')
      .filter(c => c.cron_run_id === p[0] && c.was_new)
      .map(c => {
        const l = byId(t('listings'), c.listing_id);
        if (!l) return null;
        const s = byId(t('sources'), l.source_id);
        const city = byId(t('cities'), l.city_id);
        const img = t('listing_images').filter(i => i.listing_id === l.id).sort((a, b) => a.position - b.position)[0];
        return {
          id: l.id, title: l.title, price: l.price, rooms: l.rooms, area: l.area, floor: l.floor,
          district: l.district, city_id: l.city_id, lat: l.lat, lng: l.lng, url: l.url,
          total_estimate: l.total_estimate,
          source_name: s?.name, city_name: city?.name, image_url: img?.url || null
        };
      })
      .filter(Boolean)
  }
];

export async function query(text, params = []) {
  const sql = norm(text);
  for (const h of handlers) {
    if (h.match(sql)) {
      const rows = h.run(params || [], sql);
      return { rows, rowCount: rows.length };
    }
  }
  console.error('[fakedb] UNHANDLED QUERY:', sql);
  throw new Error('fakedb: unhandled query: ' + sql.slice(0, 140));
}

export async function one(text, params) {
  const r = await query(text, params);
  return r.rows[0];
}

export async function many(text, params) {
  const r = await query(text, params);
  return r.rows;
}

export const pool = {
  query,
  on: () => {},
  end: async () => {}
};

// ------------------------------------------------------------------
// Simulated fetch cycle for FAKE_DB mode (no real scraping/playwright).
// Creates a few brand-new listings, re-sees existing ones, records a run.
// ------------------------------------------------------------------
const SIM_TITLES = [
  'Fresh listing: sunny 2 rooms near the metro',
  'Just in: renovated flat with balcony',
  'New on the market: cozy studio, city centre',
  'Just listed: 3 rooms with park view',
  'Brand new: bright flat in quiet street'
];

export async function simulateFetchCycle({ triggeredBy = 'manual', jobId = null } = {}) {
  const startedAt = new Date();
  const startMs = Date.now();
  const run = (await one(
    `INSERT INTO cron_runs (started_at, status, source_id, city_id, triggered_by, filters, cron_job_id)
     VALUES ($1, 'running', $4, $5, $2, $3::jsonb, $6)
     RETURNING *`,
    [startedAt, triggeredBy, JSON.stringify({}), null, null, jobId]
  ));

  const warsaw = t('cities').find(c => c.slug === 'warsaw');
  const newIds = [];
  const nNew = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < nNew; i++) {
    const source = t('sources')[Math.floor(Math.random() * 2)];
    const price = 2500 + Math.floor(Math.random() * 40) * 100;
    const area = 28 + Math.floor(Math.random() * 40);
    const rooms = area < 35 ? 1 : area < 55 ? 2 : 3;
    const id = randomUUID();
    t('listings').push({
      id,
      source_id: source.id,
      external_id: `sim-${Date.now()}-${i}`,
      city_id: warsaw.id,
      title: SIM_TITLES[i % SIM_TITLES.length],
      description: 'Symulowane ogłoszenie dodane przez tryb FAKE_DB — demo nowego pobrania.',
      description_en: null,
      params_en: null,
      price,
      currency: 'PLN',
      rooms,
      area,
      floor: `${1 + Math.floor(Math.random() * 5)}`,
      district: 'Śródmieście',
      street: 'Marszałkowska',
      address: `Marszałkowska ${10 + i}, Warszawa`,
      lat: 52.226 + Math.random() * 0.01,
      lng: 21.008 + Math.random() * 0.015,
      url: `${source.base_url}/oferta/sim-${Date.now()}-${i}`,
      posted_at: new Date(),
      first_seen_at: new Date(),
      last_seen_at: new Date(),
      is_active: true,
      raw: { params: [] },
      total_estimate: null,
      total_breakdown: null
    });
    for (let k = 0; k < 3; k++) {
      t('listing_images').push({
        id: randomUUID(), listing_id: id,
        url: `https://picsum.photos/seed/sim${Date.now()}${i}${k}/900/675`,
        position: k
      });
    }
    t('cron_run_listings').push({ cron_run_id: run.id, listing_id: id, was_new: true, seen_at: new Date() });
    newIds.push(id);
  }

  // re-see a sample of existing active listings
  const existing = t('listings').filter(l => l.is_active).slice(0, 25);
  for (const l of existing) {
    l.last_seen_at = new Date();
    t('cron_run_listings').push({ cron_run_id: run.id, listing_id: l.id, was_new: false, seen_at: new Date() });
  }

  const finished = new Date();
  Object.assign(run, {
    status: 'success',
    finished_at: finished,
    new_count: newIds.length,
    total_count: newIds.length + existing.length,
    duration_ms: Date.now() - startMs
  });
  const stored = byId(t('cron_runs'), run.id);
  Object.assign(stored, run);

  // latest-run feed should now show the fresh batch
  return clone(stored);
}

// Run the real dedupe pipeline against the sample data at boot, so the
// seeded same-flat group is detected by compareListings itself (not
// pre-inserted), exercising the full detection path.
export async function runStartupScan() {
  const { dedupeCrossRun } = await import('../services/dedupe.js');
  const n = await dedupeCrossRun();
  console.log(`[fakedb] dedupe scan: ${n} pair(s)`);
}

export const __store = store;
