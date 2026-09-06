// audit_runs.js — print the last 7 days of cron_runs with per-source counts.
//
// Purpose: spot scrapers that are silently failing (zero listings, zero runs,
// or runs that are stuck in 'running' forever). Designed to be run from cron
// or by hand once a week to surface dead sources before they rot the feed.
//
// Usage:
//   node scripts/audit_runs.js            # last 7 days, all sources
//   node scripts/audit_runs.js 14         # last 14 days
//   DATABASE_URL=… node scripts/audit_runs.js
//
// Output sections:
//   1. Stuck runs  — runs with status='running' older than 10 min
//   2. Daily roll-up — one row per (day, source) with new / total seen counts
//   3. Sources with zero runs in the window — silent failures
//   4. Most recent 30 runs with status, duration, error
//
// No writes — read-only.

import 'dotenv/config';
import { pool, query, one, many } from '../src/db.js';

const DAYS = Math.max(1, Math.min(90, parseInt(process.argv[2] || '7', 10)));
const STUCK_MINUTES = 10;

const SOURCES_SQL = `
  SELECT id, slug, name
  FROM sources
  ORDER BY id
`;

const RUNS_SQL = `
  SELECT id, started_at, finished_at, status, new_count, total_count,
         duration_ms, error, triggered_by,
         filters::text AS filters_json
  FROM cron_runs
  WHERE started_at >= NOW() - ($1::int || ' days')::interval
  ORDER BY started_at ASC
`;

const PER_SOURCE_SQL = `
  SELECT
    date_trunc('day', cr.started_at) AS day,
    s.slug                          AS source_slug,
    s.name                          AS source_name,
    COUNT(*)                        FILTER (WHERE crl.listing_id IS NOT NULL)        AS listings_seen,
    COUNT(*)                       FILTER (WHERE crl.was_new)                       AS listings_new,
    COUNT(DISTINCT cr.id)           FILTER (WHERE cr.status IN ('success','partial')) AS successful_runs,
    COUNT(DISTINCT cr.id)           FILTER (WHERE cr.status = 'failed')              AS failed_runs,
    COUNT(DISTINCT cr.id)           FILTER (WHERE cr.status = 'running')             AS stuck_runs
  FROM cron_runs cr
  LEFT JOIN cron_run_listings crl ON crl.cron_run_id = cr.id
  LEFT JOIN listings l            ON l.id = crl.listing_id
  LEFT JOIN sources s             ON s.id = l.source_id
  WHERE cr.started_at >= NOW() - ($1::int || ' days')::interval
  GROUP BY day, s.slug, s.name
  ORDER BY day DESC, s.slug
`;

const STUCK_SQL = `
  SELECT id, started_at, EXTRACT(EPOCH FROM (NOW() - started_at))::int AS age_seconds
  FROM cron_runs
  WHERE status = 'running'
    AND started_at < NOW() - ($1::int || ' minutes')::interval
  ORDER BY started_at ASC
`;

function pad(s, n) {
  return String(s).padEnd(n, ' ');
}

