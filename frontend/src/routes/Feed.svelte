<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { api } from '../lib/api';
  import { ui } from '../lib/store';
  import { navigate, clearScroll } from '../lib/router';
  import { feedCache, filtersKeyOf, feedFresh, invalidateFeed } from '../lib/feedCache';
  import Icon from '../lib/icons/Icon.svelte';
  import ListingCard from '../lib/components/ListingCard.svelte';

  const PAGE = 30;

  // Hydrate synchronously from the module cache when possible — coming back
  // from a listing must not flash a skeleton or lose the scroll position.
  const cached = feedFresh($ui);
  let listings = cached ? feedCache.listings : [];
  let feedCount = cached ? feedCache.count : 0;
  let offset = cached ? feedCache.offset : 0;
  let hasMore = cached ? feedCache.hasMore : true;
  let cities = cached ? feedCache.meta?.cities || [] : [];
  let sources = cached ? feedCache.meta?.sources || [] : [];
  let runs = cached ? feedCache.meta?.runs || [] : [];
  let dupCount = cached ? feedCache.meta?.dupCount || 0 : 0;
  let updatedLabel = cached ? feedCache.meta?.updatedLabel || '' : '';
  let loading = !cached;
  let loadingMore = false;
  let error = '';
  let dateMenuOpen = false;
  let ready = false;
  let lastKey = filtersKeyOf($ui);

  let sentinelEl;
  let observer = null;

  $: city = cities.find(c => c.slug === $ui.citySlug) || cities[0];
  $: cityName = city?.name || 'Warsaw';
  $: maxPriceLabel = $ui.maxPrice >= 10000 ? '10 000 zł+' : ($ui.maxPrice.toLocaleString('pl-PL').replace(/,/g, ' ') + ' zł');
  $: selectedRun = runs.find(r => r.id === $ui.runId) || null;
  $: dateLabel = selectedRun ? formatRunLabel(selectedRun) : 'Latest run';
  $: selectedIdx = selectedRun ? runs.findIndex(r => r.id === selectedRun.id) : -1;
  $: olderRun = selectedIdx === -1 ? (runs.length > 1 ? runs[1] : null) : (runs[selectedIdx + 1] || null);
  $: newerRun = selectedIdx > 0 ? runs[selectedIdx - 1] : null;

  // Filter changes (from the Filters page) → drop cache + scroll, reload.
  $: if (ready && filtersKeyOf($ui) !== lastKey) {
    lastKey = filtersKeyOf($ui);
    clearScroll('/feed');
    invalidateFeed();
    load();
  }

  function formatRunLabel(r) {
    const d = new Date(r.started_at);
    const now = new Date();
    const diff = (now - d) / 1000;
    let prefix;
    if (diff < 86400 && now.getDate() === d.getDate()) prefix = 'Today';
    else if (diff < 2 * 86400) prefix = 'Yesterday';
    else prefix = d.toLocaleDateString('en-GB', { weekday: 'short' });
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return `${prefix} ${hh}:${mm}`;
  }

  function persistCache() {
    feedCache.filtersKey = filtersKeyOf($ui);
    feedCache.listings = listings;
    feedCache.count = feedCount;
    feedCache.offset = offset;
    feedCache.hasMore = hasMore;
    feedCache.fetchedAt = Date.now();
    feedCache.meta = { cities, sources, runs, dupCount, updatedLabel };
  }

  async function load() {
    loading = true;
    error = '';
    try {
      const [citiesR, sourcesR, runsR] = await Promise.all([
        api.cities(), api.sources(), api.runs(12)
      ]);
      cities = citiesR.cities;
      sources = sourcesR.sources;
      runs = runsR.runs;
      if (runs.length) {
        const d = new Date(runs[0].started_at);
        updatedLabel = `Updated ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
      }
      await loadListings(true);
      loadDupCount();
    } catch (e) {
      error = e.message || 'Failed to load';
    } finally {
      loading = false;
    }
  }

  async function loadDupCount() {
    try {
      const r = await api.duplicates($ui.citySlug);
      dupCount = r.groupCount || 0;
      persistCache();
    } catch { dupCount = 0; }
  }

  async function loadListings(reset = false) {
    if (reset) { offset = 0; hasMore = true; }
    if (!hasMore) return;
    try {
      const params = { city: $ui.citySlug, max_price: $ui.maxPrice, limit: PAGE, offset };
      if ($ui.runId) params.run_id = $ui.runId;
      const r = await api.listings(params);
      const page = r.listings || [];
      listings = reset ? page : [...listings, ...page];
      feedCount = r.count;
      offset += page.length;
      if (page.length < PAGE) hasMore = false;
      persistCache();
    } catch (e) {
      error = e.message || 'Failed to load listings';
    }
  }

  async function loadMore() {
    if (loadingMore || !hasMore || loading) return;
    loadingMore = true;
    await loadListings(false);
    loadingMore = false;
  }

  function setupObserver() {
    if (observer || !sentinelEl) return;
    observer = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) loadMore();
    }, { rootMargin: '1200px 0px' });
    observer.observe(sentinelEl);
  }

  function scrollTopReset() {
    window.scrollTo(0, 0);
    clearScroll('/feed');
  }

  function toggleDateMenu() { dateMenuOpen = !dateMenuOpen; }
  function closeDateMenu() { dateMenuOpen = false; }

  function selectRun(runId) {
    ui.update(u => ({ ...u, runId }));
    dateMenuOpen = false;
  }
  function selectLatest() {
    ui.update(u => ({ ...u, runId: null }));
    dateMenuOpen = false;
  }
  function goToOlderRun() { if (olderRun) selectRun(olderRun.id); }
  function goToNewerRun() { if (newerRun) selectRun(newerRun.id); else selectLatest(); }

  function runCountLabel(r) {
    if (r.status === 'failed') return r.error || 'failed';
    return `${r.new_count} new`;
  }

  onMount(async () => {
    if (!cached) await load();
    ready = true;
    await tick();
    setupObserver();
  });

  onDestroy(() => {
    if (observer) { observer.disconnect(); observer = null; }
  });
</script>

<div class="screen">
  <div class="feed-head">
    <div class="filters no-scrollbar">
      <button class="chip" on:click={() => navigate('/filters')}>
        <Icon name="filter" size={15} color="#201E1B" stroke={2} />
        Filters
      </button>
      <button class="chip" on:click={() => navigate('/filters')}>
        <Icon name="location" size={14} color="#8C877B" />
        {cityName}
        <Icon name="chevron-down" size={12} color="#8C877B" stroke={2.2} />
      </button>
      <button class="chip" class:chip-active={$ui.runId} on:click={toggleDateMenu}>
        <span class="dot" class:dot-active={$ui.runId}></span>
        {dateLabel}
        <Icon name="chevron-down" size={12} color={$ui.runId ? '#FDF6F1' : '#8C877B'} stroke={2.2} />
      </button>
      <button class="chip" on:click={() => navigate('/filters')}>
        Up to {maxPriceLabel}
      </button>
    </div>

    {#if dateMenuOpen}
      <div class="date-backdrop" on:click={closeDateMenu}></div>
      <div class="date-dropdown">
        <div class="date-header">Show listings from</div>
        <div class="date-list no-scrollbar">
          <button class="date-item" class:active={!selectedRun} on:click={selectLatest}>
            <div>
              <div class="di-label">Latest run</div>
              <div class="di-sub">{runs[0] ? `Today's freshest · ${runs[0].new_count} new` : 'No runs yet'}</div>
            </div>
            {#if !selectedRun}<Icon name="check" size={18} color="#C15F3C" stroke={2.2} />{/if}
          </button>
          {#each runs as r}
            <button class="date-item" class:active={selectedRun?.id === r.id} on:click={() => selectRun(r.id)}>
              <div>
                <div class="di-label">{formatRunLabel(r)}</div>
                <div class="di-sub">{runCountLabel(r)}{#if r.duration_ms} · {(r.duration_ms / 1000).toFixed(1)}s{/if}</div>
              </div>
              {#if selectedRun?.id === r.id}<Icon name="check" size={18} color="#C15F3C" stroke={2.2} />{/if}
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <div class="meta-row">
    <span>{feedCount} listings in {cityName}</span>
    <span>{updatedLabel}</span>
  </div>

  {#if loading}
    <div class="cards-grid">
      {#each Array(6) as _}
        <div class="sk-card card">
          <div class="sk-img skeleton"></div>
          <div class="sk-body">
            <div class="sk-line skeleton" style="width:40%;height:22px"></div>
            <div class="sk-line skeleton" style="width:80%;height:16px;margin-top:8px"></div>
            <div class="sk-line skeleton" style="width:60%;height:14px;margin-top:6px"></div>
          </div>
        </div>
      {/each}
    </div>
  {:else if error && listings.length === 0}
    <div class="error-box">
      <div class="error-title">Couldn't load listings</div>
      <div class="error-msg">{error}</div>
      <button class="btn btn-secondary" on:click={load}>Try again</button>
    </div>
  {:else if listings.length === 0}
    <div class="empty">
      <div class="empty-orb"><Icon name="location" size={34} color="#B0AB9E" /></div>
      <div class="empty-title">No new listings here</div>
      <p class="empty-msg">Try a different city, run, or check back after the next fetch.</p>
      <button class="btn btn-secondary" on:click={() => navigate('/settings')}>Run a fetch now</button>
    </div>
  {:else}
    <div class="cards-grid">
      {#each listings as l (l.id)}
        <ListingCard listing={l} />
      {/each}
    </div>

    <div class="sentinel" bind:this={sentinelEl}>
      {#if loadingMore}
        <div class="loading-more">Loading more…</div>
      {:else if !hasMore}
        <div class="caught-up">You're all caught up</div>
      {/if}
    </div>

    {#if !hasMore}
      <div class="end-actions">
        {#if olderRun}
          <button class="btn btn-primary btn-full" on:click={goToOlderRun}>
            Go to next run · {formatRunLabel(olderRun)}
            <span class="rot"><Icon name="chevron-down" size={16} color="#FDF6F1" stroke={2.4} /></span>
          </button>
        {/if}
        {#if selectedRun}
          <button class="btn btn-secondary btn-full" on:click={goToNewerRun}>
            <span class="rotup"><Icon name="chevron-down" size={16} stroke={2.4} /></span>
            {newerRun ? `Back to ${formatRunLabel(newerRun)}` : 'Back to latest run'}
          </button>
        {/if}
        <button class="btn btn-secondary btn-full dup-btn" on:click={() => navigate('/duplicates')}>
          <Icon name="copy" size={16} stroke={1.8} />
          Show duplicates{dupCount ? ` (${dupCount})` : ''}
        </button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .feed-head {
    position: sticky;
    top: var(--appbar-h);
    z-index: 25;
    background: var(--bg);
    padding: 10px 0 12px;
  }
  .filters {
    display: flex;
    align-items: center;
    gap: 8px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #C6A08C; }
  .dot-active { background: var(--accent-ink); }

  .date-backdrop { position: fixed; inset: 0; z-index: 30; }
  .date-dropdown {
    position: absolute;
    left: 0; right: 0; top: 56px;
    z-index: 31;
    background: var(--card);
    border: 1px solid #E8E2D6;
    border-radius: 18px;
    box-shadow: var(--shadow-pop);
    overflow: hidden;
  }
  @media (min-width: 700px) {
    .date-dropdown { left: 0; right: auto; width: 380px; }
  }
  .date-header {
    padding: 13px 16px 9px;
    font-size: 12px; font-weight: 700;
    letter-spacing: .05em; color: var(--muted-2);
    text-transform: uppercase;
  }
  .date-list { max-height: 320px; overflow-y: auto; }
  .date-item {
    width: 100%; padding: 11px 16px;
    border: none; border-top: 1px solid #F1ECE2;
    background: var(--card);
    display: flex; align-items: center; justify-content: space-between;
    cursor: pointer; text-align: left;
  }
  .date-item.active { background: #FBF3EF; }
  .di-label { font-size: 15px; font-weight: 500; color: var(--ink); }
  .date-item.active .di-label { color: var(--accent); font-weight: 600; }
  .di-sub { font-size: 12.5px; color: var(--muted-2); margin-top: 2px; }

  .meta-row {
    display: flex; align-items: baseline; justify-content: space-between;
    margin: 4px 2px 14px;
  }
  .meta-row span:first-child { font-size: 14px; color: var(--muted); font-weight: 500; }
  .meta-row span:last-child { font-size: 13px; color: var(--muted-2); }

  .sk-card { overflow: hidden; }
  .sk-img { aspect-ratio: 4/3; border-radius: 0; }
  .sk-body { padding: 15px 16px 17px; }

  .error-box {
    text-align: center; padding: 60px 20px;
    display: flex; flex-direction: column; align-items: center; gap: 12px;
  }
  .error-title { font-family: var(--serif); font-size: 22px; color: var(--ink); }
  .error-msg { color: var(--muted); font-size: 14px; }

  .empty {
    text-align: center; padding: 80px 20px;
    display: flex; flex-direction: column; align-items: center; gap: 12px;
  }
  .empty-orb {
    width: 76px; height: 76px; border-radius: 50%;
    background: var(--card-soft);
    display: flex; align-items: center; justify-content: center;
    margin-bottom: 8px;
  }
  .empty-title { font-family: var(--serif); font-size: 22px; color: var(--ink); }
  .empty-msg { color: var(--muted); font-size: 14px; max-width: 240px; margin: 0 0 12px; }

  .sentinel { min-height: 1px; }
  .loading-more { text-align: center; padding: 16px 0; font-size: 13px; color: var(--muted-2); }
  .caught-up { text-align: center; padding: 16px 0 4px; font-size: 13px; color: var(--muted-2); }

  .end-actions { display: flex; flex-direction: column; gap: 9px; margin: 10px 0 28px; max-width: 560px; margin-left: auto; margin-right: auto; width: 100%; }
  .end-actions .btn { height: 50px; font-size: 15px; }
  .rot { display: inline-flex; transform: rotate(-90deg); }
  .rotup { display: inline-flex; transform: rotate(90deg); }
  .dup-btn { color: var(--ink-2); }
</style>
