<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import { ui } from '../lib/store';
  import { navigate } from '../lib/router';
  import Icon from '../lib/icons/Icon.svelte';

  let groups = [];
  let loading = true;
  let running = false;
  let error = '';
  let cityName = '';

  function fmt(n) {
    if (n == null) return '';
    return n.toLocaleString('pl-PL').replace(/,/g, ' ') + ' zł';
  }

  async function load() {
    loading = true;
    error = '';
    try {
      const [dR, cR] = await Promise.all([api.duplicates($ui.citySlug), api.cities()]);
      groups = dR.groups || [];
      cityName = (cR.cities.find(c => c.slug === $ui.citySlug) || {}).name || '';
    } catch (e) {
      error = e.message || 'Failed to load duplicates';
    } finally {
      loading = false;
    }
  }

  async function rescan() {
    running = true;
    error = '';
    try {
      await api.runDedupe();
      await load();
    } catch (e) {
      error = e.message || 'Rescan failed';
    } finally {
      running = false;
    }
  }

  onMount(load);
</script>

<div class="screen">
  <div class="sub-header">
    <button class="back-btn" on:click={() => navigate('/feed')}>
      <Icon name="back" size={18} color="#201E1B" />
    </button>
    <div class="sub-header-title">Duplicates</div>
    <button class="rescan" on:click={rescan} disabled={running}>
      {running ? 'Scanning…' : 'Rescan'}
    </button>
  </div>

  <div class="scroll no-scrollbar">
    <div class="intro">
      Same flat posted on multiple sites, matched by location, size and price{#if cityName}{' '}in {cityName}{/if}.
    </div>

    {#if loading}
      <div class="loading-note">Loading…</div>
    {:else if error}
      <div class="error-box">{error}</div>
    {:else if groups.length === 0}
      <div class="empty">
        <div class="empty-orb"><Icon name="copy" size={30} color="#B0AB9E" /></div>
        <div class="empty-title">No duplicates found</div>
        <p class="empty-msg">When the same flat appears on several sites, it will show up here grouped together.</p>
      </div>
    {:else}
      <div class="group-count">{groups.length} duplicate group{groups.length === 1 ? '' : 's'}</div>
      {#each groups as g (g.id)}
        <div class="group card">
          <div class="group-head">
            <span class="match-score">{Math.round(g.score * 100)}% match</span>
            <span class="group-where">
              {g.listings[0]?.district || ''}{g.listings[0]?.area ? ` · ${g.listings[0].area} m²` : ''}{g.listings[0]?.rooms ? ` · ${g.listings[0].rooms} rooms` : ''}
            </span>
          </div>
          {#each g.listings as l, i (l.id)}
            <button class="dup-row" on:click={() => navigate('/listing/' + l.id)}>
              {#if l.images?.[0]}
                <img class="dup-img" src={l.images[0]} alt="" loading="lazy" decoding="async" />
              {:else}
                <div class="dup-img dup-noimg"><Icon name="location" size={18} color="#B7B1A4" /></div>
              {/if}
              <div class="dup-info">
                <div class="dup-price">
                  {fmt(l.price)}
                  {#if i === 0}<span class="primary-tag">primary</span>{/if}
                </div>
                <div class="dup-title">{l.title}</div>
              </div>
              <span class="dup-source" style="color:{l.source?.color};background:{l.source?.color}14">{l.source?.name}</span>
            </button>
          {/each}
        </div>
      {/each}
    {/if}
    <div style="height:22px"></div>
  </div>
</div>

<style>
  .scroll { padding: 6px 0 20px; }
  .rescan { font-size: 14px; font-weight: 600; color: var(--accent); }
  .intro { font-size: 13.5px; color: var(--muted); margin: 8px 2px 16px; line-height: 1.5; }
  .loading-note { text-align: center; color: var(--muted-2); padding: 40px; font-size: 14px; }
  .error-box {
    background: var(--otodom-soft); color: var(--otodom);
    font-size: 13px; padding: 12px 14px; border-radius: 12px;
  }
  .empty {
    text-align: center; padding: 70px 20px;
    display: flex; flex-direction: column; align-items: center; gap: 12px;
  }
  .empty-orb {
    width: 76px; height: 76px; border-radius: 50%;
    background: var(--card-soft);
    display: flex; align-items: center; justify-content: center;
  }
  .empty-title { font-family: var(--serif); font-size: 22px; color: var(--ink); }
  .empty-msg { color: var(--muted); font-size: 14px; max-width: 260px; margin: 0; }
  .group-count { font-size: 13px; font-weight: 700; color: var(--muted-2); text-transform: uppercase; letter-spacing: .05em; margin: 0 2px 12px; }
  .group { margin-bottom: 16px; overflow: hidden; }
  .group-head {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid #F1ECE2;
    background: var(--card-soft);
  }
  .match-score {
    font-size: 12px; font-weight: 700; color: var(--green);
    background: var(--green-soft);
    padding: 3px 9px; border-radius: 8px;
  }
  .group-where { font-size: 12.5px; color: var(--muted); }
  .dup-row {
    display: flex; align-items: center; gap: 12px;
    width: 100%;
    padding: 12px 16px;
    border-bottom: 1px solid #F1ECE2;
    background: var(--card);
    cursor: pointer;
    text-align: left;
  }
  .dup-row:last-child { border-bottom: none; }
  .dup-row:hover { background: #FAF9F5; }
  .dup-img {
    width: 62px; height: 62px;
    border-radius: 12px;
    object-fit: cover;
    flex: none;
  }
  .dup-noimg {
    background: var(--card-soft);
    display: flex; align-items: center; justify-content: center;
  }
  .dup-info { flex: 1; min-width: 0; }
  .dup-price { font-family: var(--serif); font-size: 17px; font-weight: 600; color: var(--ink); }
  .dup-title {
    font-size: 12.5px; color: var(--muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    margin-top: 2px;
  }
  .dup-source {
    font-size: 10.5px; font-weight: 800; letter-spacing: .04em;
    padding: 4px 8px; border-radius: 7px;
    flex: none;
  }
</style>
