<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import { user } from '../lib/store';
  import { back } from '../lib/router';
  import Icon from '../lib/icons/Icon.svelte';
  import ListingDetailContent from '../lib/components/ListingDetailContent.svelte';

  export let id;

  let listing = null;
  let loading = true;
  let error = '';
  let saving = false;

  onMount(async () => {
    try {
      const r = await api.listing(id);
      listing = r.listing;
    } catch (e) {
      error = e.message || 'Failed to load listing';
    } finally {
      loading = false;
    }
  });

  async function toggleSave() {
    if (!$user || saving) return;
    saving = true;
    try {
      if (listing.saved) { await api.unsave(listing.id); listing = { ...listing, saved: false }; }
      else { await api.save(listing.id); listing = { ...listing, saved: true }; }
    } catch {} finally { saving = false; }
  }
</script>

<div class="screen">
  <div class="sub-header">
    <button class="back-btn" on:click={() => back()}>
      <Icon name="back" size={18} color="#201E1B" />
    </button>
    <div class="sub-header-title">Listing</div>
    {#if listing}
      <button class="icon-btn" on:click={toggleSave} aria-label="Save" disabled={saving}>
        {#if listing.saved}
          <Icon name="heart-filled" size={20} color="#C15F3C" stroke={0} />
        {:else}
          <Icon name="heart" size={20} color="#4A473F" />
        {/if}
      </button>
    {:else}
      <div style="width:42px"></div>
    {/if}
  </div>

  <ListingDetailContent {listing} {loading} {error} />
</div>
