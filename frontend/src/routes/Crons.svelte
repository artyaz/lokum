<script>
  // Task G — Crons editor route.
  //
  // Distinct from /settings: that page is a quick toggle (enabled on/off
  // + create new). This page is the *schedule* editor — inline name +
  // cron expression + maxPrice, with a Save button that PATCHes through
  // /api/cron-jobs/:id, an immediate "Run now" button (POSTs
  // /:id/run-now — runs synchronously, no cron tick required), an
  // expandable "Next 5 runs" panel computed server-side via cron-parser,
  // and a "Last run" line read from cron_runs via the new
  // cron_runs.cron_job_id FK.

  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { navigate } from '../lib/router';
  import Icon from '../lib/icons/Icon.svelte';

  let jobs = [];           // server shape: includes last_run + next_runs
  let cities = [];
  let sources = [];
  let loading = true;
  let error = '';

  // Per-job transient UI state keyed by job.id
  let drafts = {};         // { [jobId]: { name, schedule, maxPrice } }
  let saving = {};         // { [jobId]: bool }
  let running = {};         // { [jobId]: bool }
  let expanded = {};       // { [jobId]: bool } (next 5 runs panel)
  let flash = {};          // { [jobId]: 'saved' | 'error' | 'ran' }

  const cronPresets = [
    { label: 'Daily 06:00 & 18:00', value: '0 6,18 * * *' },
    { label: 'Daily 06:00',         value: '0 6 * * *' },
    { label: 'Every 6 hours',       value: '0 */6 * * *' },
    { label: 'Every 4 hours',       value: '0 */4 * * *' },
    { label: 'Every hour',           value: '0 * * * *' },
    { label: 'Weekdays 08:00',       value: '0 8 * * 1-5' }
  ];

  async function load() {
    loading = true;
    error = '';
    try {
      const [jR, cR, sR] = await Promise.all([
        api.cronJobs(), api.cities(), api.sources()
      ]);
      jobs = jR.jobs;
      cities = cR.cities;
      sources = sR.sources;
      // Seed the per-job draft state from the loaded rows so the inputs
      // have something to bind to before any edit.
      drafts = {};
      for (const j of jobs) {
        drafts[j.id] = {
          name: j.name || '',
          schedule: j.schedule || '',
          maxPrice: j.filters?.maxPrice ?? ''
        };
      }
    } catch (e) {
      error = e.message || 'Failed to load cron jobs';
    } finally {
      loading = false;
    }
  }

  onMount(load);

  // ----- helpers -----------------------------------------------------------

  function isDirty(job) {
    const d = drafts[job.id];
    if (!d) return false;
    if (String(d.name) !== String(job.name || '')) return true;
    if (String(d.schedule).trim() !== String(job.schedule || '').trim()) return true;
    const currMax = job.filters?.maxPrice ?? '';
    if (String(d.maxPrice) !== String(currMax)) return true;
    return false;
  }

  function flashFor(jobId, kind) {
    flash[jobId] = kind;
    setTimeout(() => {
      if (flash[jobId] === kind) flash[jobId] = null;
    }, 2400);
  }

  function fmtRunDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const now = new Date();
    const diff = (now - d) / 1000;
    let day;
    if (diff < 86400 && now.getDate() === d.getDate()) day = 'Today';
    else if (diff < 2 * 86400) day = 'Yesterday';
    else day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return `${day} ${hh}:${mm}`;
  }

  function fmtFuture(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const weekday = d.toLocaleDateString('en-GB', { weekday: 'short' });
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    const day = d.getDate();
    const mon = d.toLocaleDateString('en-GB', { month: 'short' });
    return `${weekday} ${day} ${mon} · ${hh}:${mm}`;
  }

  function timeAgo(iso) {
    if (!iso) return 'never';
    const d = new Date(iso);
    const diff = (Date.now() - d) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 2 * 86400) return 'yesterday';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function statusColor(s) {
    if (s === 'success') return '#2C7A54';
    if (s === 'failed')  return '#A4133C';
    if (s === 'partial') return '#D6A419';
    if (s === 'skipped') return '#9A9488';
    return '#9A9488';
  }

  function statusLabel(s) {
    return (s || 'none').replace(/\b\w/g, c => c.toUpperCase());
  }

  function sourceNames(job) {
    const ids = job.source_ids || [];
    if (!ids.length) return 'all sources';
    return ids.map(id => sources.find(s => s.id === id)?.name).filter(Boolean).join(', ') || '—';
  }
  function cityNames(job) {
    const ids = job.city_ids || [];
    if (!ids.length) return 'all cities';
    return ids.map(id => cities.find(c => c.id === id)?.name).filter(Boolean).join(', ') || '—';
  }

  // ----- actions -----------------------------------------------------------

  async function saveJob(job) {
    const d = drafts[job.id];
    if (!d) return;
    saving[job.id] = true;
    error = '';
    try {
      const body = {
        name: d.name,
        schedule: String(d.schedule).trim(),
        filters: { ...(job.filters || {}),
          ...(d.maxPrice === '' || d.maxPrice == null
              ? { maxPrice: null }
              : { maxPrice: Number(d.maxPrice) }) }
      };
      const r = await api.updateCronJob(job.id, body);
      // Replace this job in the list with the patched row (which carries
      // the new next_runs). Keep draft state in lockstep with the row.
      const idx = jobs.findIndex(j => j.id === job.id);
      if (idx >= 0) jobs[idx] = r.job;
      drafts[job.id] = {
        name: r.job.name || '',
        schedule: r.job.schedule || '',
        maxPrice: r.job.filters?.maxPrice ?? ''
      };
      flashFor(job.id, 'saved');
    } catch (e) {
      const msg = e instanceof ApiError ? (e.payload?.detail || e.message) : (e.message || 'save failed');
      flashFor(job.id, 'error');
      error = msg;
    } finally {
      saving[job.id] = false;
    }
  }

  async function toggleEnabled(job) {
    saving[job.id] = true;
    try {
      const r = await api.updateCronJob(job.id, { enabled: !job.enabled });
      const idx = jobs.findIndex(j => j.id === job.id);
      if (idx >= 0) jobs[idx] = r.job;
      flashFor(job.id, 'saved');
    } catch (e) {
      flashFor(job.id, 'error');
      error = e.message || 'toggle failed';
    } finally {
      saving[job.id] = false;
    }
  }

  async function runNow(job) {
    if (!confirm(`Run "${job.name}" now? This fires a real fetch cycle (1-5 min).`)) return;
    running[job.id] = true;
    error = '';
    try {
      const r = await api.runJobNow(job.id);
      // Patch the job row with the freshly-stamped last_run (the runner
      // stamps cron_run.cron_job_id, so the next /api/cron-jobs GET will
      // surface this run as last_run — but we can short-circuit here).
      const idx = jobs.findIndex(j => j.id === job.id);
      if (idx >= 0) {
        const run = r.run;
        jobs[idx] = {
          ...jobs[idx],
          // If skipped (run-concurrency lock), the row carries status='skipped'.
          last_run: run ? {
            id: run.id,
            started_at: run.started_at || new Date().toISOString(),
            finished_at: run.finished_at || null,
            status: run.status,
            new_count: run.new_count,
            total_count: run.total_count,
            duration_ms: run.duration_ms,
            error: run.error,
            triggered_by: run.triggered_by || 'manual'
          } : jobs[idx].last_run
        };
      }
      flashFor(job.id, 'ran');
    } catch (e) {
      flashFor(job.id, 'error');
      error = e.message || 'run failed';
    } finally {
      running[job.id] = false;
    }
  }

  async function deleteJob(job) {
    if (!confirm(`Delete "${job.name}"? This cannot be undone.`)) return;
    try {
      await api.deleteCronJob(job.id);
      jobs = jobs.filter(j => j.id !== job.id);
      delete drafts[job.id];
    } catch (e) {
      error = e.message || 'delete failed';
    }
  }

  function toggleExpand(job) {
    expanded[job.id] = !expanded[job.id];
  }

  function applyPreset(job, value) {
    if (!drafts[job.id]) drafts[job.id] = { name: job.name, schedule: job.schedule, maxPrice: job.filters?.maxPrice ?? '' };
    drafts[job.id] = { ...drafts[job.id], schedule: value };
  }
