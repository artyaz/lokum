<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import { ui } from '../lib/store';
  import { navigate } from '../lib/router';
  import Icon from '../lib/icons/Icon.svelte';

  let cities = [];
  let citySlug = $ui.citySlug || 'warsaw';
  let text = '';
  let url = '';
  let imagesText = '';
  let parsing = false;
  let saving = false;
  let error = '';
  let parsed = null;   // { title, price, rooms, area, floor, district, description, lat, lng }
  let savedId = null;

  onMount(async () => {
    try {
      const r = await api.cities();
      cities = r.cities;
    } catch {}
  });

  async function parse() {
    if (!text.trim() || parsing) return;
    parsing = true;
    error = '';
    parsed = null;
    savedId = null;
    try {
      const images = imagesText.split('\n').map(s => s.trim()).filter(s => s.startsWith('http'));
      const r = await api.importText({
        text: text.trim(),
        url: url.trim() || null,
        images,
        city_slug: citySlug,
        save: false
      });
      parsed = r.parsed;
    } catch (e) {
      error = e.message || 'Parse failed';
    } finally {
      parsing = false;
    }
  }

  async function save() {
    if (!parsed || saving) return;
    saving = true;
    error = '';
    try {
      const images = imagesText.split('\n').map(s => s.trim()).filter(s => s.startsWith('http'));
      const r = await api.importText({
        text: text.trim(),
        url: url.trim() || null,
        images,
        city_slug: citySlug,
        save: true,
        parsed
      });
      savedId = r.listing?.id;
    } catch (e) {
      error = e.message || 'Save failed';
    } finally {
      saving = false;
    }
  }

  function reset() {
    text = ''; url = ''; imagesText = ''; parsed = null; savedId = null; error = '';
  }

  function fmt(n) {
    if (n == null || n === '') return '';
    return Number(n).toLocaleString('pl-PL').replace(/,/g, ' ') + ' zł';
  }
</script>

<div class="screen">
  <div class="sub-header">
    <button class="back-btn" on:click={() => navigate('/feed')}>
      <Icon name="back" size={18} color="#201E1B" />
    </button>
    <div class="sub-header-title">Import listing</div>
    <div style="width:40px"></div>
  </div>

  <div class="scroll no-scrollbar">
    <div class="intro card-lite">
      <div class="intro-title">From a Facebook group or anywhere else</div>
      <div class="intro-sub">
        Paste the text of a post (e.g. from a Warsaw rentals Facebook group) — AI will pull out the price,
        rooms, area and location, then the listing joins your feed, dedupe and notifications like any other source.
      </div>
    </div>

    <label class="label">City</label>
    <div class="city-row no-scrollbar">
      {#each cities as c}
        <button class="chip" class:chip-dark={citySlug === c.slug} on:click={() => citySlug = c.slug}>{c.name}</button>
      {/each}
    </div>

    <label class="label" style="margin-top:16px">Post text</label>
    <textarea class="input textarea" rows="8" bind:value={text}
      placeholder="Do wynajęcia 2-pokojowe mieszkanie na Mokotowie, 45 m2, 2800 zł + czynsz 600…"></textarea>

    <label class="label" style="margin-top:14px">Link to the post (optional)</label>
    <input class="input" bind:value={url} placeholder="https://www.facebook.com/groups/…/posts/…" />

    <label class="label" style="margin-top:14px">Image URLs (optional, one per line)</label>
    <textarea class="input textarea" rows="3" bind:value={imagesText}
      placeholder="https://…/photo1.jpg&#10;https://…/photo2.jpg"></textarea>

    {#if error}<div class="error-box">{error}</div>{/if}

    <button class="btn btn-primary btn-full" style="margin-top:16px" on:click={parse} disabled={!text.trim() || parsing}>
      <Icon name="zap" size={16} />
      {parsing ? 'Parsing with AI…' : 'Parse with AI'}
    </button>

    {#if parsed}
      <div class="preview card-lite fadein">
        <div class="pv-title">Parsed listing — check & save</div>

        <label class="label">Title</label>
        <input class="input" bind:value={parsed.title} />

        <div class="pv-grid">
          <div>
            <label class="label">Price (PLN/mo)</label>
            <input class="input" type="number" bind:value={parsed.price} />
          </div>
          <div>
            <label class="label">Rooms</label>
            <input class="input" type="number" bind:value={parsed.rooms} />
          </div>
          <div>
            <label class="label">Area (m²)</label>
            <input class="input" type="number" step="0.1" bind:value={parsed.area} />
          </div>
          <div>
            <label class="label">Floor</label>
            <input class="input" bind:value={parsed.floor} />
          </div>
        </div>

        <label class="label">District / area</label>
        <input class="input" bind:value={parsed.district} />

        <label class="label">Description</label>
        <textarea class="input textarea" rows="5" bind:value={parsed.description}></textarea>

        {#if savedId}
          <div class="saved-box">
            <Icon name="check" size={16} color="#2C7A54" stroke={2.2} />
            Saved to your feed.
          </div>
          <div class="pv-actions">
            <button class="btn btn-primary" on:click={() => navigate('/listing/' + savedId)}>View listing</button>
            <button class="btn btn-secondary" on:click={reset}>Import another</button>
          </div>
        {:else}
          <div class="pv-actions">
            <button class="btn btn-primary" on:click={save} disabled={saving || !parsed.title || !parsed.price}>
              {saving ? 'Saving…' : 'Save listing'}
            </button>
            <button class="btn btn-secondary" on:click={() => parsed = null}>Discard</button>
          </div>
        {/if}
      </div>
    {/if}
    <div style="height:24px"></div>
  </div>
</div>

<style>
  .scroll { padding: 6px 0 20px; }
  .card-lite {
    background: var(--card);
    border: 1px solid var(--line-soft);
    border-radius: 16px;
    padding: 14px 16px;
  }
  .intro { margin: 8px 0 18px; }
  .intro-title { font-size: 14.5px; font-weight: 600; color: var(--ink); }
  .intro-sub { font-size: 13px; color: var(--muted); margin-top: 5px; line-height: 1.55; }
  .city-row { display: flex; gap: 8px; overflow-x: auto; }
  .textarea {
    height: auto;
    padding: 12px 14px;
    line-height: 1.5;
    font-size: 14.5px;
    resize: vertical;
    border-radius: 14px;
    font-family: var(--sans);
  }
  .error-box {
    margin-top: 12px;
    background: var(--otodom-soft); color: var(--otodom);
    font-size: 13px; padding: 10px 12px; border-radius: 10px;
  }
  .preview { margin-top: 18px; }
  .pv-title { font-size: 13px; font-weight: 700; color: var(--muted-2); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 12px; }
  .pv-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
    margin-top: 4px;
  }
  .preview .label { margin-top: 12px; }
  .pv-actions { display: flex; gap: 8px; margin-top: 16px; }
  .pv-actions .btn { flex: 1; height: 48px; }
  .saved-box {
    display: flex; align-items: center; gap: 8px;
    margin-top: 14px;
    background: var(--green-soft); color: var(--green);
    font-size: 14px; font-weight: 600;
    padding: 11px 13px; border-radius: 11px;
  }
</style>