function fmt(n) {
  if (n == null) return '—';
  return String(n);
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000);
  console.log(`\n=== Lokum cron_runs audit — last ${DAYS} day(s) (since ${since.toISOString().slice(0,10)}) ===\n`);

  // 1. Stuck runs (status='running' for too long → process crash or hung scraper)
  const stuck = await query(STUCK_SQL, [STUCK_MINUTES]);
  if (stuck.rows.length) {
    console.log(`⚠  STUCK RUNS (status='running' > ${STUCK_MINUTES} min) — likely crashed backend or hung scraper:`);
    for (const r of stuck.rows) {
      console.log(`   ${r.id}  started ${r.started_at.toISOString()}  age ${r.age_seconds}s`);
    }
    console.log();
  } else {
    console.log(`✓ No stuck runs (status='running' > ${STUCK_MINUTES} min).\n`);
  }

  // 2. Daily roll-up by source
  const perSource = await query(PER_SOURCE_SQL, [DAYS]);
  const sources = await query(SOURCES_SQL);

  // Index expected source slugs to detect sources we have NEVER seen
  const seenSlugs = new Set(perSource.rows.filter(r => r.source_slug).map(r => r.source_slug));

  // Group by day
  const byDay = new Map();
  for (const r of perSource.rows) {
    const dayKey = r.day ? r.day.toISOString().slice(0, 10) : 'unknown';
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey).push(r);
  }

  const days = [...byDay.keys()].sort().reverse();
  console.log('Daily roll-up by source (most recent day first):\n');
  console.log(pad('date', 12) + pad('source', 12) + pad('seen', 8) + pad('new', 8) + pad('ok', 6) + pad('fail', 6) + pad('stuck', 6));
  console.log('-'.repeat(58));
  for (const day of days) {
    const rows = byDay.get(day);
    // Sort: ensure stable source order; null source (runs with no listings) last
    rows.sort((a, b) => (a.source_slug || 'zzz').localeCompare(b.source_slug || 'zzz'));
    let first = true;
    for (const r of rows) {
      const slug = r.source_slug || '(no listings)';
      console.log(
        pad(first ? day : '', 12) +
        pad(slug, 12) +
        pad(fmt(r.listings_seen), 8) +
        pad(fmt(r.listings_new), 8) +
        pad(fmt(r.successful_runs), 6) +
        pad(fmt(r.failed_runs), 6) +
        pad(fmt(r.stuck_runs), 6)
      );
      first = false;
    }
    console.log('-'.repeat(58));
  }
  console.log();

  // 3. Sources with zero activity in the window (silent failures)
  const silentFailures = sources.rows.filter(s => !seenSlugs.has(s.slug));
  if (silentFailures.length) {
    console.log('⚠  SOURCES WITH ZERO LISTINGS in the window (silent failures):');
    for (const s of silentFailures) {
      console.log(`   ${s.id}  ${s.slug}  (${s.name})`);
    }
    console.log('   → check: scraper registered in runner.js? job enabled & scheduled? scraper erroring?');
    console.log();
  } else {
    console.log('✓ All registered sources produced at least one listing in the window.\n');
  }

  // 4. Most recent 30 runs (raw view) with perSource detail if available
  const recent = await query(`
    SELECT id, started_at, finished_at, status, new_count, total_count,
           duration_ms, error, triggered_by,
           filters::text AS filters_json
    FROM cron_runs
    WHERE started_at >= NOW() - ($1::int || ' days')::interval
    ORDER BY started_at DESC
    LIMIT 30
  `, [DAYS]);

  console.log('Most recent 30 runs in window:\n');
  console.log(pad('started_at', 21) + pad('status', 9) + pad('trig', 7) + pad('new', 7) + pad('total', 7) + pad('ms', 8) + 'per-source / error');
  console.log('-'.repeat(110));
  for (const r of recent.rows) {
    let details = '';
    try {
      const f = JSON.parse(r.filters_json || '{}');
      if (f && f.perSource) {
        const parts = [];
        for (const [slug, stats] of Object.entries(f.perSource)) {
          parts.push(`${slug}:${stats.new}/${stats.total}${stats.error ? '!' : ''}`);
        }
        details += parts.join(' ');
      }
    } catch {}
    if (r.error) details += ` ERR: ${r.error}`;
    console.log(
      pad(r.started_at.toISOString().replace('T', ' ').slice(0, 19), 21) +
      pad(r.status, 9) +
      pad(r.triggered_by, 7) +
      pad(fmt(r.new_count), 7) +
      pad(fmt(r.total_count), 7) +
      pad(fmt(r.duration_ms), 8) +
      details
    );
  }
  console.log();

  // 5. Summary
  const summary = await one(`
    SELECT
      COUNT(*)                                                     AS total_runs,
      COUNT(*) FILTER (WHERE status = 'success')                  AS success,
      COUNT(*) FILTER (WHERE status = 'partial')                  AS partial,
      COUNT(*) FILTER (WHERE status = 'failed')                   AS failed,
      COUNT(*) FILTER (WHERE status = 'running')                  AS running,
      COALESCE(SUM(new_count), 0)                                  AS sum_new,
      COALESCE(SUM(total_count), 0)                                AS sum_total,
      COALESCE(AVG(duration_ms), 0)::int                           AS avg_duration_ms,
      COALESCE(MAX(duration_ms), 0)                                AS max_duration_ms
    FROM cron_runs
    WHERE started_at >= NOW() - ($1::int || ' days')::interval
  `, [DAYS]);

  console.log('Window summary:');
  console.log(`  total_runs:  ${summary.total_runs}`);
  console.log(`  success:     ${summary.success}`);
  console.log(`  partial:     ${summary.partial}  (some sources errored)`);
  console.log(`  failed:      ${summary.failed}   (no listings returned)`);
  console.log(`  running:     ${summary.running}  (in-progress or stuck)`);
  console.log(`  sum_new:     ${summary.sum_new}  listings marked was_new=TRUE`);
  console.log(`  sum_total:   ${summary.sum_total}  listings seen (incl. duplicates across runs)`);
  console.log(`  avg/max dur: ${summary.avg_duration_ms} ms / ${summary.max_duration_ms} ms`);
  console.log();

  await pool.end();
}

main().catch(e => {
  console.error('[audit_runs] FAILED:', e);
  process.exit(1);
});