</script>

<div class="screen">
  <div class="sub-header">
    <button class="back-btn" on:click={() => navigate('/settings')} aria-label="Back">
      <Icon name="back" size={18} color="#201E1B" />
    </button>
    <div class="sub-header-title">Crons</div>
    <div style="width:40px"></div>
  </div>

  <div class="scroll no-scrollbar">
    <div class="intro">
      Edit cron schedules inline. <span class="muted">Save</span> rewrites the job and immediately re-registers the node-cron task in the running process — no restart needed.
    </div>

    {#if loading}
      <div class="state">Loading…</div>
    {:else if error && !jobs.length}
      <div class="state err">{error}</div>
    {:else if !jobs.length}
      <div class="empty">
        <div class="empty-title">No scheduled jobs</div>
        <div class="empty-sub">Create one from the Settings page first.</div>
        <button class="btn btn-secondary" style="margin-top:14px" on:click={() => navigate('/settings')}>Open Settings</button>
      </div>
    {:else}
      {#if error}<div class="state err" style="margin-bottom:12px">{error}</div>{/if}

      <div class="jobs-list">
        {#each jobs as job (job.id)}
          {#if !drafts[job.id]}
            <div>Loading…</div>
          {:else}
          <div class="job-row" class:off={!job.enabled}>
            <div class="job-head">
              <input class="job-name-input"
                     bind:value={drafts[job.id].name}
                     placeholder="Job name"
                     disabled={!job.enabled} />
              <button class="toggle-switch" class:on={job.enabled}
                      on:click={() => toggleEnabled(job)}
                      disabled={saving[job.id]}
                      aria-label={job.enabled ? 'Pause' : 'Enable'}>
                <span class="knob"></span>
              </button>
            </div>

            <div class="job-sched-row">
              <div class="sched-wrap">
                <Icon name="clock" size={14} color="#9A9488" />
                <input class="sched-input"
                       bind:value={drafts[job.id].schedule}
                       placeholder="0 6,18 * * *"
                       spellcheck="false"
                       disabled={!job.enabled} />
              </div>
              <div class="presets no-scrollbar">
                {#each cronPresets as p}
                  <button class="preset-chip"
                          class:chip-active={drafts[job.id].schedule === p.value}
                          on:click={() => applyPreset(job, p.value)}
                          disabled={!job.enabled}>{p.label}</button>
                {/each}
              </div>
            </div>

            <div class="job-grid">
              <div>
                <label class="mini-label">Max price (PLN)</label>
                <input class="mini-input" type="number" min="0"
                       bind:value={drafts[job.id].maxPrice}
                       placeholder="any"
                       disabled={!job.enabled} />
              </div>
              <div>
                <label class="mini-label">Sources</label>
                <div class="mini-value">{sourceNames(job)}</div>
              </div>
              <div>
                <label class="mini-label">Cities</label>
                <div class="mini-value">{cityNames(job)}</div>
              </div>
              <div>
                <label class="mini-label">Last run</label>
                {#if job.last_run}
                  <div class="last-run">
                    <span class="run-dot" style="background:{statusColor(job.last_run.status)}"></span>
                    <span class="lr-when">{fmtRunDate(job.last_run.started_at)}</span>
                    <span class="lr-meta">
                      {job.last_run.new_count} new · {(job.last_run.duration_ms/1000).toFixed(1)}s
                      {#if job.last_run.error} · {job.last_run.error}{/if}
                    </span>
                  </div>
                {:else}
                  <div class="mini-value muted">never</div>
                {/if}
              </div>
            </div>

            <div class="job-actions">
              <button class="btn btn-secondary btn-sm" on:click={() => toggleExpand(job)}>
                <Icon name="clock" size={14} color="#201E1B" />
                Next runs
                <Icon name="chevron-down" size={12} color="#9A9488" />
              </button>
              <button class="btn btn-secondary btn-sm" on:click={() => runNow(job)} disabled={running[job.id] || saving[job.id]}>
                <Icon name="play" size={14} color="#201E1B" />
                {running[job.id] ? 'Running…' : 'Run now'}
              </button>
              <button class="btn btn-danger btn-sm" on:click={() => deleteJob(job)} disabled={saving[job.id]}>
                <Icon name="trash" size={14} color="#C15F3C" />
              </button>
              <button class="btn btn-primary btn-sm save-btn" on:click={() => saveJob(job)} disabled={!isDirty(job) || saving[job.id]}>
                <Icon name="check" size={14} color="#FDF6F1" />
                {saving[job.id] ? 'Saving…' : 'Save'}
              </button>
            </div>

            {#if flash[job.id] === 'saved'}
              <div class="flash ok">Saved · cron re-scheduled.</div>
            {:else if flash[job.id] === 'ran'}
              <div class="flash ok">Run finished — {job.last_run?.new_count ?? 0} new.</div>
            {:else if flash[job.id] === 'error'}
              <div class="flash err">Action failed — see top message.</div>
            {/if}

            {#if expanded[job.id]}
              <div class="next-runs fadein">
                <div class="nr-title">
                  <Icon name="clock" size={13} color="#9A9488" />
                  Next {job.next_runs?.length || 0} fire-times (Europe/Warsaw)
                </div>
                {#if job.next_runs?.length}
                  <ul class="nr-list">
                    {#each job.next_runs as dt}
                      <li>
                        <span class="nr-rel">{timeAgo(new Date(dt).toISOString())}</span>
                        <span class="nr-abs">{fmtFuture(dt)}</span>
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <div class="nr-empty">Invalid schedule — save a valid cron expression to compute future runs.</div>
                {/if}
                <div class="nr-hint">
                  last_run_at: {job.last_run_at ? fmtRunDate(job.last_run_at) : 'never'} ·
                  next_run_at: {job.next_run_at ? fmtRunDate(job.next_run_at) : '—'}
                </div>
              </div>
            {/if}
          </div>
          {/if}
        {/each}
      </div>

      <button class="btn btn-secondary btn-full" style="margin-top:16px" on:click={() => navigate('/settings')}>
        <Icon name="back" size={16} color="#201E1B" />
        Back to Settings
      </button>
    {/if}

    <div style="height:32px"></div>
  </div>
</div>

<style>
  .scroll { padding: 6px 0 28px; }

  .intro {
    font-size: 13.5px;
    color: var(--muted);
    line-height: 1.55;
    margin: 8px 2px 18px;
  }
  .intro .muted { color: var(--ink-2); font-weight: 600; }

  .state, .empty {
    text-align: center;
    padding: 30px 16px;
    color: var(--muted-2);
    font-size: 14px;
  }
  .state.err { color: var(--otodom); }
  .empty-title { font-size: 16px; font-weight: 600; color: var(--ink); }
  .empty-sub   { font-size: 13px; color: var(--muted-2); margin-top: 6px; }

  .jobs-list {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .job-row {
    background: var(--card);
    border: 1px solid var(--line-soft);
    border-radius: 18px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    transition: opacity .15s;
  }
  .job-row.off { opacity: .55; }

  .job-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .job-name-input {
    flex: 1; min-width: 0;
    height: 40px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--bg);
    padding: 0 12px;
    font-size: 15px;
    font-weight: 600;
    color: var(--ink);
  }
  .job-name-input:focus { border-color: var(--accent); }
  .job-name-input:disabled { background: var(--card-soft); color: var(--muted); }

  .toggle-switch {
    width: 42px; height: 25px; border-radius: 13px;
    background: var(--line); position: relative; cursor: pointer;
    border: none; padding: 0; flex: none;
    transition: background .15s;
  }
  .toggle-switch.on { background: var(--accent); }
  .toggle-switch:disabled { opacity: .55; cursor: default; }
  .knob {
    position: absolute; top: 2px; left: 2px;
    width: 21px; height: 21px; border-radius: 50%;
    background: var(--card);
    transition: transform .15s;
  }
  .toggle-switch.on .knob { transform: translateX(17px); }

  .job-sched-row {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .sched-wrap {
    display: flex; align-items: center; gap: 8px;
    height: 42px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--bg);
    padding: 0 12px;
  }
  .sched-input {
    flex: 1; min-width: 0;
    height: 100%;
    border: none;
    background: transparent;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 14px;
    color: var(--accent);
    font-weight: 600;
  }
  .sched-input:focus { outline: none; }
  .sched-input:disabled { color: var(--muted-2); }

  .presets {
    display: flex; gap: 6px;
    overflow-x: auto;
  }
  .preset-chip {
    height: 28px; padding: 0 10px;
    border-radius: 9px;
    background: var(--card-soft);
    border: 1px solid var(--line);
    font-size: 12px; font-weight: 500;
    color: var(--ink-2);
    cursor: pointer;
    white-space: nowrap;
    flex: none;
  }
  .preset-chip.chip-active {
    background: var(--accent);
    color: var(--accent-ink);
    border-color: var(--accent);
  }
  .preset-chip:disabled { opacity: .5; cursor: default; }

  .job-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px 14px;
  }
  @media (min-width: 700px) {
    .job-grid { grid-template-columns: 1fr 1fr 1fr 1.4fr; }
  }
  .mini-label {
    display: block;
    font-size: 11px;
    font-weight: 700;
    color: var(--muted-2);
    text-transform: uppercase;
    letter-spacing: .04em;
    margin-bottom: 4px;
  }
  .mini-input {
    width: 100%; height: 38px;
    border: 1px solid var(--line);
    border-radius: 11px;
    background: var(--bg);
    padding: 0 10px;
    font-size: 14px;
    color: var(--ink);
  }
  .mini-input:focus { border-color: var(--accent); }
  .mini-input:disabled { background: var(--card-soft); color: var(--muted); }
  .mini-value {
    font-size: 13px;
    color: var(--ink-2);
    line-height: 1.45;
    padding-top: 9px;
  }
  .mini-value.muted { color: var(--muted-2); }

  .last-run {
    display: flex; align-items: center; gap: 7px;
    padding-top: 6px;
    font-size: 12.5px;
  }
  .run-dot {
    width: 8px; height: 8px; border-radius: 50%; flex: none;
  }
  .lr-when { color: var(--ink-2); font-weight: 600; }
  .lr-meta { color: var(--muted-2); }

  .job-actions {
    display: flex; gap: 6px;
    flex-wrap: wrap;
  }
  .job-actions .btn { flex: 1 1 110px; }
  .job-actions .save-btn { flex: 1 1 90px; }
  .btn-sm {
    height: 38px;
    font-size: 13px;
    border-radius: 11px;
    padding: 0 10px;
  }

  .flash {
    font-size: 12.5px;
    padding: 8px 11px;
    border-radius: 9px;
    margin-top: 2px;
  }
  .flash.ok { background: var(--green-soft); color: var(--green); }
  .flash.err { background: var(--otodom-soft); color: var(--otodom); }

  .next-runs {
    border-top: 1px dashed var(--line);
    padding-top: 10px;
    margin-top: 2px;
  }
  .nr-title {
    display: flex; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 700;
    color: var(--muted-2);
    text-transform: uppercase;
    letter-spacing: .04em;
    margin-bottom: 6px;
  }
  .nr-list {
    list-style: none;
    padding: 0; margin: 0;
    display: flex; flex-direction: column;
    gap: 3px;
  }
  .nr-list li {
    display: flex; align-items: baseline; gap: 10px;
    font-size: 12.5px;
    color: var(--ink-2);
  }
  .nr-rel {
    min-width: 80px;
    color: var(--accent);
    font-weight: 600;
  }
  .nr-abs { color: var(--ink-2); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .nr-empty {
    font-size: 12.5px; color: var(--otodom);
    padding: 4px 0;
  }
  .nr-hint {
    font-size: 11.5px; color: var(--muted-2);
    margin-top: 8px;
  }
</style>
