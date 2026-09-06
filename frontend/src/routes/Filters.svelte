<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import { ui } from '../lib/store';
  import { navigate } from '../lib/router';
  import Icon from '../lib/icons/Icon.svelte';

  let cities = [];
  let sources = [];
  let localCity = $ui.citySlug;
  let localMaxPrice = $ui.maxPrice;
  let localRunId = $ui.runId;
  let runs = [];

  onMount(async () => {
    const [cR, sR, rR] = await Promise.all([api.cities(), api.sources(), api.runs(8)]);
    cities = cR.cities;
    sources = sR.sources;
    runs = rR.runs;
  });

  $: maxPriceLabel = localMaxPrice >= 10000
    ? '10 000 zł+'
    : (localMaxPrice.toLocaleString('pl-PL').replace(/,/g,' ') + ' zł');

  function save() {
    ui.update(u => ({ ...u, citySlug: localCity, maxPrice: localMaxPrice, runId: localRunId }));
    navigate('/feed');
  }
  function reset() {
    localCity = 'warsaw';
    localMaxPrice = 6000;
    localRunId = null;
  }

  function formatRunLabel(r) {
    const d = new Date(r.started_at);
    const now = new Date();
    const diff = (now - d) / 1000;
    let prefix;
    if (diff < 86400 && now.getDate() === d.getDate()) prefix = 'Today';
    else if (diff < 2 * 86400) prefix = 'Yesterday';
    else prefix = d.toLocaleDateString('en-GB', { weekday: 'short' });
    const hh = d.getHours().toString().padStart(2,'0');
    const mm = d.getMinutes().toString().padStart(2,'0');
    return `${prefix} ${hh}:${mm}`;
  }
</script>

<div class="screen">
  <div class="sub-header">
    <button class="back-btn" on:click={() => navigate('/feed')}>
      <Icon name="close" size={18} color="#201E1B" stroke={1.9} />
    </button>
    <div class="sub-header-title">Filters</div>
    <span class="reset" on:click={reset}>Reset</span>
  </div>

  <div class="scroll no-scrollbar">
    <div class="section-label" style="margin:12px 0">City</div>
    <div class="city-grid">
      {#each cities as c}
        <button class="chip" class:chip-dark={localCity === c.slug} on:click={() => localCity = c.slug}>
          {c.name}
        </button>
      {/each}
    </div>

    <div class="row-between" style="margin:30px 0 14px">
      <span class="section-label">Max price</span>
      <span class="price-display">{maxPriceLabel}</span>
    </div>
    <input type="range" min="1500" max="10000" step="100" bind:value={localMaxPrice} class="slider" />
    <div class="row-between" style="font-size:12.5px;color:var(--muted-2);margin-bottom:30px">
      <span>1 500 zł</span><span>10 000 zł+</span>
    </div>

    <div class="section-label" style="margin:0 0 12px">Listing run</div>
    <div class="run-list">
      <button class="run-item" class:active={!localRunId} on:click={() => localRunId = null}>
        <div>
          <div class="ri-title">Latest run</div>
          <div class="ri-sub">{runs[0] ? `${runs[0].new_count} new listings` : 'No runs yet'}</div>
        </div>
        {#if !localRunId}<Icon name="check" size={18} color="#C15F3C" stroke={2.2} />{/if}
      </button>
      {#each runs as r}
        <button class="run-item" class:active={localRunId === r.id} on:click={() => localRunId = r.id}>
          <div>
            <div class="ri-title">{formatRunLabel(r)}</div>
            <div class="ri-sub">{r.new_count} new · {r.status}</div>
          </div>
          {#if localRunId === r.id}<Icon name="check" size={18} color="#C15F3C" stroke={2.2} />{/if}
        </button>
      {/each}
    </div>
  </div>

  <div class="footer-bar">
    <button class="btn btn-primary btn-full" on:click={save}>Show listings</button>
  </div>
</div>

<style>
  .screen { background: var(--bg); }
  .scroll { padding: 6px 0 20px; }
  .reset { font-size: 14px; font-weight: 600; color: var(--accent); cursor: pointer; }
  .city-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 9px;
    margin-bottom: 30px;
  }
  .city-grid .chip { height: 42px; padding: 0 18px; border-radius: 21px; font-size: 15px; }
  .row-between {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .price-display {
    font-family: var(--serif);
    font-size: 20px;
    font-weight: 600;
    color: var(--ink);
  }
  .slider {
    width: 100%;
    accent-color: var(--accent);
    height: 6px;
    margin-bottom: 6px;
  }
  .run-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--card-soft);
    padding: 5px;
    border-radius: 15px;
  }
  .run-item {
    flex: 1;
    padding: 12px 14px;
    border-radius: 11px;
    background: transparent;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    text-align: left;
  }
  .run-item.active {
    background: var(--card);
    box-shadow: 0 1px 4px rgba(60,45,35,.08);
  }
  .ri-title { font-size: 14px; font-weight: 600; color: var(--ink); }
  .ri-sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .footer-bar {
    padding: 12px 0 max(16px, env(safe-area-inset-bottom));
  }
</style>
