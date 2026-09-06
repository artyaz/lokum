<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import { user } from '../lib/store';
  import { navigate } from '../lib/router';
  import Icon from '../lib/icons/Icon.svelte';

  let runs = [];
  let jobs = [];
  let cities = [];
  let sources = [];
  let loading = true;
  let showCreate = false;
  let running = false;
  let runResult = null;
  let error = '';

  // new job form
  let newJob = {
    name: '',
    schedule: '0 6,18 * * *',
    source_ids: [1, 2],
    city_ids: [1, 2],
    maxPrice: 6000
  };

  // telegram state
  let tg = { enabled: false, chat_id: '', min_price: null, max_price: null, region_ids: [] };
  let tgBotToken = '';          // only entered when (re)setting
  let tgBotTokenSet = false;
  let tgSaving = false;
  let tgTesting = false;
  let tgMsg = '';
  let tgMsgOk = false;
  let tgChats = null;           // detected chats list
  let tgDetecting = false;
  let userRegions = [];

  // Facebook cookie vault
  let fbSession = null;
  let fbCookies = '';
  let fbLabel = '';
  let fbSaving = false;
  let fbDeleting = false;
  let fbMsg = '';
  let fbMsgOk = false;

  let cronPresets = [
    { label: 'Daily 06:00 & 18:00', value: '0 6,18 * * *' },
    { label: 'Daily 06:00', value: '0 6 * * *' },
    { label: 'Every 6 hours', value: '0 */6 * * *' },
    { label: 'Every hour', value: '0 * * * *' },
    { label: 'Weekdays 08:00', value: '0 8 * * 1-5' }
  ];

  async function load() {
    loading = true;
    try {
      const [rR, jR, cR, sR, tgR, regR, fbR] = await Promise.all([
        api.cronRuns(15), api.cronJobs(), api.cities(), api.sources(),
        api.telegram().catch(() => null),
        api.regions().catch(() => ({ regions: [] })),
        api.facebookSession().catch(() => null)
      ]);
      runs = rR.runs;
      jobs = jR.jobs;
      cities = cR.cities;
      sources = sR.sources;
      if (tgR) {
        tg = {
          enabled: !!tgR.settings?.enabled,
          chat_id: tgR.settings?.chat_id || '',
          min_price: tgR.settings?.min_price ?? null,
          max_price: tgR.settings?.max_price ?? null,
          region_ids: tgR.settings?.region_ids || []
        };
        tgBotTokenSet = !!tgR.bot_token_set;
      }
      userRegions = regR.regions || [];
      fbSession = fbR?.session || { configured: false, canManage: true };
    } finally { loading = false; }
  }

  onMount(load);

  function timeAgo(iso) {
    const d = new Date(iso);
    const now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff/60) + 'm ago';
    if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
    if (diff < 2 * 86400) return 'yesterday';
    return Math.floor(diff/86400) + 'd ago';
  }

  function fmtRunDate(iso) {
    const d = new Date(iso);
    const now = new Date();
    const diff = (now - d) / 1000;
    let prefix;
    if (diff < 86400 && now.getDate() === d.getDate()) prefix = 'Today';
    else if (diff < 2 * 86400) prefix = 'Yesterday';
    else prefix = d.toLocaleDateString('en-GB', { weekday: 'short' });
    return `${prefix} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
  }

  function dotColor(r) {
    if (r.status === 'success') return '#2C7A54';
    if (r.status === 'failed') return '#A4133C';
    return '#D6A419';
  }

  async function logout() {
    await api.logout();
    user.set(null);
    navigate('/login');
  }

  function toggleSource(id) {
    if (newJob.source_ids.includes(id))
      newJob.source_ids = newJob.source_ids.filter(x => x !== id);
    else newJob.source_ids = [...newJob.source_ids, id];
  }
  function toggleCity(id) {
    if (newJob.city_ids.includes(id))
      newJob.city_ids = newJob.city_ids.filter(x => x !== id);
    else newJob.city_ids = [...newJob.city_ids, id];
  }

  async function createJob() {
    error = '';
    if (!newJob.name || !newJob.schedule) { error = 'Name and schedule required.'; return; }
    try {
      await api.createCronJob({
        name: newJob.name,
        schedule: newJob.schedule,
        source_ids: newJob.source_ids,
        city_ids: newJob.city_ids,
        filters: { maxPrice: newJob.maxPrice },
        enabled: true
      });
      showCreate = false;
      newJob = { name: '', schedule: '0 6,18 * * *', source_ids: [1, 2], city_ids: [1, 2], maxPrice: 6000 };
      await load();
    } catch (e) { error = e.message; }
  }

  async function toggleJob(job) {
    await api.updateCronJob(job.id, { enabled: !job.enabled });
    await load();
  }

  async function deleteJob(job) {
    if (!confirm(`Delete "${job.name}"?`)) return;
    await api.deleteCronJob(job.id);
    await load();
  }

  async function testRun() {
    running = true;
    error = '';
    runResult = null;
    try {
      const r = await api.testRun({
        source_ids: newJob.source_ids,
        city_ids: newJob.city_ids,
        filters: { maxPrice: newJob.maxPrice }
      });
      runResult = r.run;
      await load();
    } catch (e) {
      error = e.message || 'Test run failed';
    } finally {
      running = false;
    }
  }

  async function runNow() {
    running = true;
    error = '';
    try {
      await api.runNow({});
      await load();
    } catch (e) { error = e.message; }
    finally { running = false; }
  }

  // ============ TELEGRAM ============
  function toggleTgRegion(id) {
    if (tg.region_ids.includes(id))
      tg.region_ids = tg.region_ids.filter(x => x !== id);
    else tg.region_ids = [...tg.region_ids, id];
  }

  async function saveTg(showMsg = true) {
    tgSaving = true;
    tgMsg = '';
    try {
      const body = {
        enabled: tg.enabled,
        chat_id: tg.chat_id || null,
        min_price: tg.min_price === '' || tg.min_price == null ? null : parseInt(tg.min_price),
        max_price: tg.max_price === '' || tg.max_price == null ? null : parseInt(tg.max_price),
        region_ids: tg.region_ids
      };
      if (tgBotToken.trim()) body.bot_token = tgBotToken.trim();
      const r = await api.saveTelegram(body);
      tgBotTokenSet = !!r.bot_token_set;
      tgBotToken = '';
      if (showMsg) { tgMsg = 'Saved.'; tgMsgOk = true; }
      return true;
    } catch (e) {
      tgMsg = e.message || 'Save failed';
      tgMsgOk = false;
      return false;
    } finally {
      tgSaving = false;
    }
  }

  async function detectChats() {
    tgDetecting = true;
    tgMsg = '';
    tgChats = null;
    try {
      if (!tgBotTokenSet && tgBotToken.trim()) {
        const ok = await saveTg(false);
        if (!ok) return;
      }
      const r = await api.telegramChats();
      tgChats = r.chats || [];
      if (!tgChats.length) tgMsg = 'No messages found. Send /start to your bot in Telegram first, then tap Detect again.';
    } catch (e) {
      tgMsg = e.message || 'Detection failed';
      tgMsgOk = false;
    } finally {
      tgDetecting = false;
    }
  }

  function pickChat(c) {
    tg.chat_id = String(c.chat_id);
    tgChats = null;
  }

  async function testTg() {
    tgTesting = true;
    tgMsg = '';
    try {
      await saveTg(false);
      const r = await api.telegramTest();
      tgMsg = r.ok ? 'Test notification sent — check Telegram!' : (r.detail || 'Failed to send');
      tgMsgOk = !!r.ok;
    } catch (e) {
      tgMsg = e.message || 'Test failed';
      tgMsgOk = false;
    } finally {
      tgTesting = false;
    }
  }

  async function readFacebookCookieFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    fbCookies = await file.text();
    if (!fbLabel) fbLabel = file.name.slice(0, 60);
  }

  async function saveFacebookSession() {
    fbSaving = true;
    fbMsg = '';
    try {
      const r = await api.saveFacebookSession({ cookies: fbCookies, label: fbLabel || undefined });
      fbSession = { ...fbSession, ...r.session, configured: true, lastStatus: 'stored' };
      fbCookies = '';
      fbMsg = 'Facebook cookies saved and encrypted.';
      fbMsgOk = true;
    } catch (e) {
      fbMsg = e.detail || e.message || 'Could not save cookies';
      fbMsgOk = false;
    } finally {
      fbSaving = false;
    }
  }

  async function deleteFacebookSession() {
    if (!confirm('Remove the active Facebook cookie session?')) return;
    fbDeleting = true;
    fbMsg = '';
    try {
      await api.deleteFacebookSession();
      fbSession = { configured: false, canManage: true };
      fbMsg = 'Facebook cookies removed.';
      fbMsgOk = true;
    } catch (e) {
      fbMsg = e.message || 'Could not remove cookies';
      fbMsgOk = false;
    } finally {
      fbDeleting = false;
    }
  }
</script>

<div class="screen">
  <div class="sub-header">
    <button class="back-btn" on:click={() => navigate('/feed')}>
      <Icon name="back" size={18} color="#201E1B" />
    </button>
    <div class="sub-header-title">Settings</div>
    <div style="width:40px"></div>
  </div>

  <div class="scroll no-scrollbar">
    <!-- account -->
    <div class="account-card">
      <div class="avatar">{$user?.name?.[0] || 'A'}</div>
      <div class="account-info">
        <div class="account-name">{$user?.name || 'Anna Kowalska'}</div>
        <div class="account-email">{$user?.email || 'anna@lokum.pl'}</div>
      </div>
      <span class="passkey-pill">
        <Icon name="passkey" size={12} color="#2C7A54" stroke={1.7} />
        Passkey
      </span>
    </div>

    <!-- FACEBOOK COOKIE VAULT -->
    <div class="section-label" style="margin:0 2px 11px">
      <span>Facebook scraping</span>
      {#if fbSession?.configured}
        <span class="ok-pill">{fbSession.lastStatus || 'active'}</span>
      {:else}
        <span class="cookie-missing">not connected</span>
      {/if}
    </div>
    <div class="tg-card">
      <div class="tg-intro">
        Export Facebook cookies from a browser already logged into Facebook
        (the file must contain <code>c_user</code> and <code>xs</code>). The
        scraper hooks this session automatically. We never collect your
        Facebook password, and cookies are encrypted at rest.
      </div>

      {#if fbSession?.configured}
        <div class="fb-status">
          <div><b>{fbSession.label || 'Facebook session'}</b></div>
          <div>
            {fbSession.expiresAt ? `Expires ${new Date(fbSession.expiresAt).toLocaleDateString()}` : 'Session cookie (no stored expiry)'}
          </div>
          {#if fbSession.lastError}
            <div class="fb-error">{fbSession.lastError}</div>
          {/if}
        </div>
      {/if}

      {#if fbSession?.canManage}
        <label class="label" for="fb-cookie-file">Cookies file or pasted header</label>
        <input id="fb-cookie-file" class="input" type="file" accept=".txt,.json,text/plain,application/json" on:change={readFacebookCookieFile} />
        <textarea class="input fb-textarea" rows="5" bind:value={fbCookies}
          placeholder="Paste cookies.txt / JSON export, or c_user=…; xs=…" spellcheck="false"></textarea>
        <input class="input" style="margin-top:8px" bind:value={fbLabel} placeholder="Label (optional)" />

        <div class="tg-actions">
          <button class="btn" on:click={saveFacebookSession} disabled={fbSaving || !fbCookies.trim()}>
            {fbSaving ? 'Saving…' : 'Save & hook automatically'}
          </button>
          {#if fbSession?.configured}
            <button class="btn btn-danger" on:click={deleteFacebookSession} disabled={fbDeleting}>
              {fbDeleting ? 'Removing…' : 'Remove'}
            </button>
          {/if}
        </div>
      {:else}
        <div class="field-hint">Only the session owner or an admin can replace the active Facebook cookies.</div>
      {/if}

      {#if fbMsg}
        <div class="tg-msg" class:tg-ok={fbMsgOk} class:tg-err={!fbMsgOk}>{fbMsg}</div>
      {/if}
    </div>

    <!-- TELEGRAM NOTIFICATIONS -->
    <div class="section-label" style="margin:0 2px 11px">
      <span>Telegram notifications</span>
      <button class="toggle-switch" class:on={tg.enabled} on:click={() => tg.enabled = !tg.enabled} aria-label="Toggle telegram">
        <span class="knob"></span>
      </button>
    </div>
    <div class="tg-card">
      <div class="tg-intro">
        Get a Telegram message (with photo) for every new listing in your drawn regions and price range.
      </div>

      <label class="label">Bot token {#if tgBotTokenSet}<span class="ok-pill">set</span>{/if}</label>
      <input class="input" type="password" bind:value={tgBotToken}
        placeholder={tgBotTokenSet ? '•••••••••• (leave empty to keep current)' : '123456789:AAE…from @BotFather'} />
      <div class="field-hint">Create a bot with @BotFather in Telegram, paste the token here.</div>

      <label class="label" style="margin-top:14px">Your chat ID</label>
      <div class="chatid-row">
        <input class="input" bind:value={tg.chat_id} placeholder="e.g. 123456789" />
        <button class="btn btn-secondary detect-btn" on:click={detectChats} disabled={tgDetecting}>
          {tgDetecting ? '…' : 'Detect'}
        </button>
      </div>
      <div class="field-hint">Message your bot first (/start), then tap Detect — or use @userinfobot.</div>

      {#if tgChats && tgChats.length}
        <div class="chats-list fadein">
          {#each tgChats as c}
            <button class="chat-row" on:click={() => pickChat(c)}>
              <div class="chat-name">{c.title || c.username || 'Chat'}</div>
              <div class="chat-id">{c.chat_id}</div>
              <Icon name="chevron-right" size={16} color="#9A9488" />
            </button>
          {/each}
        </div>
      {/if}

      <div class="row-between" style="margin-top:16px">
        <span class="label" style="margin:0">Price range (PLN)</span>
      </div>
      <div class="price-grid">
        <input class="input" type="number" min="0" bind:value={tg.min_price} placeholder="Min (any)" />
        <input class="input" type="number" min="0" bind:value={tg.max_price} placeholder="Max (any)" />
      </div>

      <label class="label" style="margin-top:16px">Regions ({tg.region_ids.length ? `${tg.region_ids.length} selected` : 'all — no region filter'})</label>
      {#if userRegions.length}
        <div class="toggle-row">
          {#each userRegions as r}
            <button class="chip region-opt" class:chip-active={tg.region_ids.includes(r.id)} on:click={() => toggleTgRegion(r.id)}>
              <span class="opt-color" style="background:{r.color}"></span>
              {r.name}
            </button>
          {/each}
        </div>
        <div class="field-hint">Only notify for listings inside selected regions. Select none = notify for the whole city.</div>
      {:else}
        <div class="field-hint">
          No drawn regions yet — <span class="link" on:click={() => navigate('/regions')}>draw them on the map</span>.
          With no regions selected, all listings in range trigger notifications.
        </div>
      {/if}

      {#if tgMsg}
        <div class="tg-msg" class:tg-ok={tgMsgOk} class:tg-err={!tgMsgOk}>{tgMsg}</div>
      {/if}

      <div class="tg-actions">
        <button class="btn btn-secondary" on:click={testTg} disabled={tgTesting || tgSaving}>
          <Icon name="send" size={15} />
          {tgTesting ? 'Sending…' : 'Send test'}
        </button>
        <button class="btn btn-primary" on:click={() => saveTg(true)} disabled={tgSaving}>
          {tgSaving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>

    <!-- IMPORT -->
    <button class="btn btn-secondary btn-full" style="margin-bottom:22px" on:click={() => navigate('/import')}>
      <Icon name="upload" size={16} color="#201E1B" />
      Import a listing manually
    </button>

    <!-- DAILY SYNC -->
    <div class="section-label" style="margin:0 2px 11px">Daily sync</div>
    <div class="sync-card">
      {#if runs[0]}
        <div class="sync-row" style="border-bottom:1px solid #F1ECE2">
          <div class="sync-icon {runs[0].status}">
            <span class="dot"></span>
          </div>
          <div class="sync-info">
            <div class="sync-title">
              {runs[0].status === 'success' ? 'Fetch ran successfully' :
               runs[0].status === 'failed' ? 'Fetch failed' : 'Fetch partial'}
            </div>
            <div class="sync-sub">{fmtRunDate(runs[0].started_at)} · {runs[0].new_count} new listings</div>
          </div>
          <span class="sync-time">{(runs[0].duration_ms/1000).toFixed(1)}s</span>
        </div>
      {/if}
      {#each sources as s}
        <div class="sync-row">
          <span class="source-tag" style="color:{s.color};background:{s.color}1A">{s.name}</span>
          <div class="sync-info">
            <div class="sync-title">{s.name} · selected cities</div>
          </div>
          <span class="sync-count">
            {runs.filter(r => r.status === 'success').reduce((acc, r) => acc + (r.source_id === s.id || !r.source_id ? r.new_count : 0), 0)} total
          </span>
        </div>
      {/each}
    </div>

    <!-- RUN NOW -->
    <button class="btn btn-secondary btn-full" style="margin-bottom:22px" on:click={runNow} disabled={running}>
      <Icon name="play" size={16} color="#201E1B" />
      {running ? 'Running fetch…' : 'Run fetch now'}
    </button>

    <!-- CRON JOBS -->
    <div class="section-label" style="margin:0 2px 11px">
      <span>Scheduled jobs</span>
      <div class="jobs-head-actions">
        <!-- Task G — dedicated schedule-editor route. Quick toggles +
            create still live here; /crons is the full inline editor. -->
        <button class="add-btn" on:click={() => navigate('/crons')}>
          <Icon name="edit" size={15} color="#C15F3C" stroke={2} />
          Edit schedules
        </button>
        <button class="add-btn" on:click={() => showCreate = !showCreate}>
          <Icon name="plus" size={16} color="#C15F3C" stroke={2} />
          New
        </button>
      </div>
    </div>

    {#if showCreate}
      <div class="create-card fadein">
        <label class="label">Name</label>
        <input class="input" bind:value={newJob.name} placeholder="Morning Warsaw fetch" />

        <label class="label" style="margin-top:14px">Schedule</label>
        <input class="input" bind:value={newJob.schedule} placeholder="0 6 * * *" />
        <div class="presets">
          {#each cronPresets as p}
            <button class="preset-chip" on:click={() => newJob.schedule = p.value}>{p.label}</button>
          {/each}
        </div>

        <label class="label" style="margin-top:14px">Sources</label>
        <div class="toggle-row">
          {#each sources as s}
            <button class="chip" class:chip-active={newJob.source_ids.includes(s.id)} on:click={() => toggleSource(s.id)}>
              {s.name}
            </button>
          {/each}
        </div>

        <label class="label" style="margin-top:14px">Cities</label>
        <div class="toggle-row">
          {#each cities as c}
            <button class="chip" class:chip-active={newJob.city_ids.includes(c.id)} on:click={() => toggleCity(c.id)}>
              {c.name}
            </button>
          {/each}
        </div>

        <label class="label" style="margin-top:14px">Max price (PLN)</label>
        <input type="number" class="input" bind:value={newJob.maxPrice} min="0" />

        {#if error}<div class="error">{error}</div>{/if}

        <div class="create-actions">
          <button class="btn btn-secondary" on:click={testRun} disabled={running}>
            <Icon name="play" size={16} />
            {running ? 'Running…' : 'Test run'}
          </button>
          <button class="btn btn-primary" on:click={createJob}>Create</button>
        </div>

        {#if runResult}
          <div class="run-result">
            <div class="rr-title">Test run complete</div>
            <div class="rr-stats">
              <span class="rr-stat"><b>{runResult.new_count}</b> new</span>
              <span class="rr-stat"><b>{runResult.total_count}</b> seen</span>
              <span class="rr-stat"><b>{(runResult.duration_ms/1000).toFixed(1)}s</b></span>
            </div>
            <div class="rr-status status-{runResult.status}">{runResult.status}</div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- list of jobs -->
    {#if jobs.length}
      <div class="jobs-list">
        {#each jobs as job}
          <div class="job-row">
            <div class="job-info">
              <div class="job-name">{job.name}</div>
              <div class="job-sched">{job.schedule}</div>
              <div class="job-meta">
                {(job.source_ids || []).map(id => sources.find(s => s.id === id)?.name).filter(Boolean).join(', ') || 'all sources'} ·
                {(job.city_ids || []).map(id => cities.find(c => c.id === id)?.name).filter(Boolean).join(', ') || 'all cities'}
              </div>
            </div>
            <div class="job-actions">
              <button class="toggle-switch" class:on={job.enabled} on:click={() => toggleJob(job)}>
                <span class="knob"></span>
              </button>
              <button class="icon-btn" on:click={() => deleteJob(job)} style="width:32px;height:32px;border-radius:9px">
                <Icon name="trash" size={15} color="#A4133C" />
              </button>
            </div>
          </div>
        {/each}
      </div>
    {:else if !showCreate}
      <div class="empty-jobs">No scheduled jobs yet. Click "New" to create one.</div>
    {/if}

    <!-- recent runs -->
    <div class="section-label" style="margin:22px 2px 11px">Recent runs</div>
    <div class="runs-card">
      {#each runs as r}
        <div class="run-row">
          <span class="run-dot" style="background:{dotColor(r)}"></span>
          <div class="run-when">{fmtRunDate(r.started_at)}</div>
          <div class="run-detail">
            {r.new_count} new · {(r.duration_ms/1000).toFixed(1)}s
            {#if r.error} · {r.error}{/if}
          </div>
        </div>
      {/each}
    </div>

    <button class="btn btn-danger btn-full" style="margin-top:22px" on:click={logout}>
      <Icon name="logout" size={16} color="#C15F3C" />
      Log out
    </button>
    <div class="version">Lokum · v1.1.0</div>
  </div>
</div>

<style>
  .scroll { padding: 6px 0 28px; }

  .account-card {
    display: flex;
    align-items: center;
    gap: 14px;
    background: var(--card);
    border: 1px solid var(--line-soft);
    border-radius: 18px;
    padding: 15px;
    margin-bottom: 22px;
  }
  .avatar {
    width: 52px; height: 52px;
    border-radius: 50%;
    background: var(--card-soft);
    display: flex; align-items: center; justify-content: center;
    font-family: var(--serif); font-size: 22px;
    color: var(--accent); flex: none;
  }
  .account-info { flex: 1; min-width: 0; }
  .account-name { font-size: 16px; font-weight: 600; color: var(--ink); }
  .account-email { font-size: 13.5px; color: var(--muted); }
  .passkey-pill {
    display: inline-flex; align-items: center; gap: 5px;
    height: 26px; padding: 0 10px; border-radius: 8px;
    background: var(--green-soft); color: var(--green);
    font-size: 12px; font-weight: 600;
  }

  /* telegram */
  .tg-card {
    background: var(--card);
    border: 1px solid var(--line-soft);
    border-radius: 18px;
    padding: 16px;
    margin-bottom: 22px;
  }
  .cookie-missing {
    color: var(--warn);
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .fb-status {
    background: var(--card-soft);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 13px;
    color: var(--ink-2);
    margin-bottom: 12px;
  }
  .fb-error {
    margin-top: 5px;
    color: var(--otodom);
  }
  .fb-textarea {
    margin-top: 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  .tg-intro {
    font-size: 13.5px; color: var(--muted); line-height: 1.5;
    margin-bottom: 14px;
  }
  .ok-pill {
    display: inline-block;
    font-size: 10.5px; font-weight: 700;
    color: var(--green); background: var(--green-soft);
    border-radius: 6px; padding: 1px 6px;
    text-transform: uppercase; letter-spacing: .04em;
    vertical-align: middle;
  }
  .field-hint { font-size: 12px; color: var(--muted-2); margin-top: 6px; line-height: 1.5; }
  .field-hint .link { color: var(--accent); font-weight: 600; cursor: pointer; }
  .chatid-row { display: flex; gap: 8px; }
  .chatid-row .input { flex: 1; }
  .detect-btn { height: 52px; border-radius: 14px; padding: 0 16px; flex: none; font-size: 14px; }
  .chats-list {
    margin-top: 10px;
    border: 1px solid var(--line-soft);
    border-radius: 12px;
    overflow: hidden;
  }
  .chat-row {
    display: flex; align-items: center; gap: 10px;
    width: 100%;
    padding: 11px 13px;
    background: var(--card);
    border-bottom: 1px solid #F1ECE2;
    cursor: pointer;
    text-align: left;
  }
  .chat-row:last-child { border-bottom: none; }
  .chat-name { flex: 1; font-size: 14px; font-weight: 600; color: var(--ink); }
  .chat-id { font-size: 12.5px; color: var(--muted-2); font-family: monospace; }
  .price-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
  .region-opt { gap: 7px; }
  .opt-color { width: 10px; height: 10px; border-radius: 3px; flex: none; }
  .chip-active .opt-color { outline: 1px solid rgba(255,255,255,.6); }
  .tg-msg {
    margin-top: 12px;
    font-size: 13px;
    padding: 10px 12px;
    border-radius: 10px;
  }
  .tg-ok { background: var(--green-soft); color: var(--green); }
  .tg-err { background: var(--otodom-soft); color: var(--otodom); }
  .tg-actions { display: flex; gap: 8px; margin-top: 14px; }
  .tg-actions .btn { flex: 1; height: 46px; }

  .sync-card {
    background: var(--card);
    border: 1px solid var(--line-soft);
    border-radius: 18px;
    overflow: hidden;
    margin-bottom: 22px;
  }
  .sync-row {
    padding: 14px 16px;
    display: flex; align-items: center; gap: 12px;
    border-bottom: 1px solid #F1ECE2;
  }
  .sync-row:last-child { border-bottom: none; }
  .sync-icon {
    width: 36px; height: 36px; border-radius: 10px;
    background: var(--green-soft);
    display: flex; align-items: center; justify-content: center; flex: none;
  }
  .sync-icon .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); }
  .sync-icon.failed { background: var(--otodom-soft); }
  .sync-icon.failed .dot { background: var(--otodom); }
  .sync-icon.partial { background: #FAF3E0; }
  .sync-icon.partial .dot { background: var(--warn); }
  .sync-info { flex: 1; }
  .sync-title { font-size: 14.5px; font-weight: 600; color: var(--ink); }
  .sync-sub { font-size: 12.5px; color: var(--muted); margin-top: 2px; }
  .sync-time, .sync-count { font-size: 12px; color: var(--muted-2); }
  .source-tag {
    height: 24px; padding: 0 9px; border-radius: 7px;
    font-size: 11px; font-weight: 800; letter-spacing: .04em;
    display: flex; align-items: center;
  }

  .section-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .add-btn {
    display: inline-flex; align-items: center; gap: 4px;
    color: var(--accent); font-size: 14px; font-weight: 600;
    background: transparent; border: none; cursor: pointer;
  }
  /* Task G — wrap the two action buttons (Edit schedules + New) in a
     flex row so they sit side-by-side on the section-label line. */
  .jobs-head-actions { display: flex; align-items: center; gap: 14px; }

  /* create form */
  .create-card {
    background: var(--card);
    border: 1px solid var(--line-soft);
    border-radius: 18px;
    padding: 16px;
    margin-bottom: 22px;
  }
  .presets {
    display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px;
  }
  .preset-chip {
    height: 30px; padding: 0 10px;
    border-radius: 9px;
    background: var(--card-soft);
    border: 1px solid var(--line);
    font-size: 12px; font-weight: 500;
    color: var(--ink-2);
    cursor: pointer;
  }
  .toggle-row {
    display: flex; flex-wrap: wrap; gap: 8px;
  }
  .create-actions {
    display: flex; gap: 8px; margin-top: 14px;
  }
  .create-actions .btn { flex: 1; height: 46px; }
  .error {
    background: var(--otodom-soft);
    color: var(--otodom);
    font-size: 13px;
    padding: 10px 12px;
    border-radius: 10px;
    margin-top: 12px;
  }
  .run-result {
    background: var(--green-soft);
    border-radius: 10px;
    padding: 12px;
    margin-top: 12px;
  }
  .rr-title { font-size: 13px; font-weight: 600; color: var(--green); margin-bottom: 6px; }
  .rr-stats { display: flex; gap: 14px; font-size: 13px; color: var(--ink-2); }
  .rr-stat b { color: var(--ink); }
  .rr-status { font-size: 11px; color: var(--green); margin-top: 4px; text-transform: uppercase; letter-spacing: .04em; }
  .rr-status.status-failed, .rr-status.status-partial { color: var(--warn); }

  .jobs-list {
    background: var(--card);
    border: 1px solid var(--line-soft);
    border-radius: 18px;
    overflow: hidden;
    margin-bottom: 22px;
  }
  .job-row {
    padding: 13px 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    border-bottom: 1px solid #F1ECE2;
  }
  .job-row:last-child { border-bottom: none; }
  .job-info { flex: 1; min-width: 0; }
  .job-name { font-size: 14.5px; font-weight: 600; color: var(--ink); }
  .job-sched {
    font-family: monospace; font-size: 12px;
    color: var(--accent); margin-top: 2px;
  }
  .job-meta { font-size: 12px; color: var(--muted); margin-top: 3px; }
  .job-actions { display: flex; align-items: center; gap: 8px; }
  .toggle-switch {
    width: 42px; height: 25px; border-radius: 13px;
    background: var(--line); position: relative; cursor: pointer;
    border: none; padding: 0;
    transition: background .15s;
  }
  .toggle-switch.on { background: var(--accent); }
  .knob {
    position: absolute; top: 2px; left: 2px;
    width: 21px; height: 21px; border-radius: 50%;
    background: var(--card);
    transition: transform .15s;
  }
  .toggle-switch.on .knob { transform: translateX(17px); }

  .empty-jobs {
    text-align: center; padding: 24px;
    color: var(--muted-2); font-size: 14px;
  }

  .runs-card {
    background: var(--card);
    border: 1px solid var(--line-soft);
    border-radius: 18px;
    overflow: hidden;
  }
  .run-row {
    padding: 13px 16px;
    display: flex; align-items: center; gap: 11px;
    border-bottom: 1px solid #F1ECE2;
  }
  .run-row:last-child { border-bottom: none; }
  .run-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .run-when { flex: 1; font-size: 13.5px; color: var(--ink-2); }
  .run-detail { font-size: 12.5px; color: var(--muted-2); }

  .version { text-align: center; font-size: 12px; color: var(--muted-2); padding-top: 16px; }
</style>
