<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import { navigate } from '../lib/router';
  import Icon from '../lib/icons/Icon.svelte';
  import ListingCard from '../lib/components/ListingCard.svelte';

  let listings = [];
  let loading = true;

  onMount(async () => {
    try {
      const r = await api.saved();
      listings = r.listings;
    } finally {
      loading = false;
    }
  });
</script>

<div class="screen">
  <div class="sub-header">
    <button class="back-btn" on:click={() => navigate('/feed')}>
      <Icon name="back" size={18} color="#201E1B" />
    </button>
    <div class="sub-header-title">Saved</div>
    <div style="width:40px"></div>
  </div>

  {#if loading}
    <div class="cards-grid">
      {#each Array(3) as _}
        <div class="card sk-card">
          <div class="sk-img skeleton"></div>
          <div class="sk-body">
            <div class="sk-line skeleton" style="width:40%;height:22px"></div>
            <div class="sk-line skeleton" style="width:80%;height:16px;margin-top:8px"></div>
          </div>
        </div>
      {/each}
    </div>
  {:else if listings.length === 0}
    <div class="empty">
      <div class="empty-orb">
        <Icon name="heart" size={34} color="#B0AB9E" stroke={1.6} />
      </div>
      <div class="empty-title">Nothing saved yet</div>
      <p class="empty-msg">Tap the heart on any listing to keep it here.</p>
      <button class="btn btn-primary" on:click={() => navigate('/feed')}>Browse listings</button>
    </div>
  {:else}
    <div class="count-row">{listings.length} apartments kept for later</div>
    <div class="cards-grid">
      {#each listings as l (l.id)}
        <ListingCard listing={l} />
      {/each}
    </div>
    <div style="height:28px"></div>
  {/if}
</div>

<style>
  .count-row { font-size: 14px; color: var(--muted); margin: 2px 2px 14px; }
  .sk-card { overflow: hidden; }
  .sk-img { aspect-ratio: 4/3; border-radius: 0; }
  .sk-body { padding: 15px 16px 17px; }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 80px 20px;
    gap: 12px;
  }
  .empty-orb {
    width: 76px;
    height: 76px;
    border-radius: 50%;
    background: var(--card-soft);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 8px;
  }
  .empty-title {
    font-family: var(--serif);
    font-size: 22px;
    color: var(--ink);
  }
  .empty-msg {
    color: var(--muted);
    font-size: 14px;
    max-width: 230px;
    margin: 0 0 12px;
  }
</style>
