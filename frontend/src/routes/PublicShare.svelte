<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import Icon from '../lib/icons/Icon.svelte';
  import ListingDetailContent from '../lib/components/ListingDetailContent.svelte';

  export let token;

  let listing = null;
  let loading = true;
  let error = '';

  onMount(async () => {
    try {
      const r = await api.publicListing(token);
      listing = r.listing;
    } catch (e) {
      error = e.message || 'Listing not found';
    } finally {
      loading = false;
    }
  });
</script>

<div class="screen">
  <div class="pub-header">
    <div class="brand">Lokum</div>
    <div class="pub-tag">Shared listing</div>
  </div>

  <ListingDetailContent {listing} {loading} {error} isPublic={true} />
</div>

<style>
  .pub-header {
    display: flex; align-items: baseline; justify-content: space-between;
    padding: 14px 0 12px;
  }
  .brand { font-family: var(--serif); font-size: 24px; font-weight: 600; color: var(--ink); }
  .pub-tag { font-size: 12px; color: var(--muted-2); font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
</style>
