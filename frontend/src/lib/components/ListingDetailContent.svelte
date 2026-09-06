<!--
  Shared listing-detail body — used by both the authenticated
  ListingDetail.svelte route (at /listing/:id) and the public
  PublicShare.svelte route (at /s/:token).

  Task 5: extracted from ListingDetail.svelte so the shared listing
  page renders the SAME layout and components (interactive photo
  gallery with arrows + dots, conveniences, nearby-POIs chips,
  Leaflet map, fee breakdown, params grid, description with
  translate toggle, action buttons) as the authenticated page.

  Parent supplies the data (listing/loading/error); this component
  owns all the body UI + the POI/map/translate side-effects.

  Props:
    listing   — listing object or null while loading
    loading   — bool
    error     — string
    isPublic  — bool (default false). When true:
                  · POI chips render as info-only divs (no star toggle)
                  · "Share listing" button is hidden (no user session)
                  · Save-heart is NOT in this component — the parent
                    decides whether to render it in its header.

  The POI endpoint (GET /api/listings/:id/pois) and the translate
  endpoint (POST /api/listings/:id/translate) are both optionalUser,
  so they work without an auth session — POIs come back unannotated
  and translate runs against the AI proxy without a user_id.
-->
<script>
  import { onMount, onDestroy } from 'svelte';
  // leaflet CSS is imported dynamically inside initMap() so it lands in the
  // same lazy chunk as the leaflet JS — the user only pays the ~3 KB gzip
  // cost when they actually open a map.
  import { api } from '../api';
  import { user } from '../store';
  import Icon from '../icons/Icon.svelte';
  import {
    starredPois,
    initStarredPois,
    toggleStarPoi,
    matchPoiAgainstStarred,
    formatDistance
  } from '../pois';

  export let listing = null;
  export let loading = false;
  export let error = '';
  export let isPublic = false;

  let currentImage = 0;
  let translating = false;
  let translated = null;
  let showTranslated = false;
  let translateError = '';
  let shareUrl = '';
  let copied = false;
  let sharing = false;

  let mapEl;
  let map = null;
  let L = null;

  // Nearby POIs — fetched once listing.id is known. The endpoint is
  // optionalUser so it works for the public share page too (the
  // starred-state comes back null/empty when there's no session).
  let pois = [];
  let poisLoading = false;
  let poisError = '';
  let starred = [];
  let poisLoadedFor = null; // guards against double-load in reactive $:
  const unsubStarred = starredPois.subscribe(s => { starred = s || []; });

  onMount(() => {
    // For an authenticated user, prefetch the starred-POI list so POI
    // chips can render the right star state immediately. For public
    // viewers this is a no-op (the store catches the 401 and stays []).
    initStarredPois();
  });

  onDestroy(() => {
    if (map) { map.remove(); map = null; }
    unsubStarred && unsubStarred();
  });

  // Reactive: when listing arrives (or changes), kick off POI loading
  // and seed the translated-description cache. Mirrors what the
  // original ListingDetail.svelte did inside its onMount after the
  // fetch returned.
  $: if (listing?.id && poisLoadedFor !== listing.id) {
    poisLoadedFor = listing.id;
    if (listing.descriptionEn) {
      translated = listing.descriptionEn;
      showTranslated = true;
    }
    loadPois();
  }

  async function loadPois() {
    if (poisLoading || !listing?.id) return;
    // Don't bother if the listing has no coords — backend would return [].
    if (listing.lat == null || listing.lng == null) return;
    poisLoading = true;
    poisError = '';
    try {
      const r = await api.listingPois(listing.id);
      pois = r.pois || [];
    } catch (e) {
      poisError = e?.message || 'POIs unavailable';
    } finally {
      poisLoading = false;
    }
  }

  // Reactive: re-derive the starred flag from the global store so a star
  // tap on the feed (which updated the store) is reflected here too.
  $: poisAnnotated = pois.map(p => {
    const m = matchPoiAgainstStarred(p, starred);
    return m
      ? { ...p, starred: true, starred_id: m.id,
          id: p.place_id || `${p.name}|${p.lat}|${p.lng}`,
          label: `${p.name} · ${formatDistance(p.distance_m)}`,
          iconName: p.type === 'restaurant' ? 'restaurant' : p.type }
      : { ...p, starred: false, starred_id: null,
          id: p.place_id || `${p.name}|${p.lat}|${p.lng}`,
          label: `${p.name} · ${formatDistance(p.distance_m)}`,
          iconName: p.type === 'restaurant' ? 'restaurant' : p.type };
  });

  $: poisByType = (() => {
    const groups = {};
    for (const p of poisAnnotated) {
      (groups[p.type] ||= []).push(p);
    }
    return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
  })();

  async function togglePoiStar(e, poi) {
    e?.stopPropagation();
    try {
      await toggleStarPoi(poi);
    } catch {
      // revert handled in store
    }
  }

  $: if (listing && mapEl && !map) initMap();

  async function initMap() {
    if (!listing?.lat || !listing?.lng) return;
    try {
      [L] = await Promise.all([
        import('leaflet').then(m => m.default),
        import('leaflet/dist/leaflet.css')
      ]);
      if (map) return;
      map = L.map(mapEl, { center: [listing.lat, listing.lng], zoom: 13, scrollWheelZoom: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap', maxZoom: 19
      }).addTo(map);
      L.circleMarker([listing.lat, listing.lng], {
        radius: 8, color: '#C15F3C', weight: 3, fillColor: '#C15F3C', fillOpacity: 0.9
      }).addTo(map);
      L.circle([listing.lat, listing.lng], {
        radius: 600, color: '#C15F3C', weight: 1, fillColor: '#C15F3C', fillOpacity: 0.12
      }).addTo(map);
    } catch {}
  }

  function onGalleryScroll(e) {
    const el = e.currentTarget;
    currentImage = Math.round(el.scrollLeft / el.clientWidth);
  }

  function scrollGallery(dir, el) {
    const g = el || document.querySelector('.gallery');
    if (g) g.scrollBy({ left: dir * g.clientWidth, behavior: 'smooth' });
  }

  function md(src) {
    if (!src) return '';
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const lines = src.split('\n');
    let html = '';
    let inList = false;
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (/^\s*[-*•]\s+/.test(line)) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += '<li>' + inline(line.replace(/^\s*[-*•]\s+/, '')) + '</li>';
        continue;
      }
      if (inList) { html += '</ul>'; inList = false; }
      const h = line.match(/^(#{1,3})\s+(.*)/);
      if (h) {
        const lvl = h[1].length + 1;
        html += `<h${lvl}>${inline(h[2])}</h${lvl}>`;
      } else if (line.trim() === '') {
        html += '';
      } else {
        html += '<p>' + inline(line) + '</p>';
      }
    }
    if (inList) html += '</ul>';
    return html;

    function inline(s) {
      return esc(s)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>');
    }
  }

  async function doTranslate() {
    if (translating) return;
    if (translated) { showTranslated = !showTranslated; return; }
    translating = true;
    translateError = '';
    try {
      const r = await api.translateListing(listing.id);
      translated = r.description;
      showTranslated = true;
    } catch (e) {
      translateError = e.message || 'Translation failed';
    } finally {
      translating = false;
    }
  }

  async function doShare() {
    if (sharing) return;
    sharing = true;
    try {
      const r = await api.shareListing(listing.id);
      shareUrl = `${window.location.origin}/s/${r.token}`;
      try {
        await navigator.clipboard.writeText(shareUrl);
        copied = true;
        setTimeout(() => copied = false, 2000);
      } catch {}
    } catch (e) {
      error = e.message;
    } finally {
      sharing = false;
    }
  }

  function openSource() {
    if (listing?.url) window.open(listing.url, '_blank', 'noopener');
  }

  function openMaps() {
    const q = listing.lat && listing.lng
      ? `${listing.lat},${listing.lng}`
      : `${listing.district}, ${listing.city?.name || ''}`;
    window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`, '_blank', 'noopener');
  }

  function fmt(n) {
    if (n == null) return '';
    return n.toLocaleString('pl-PL').replace(/,/g, ' ') + ' zł';
  }
</script>

{#if loading}
  <div class="sk-wrap">
    <div class="sk-hero skeleton"></div>
    <div class="sk-line skeleton" style="width:45%;height:26px;margin-top:16px"></div>
    <div class="sk-line skeleton" style="width:85%;height:18px;margin-top:10px"></div>
    <div class="sk-line skeleton" style="width:65%;height:15px;margin-top:8px"></div>
  </div>
{:else if error && !listing}
  <div class="error-state">
    <div class="error-title">Failed to load listing</div>
    <div class="error-msg">{error}</div>
  </div>
{:else if listing}
  <div class="detail-grid">
    <div class="col-main">
      {#if listing.images?.length}
        <div class="gallery-wrap">
          <div class="gallery no-scrollbar" on:scroll={onGalleryScroll}>
            {#each listing.images as img, i}
              <div class="g-slide">
                <div class="g-backdrop" style="background-image:url({img})"></div>
                <img class="g-img" src={img} alt="{listing.title} — photo {i + 1}" loading={i === 0 ? 'eager' : 'lazy'} decoding="async" />
              </div>
            {/each}
          </div>
          {#if listing.images.length > 1}
            <button class="g-nav g-prev" on:click={(e) => scrollGallery(-1, e.currentTarget.closest('.gallery-wrap').querySelector('.gallery'))} aria-label="Previous photo">
              <Icon name="chevron-down" size={18} color="#201E1B" stroke={2.4} />
            </button>
            <button class="g-nav g-next" on:click={(e) => scrollGallery(1, e.currentTarget.closest('.gallery-wrap').querySelector('.gallery'))} aria-label="Next photo">
              <Icon name="chevron-down" size={18} color="#201E1B" stroke={2.4} />
            </button>
            <div class="g-counter">{currentImage + 1} / {listing.images.length}</div>
          {/if}
          <div class="g-source" style="color:{listing.source?.color}">{listing.source?.name}</div>
        </div>
      {/if}

      <h1 class="title">{listing.title}</h1>
      <div class="meta-line">
        <Icon name="location" size={14} color="#9A9488" stroke={1.7} />
        <span>{listing.address || listing.district}, {listing.city?.name}
          {#if listing.rooms} · {listing.rooms} room{listing.rooms === 1 ? '' : 's'}{/if}
          {#if listing.area} · {listing.area} m²{/if}
          {#if listing.floor} · floor {listing.floor}{/if}
        </span>
      </div>

      {#if listing.conveniences?.length}
        <div class="conv">
          {#each listing.conveniences as c}
            <span class="conv-chip" class:region-chip={c.type === 'region'}>
              <Icon name={c.type} size={13} stroke={1.7} />
              {c.label}
            </span>
          {/each}
        </div>
      {/if}

      {#if listing.lat && listing.lng}
        <div class="section-label" style="margin:22px 2px 11px">Nearby places</div>
        <div class="pois-wrap card-lite">
          {#if poisLoading}
            <div class="pois-loading">Finding nearby places…</div>
          {:else if poisError}
            <div class="pois-error">{poisError}</div>
          {:else if !poisAnnotated.length}
            <div class="pois-empty">No nearby points of interest found.</div>
          {:else}
            {#each poisByType as [type, items]}
              <div class="poi-group">
                <div class="poi-group-label">{type}</div>
                <div class="poi-chips">
                  {#each items as poi (poi.id)}
                    {#if isPublic}
                      <!-- Public viewer: info-only chip, no star toggle
                           (starred-state is per-user; a public viewer has
                           no session to attribute a star to). -->
                      <div class="poi-chip poi-chip-static" title={poi.address || poi.name}>
                        <Icon name={poi.iconName} size={13} stroke={1.7} />
                        <span class="poi-label">{poi.label}</span>
                        {#if poi.rating}
                          <span class="poi-rating">{Number(poi.rating).toFixed(1)}</span>
                        {/if}
                      </div>
                    {:else}
                      <button
                        class="poi-chip"
                        class:poi-starred={poi.starred}
                        on:click|stopPropagation={(e) => togglePoiStar(e, poi)}
                        title={poi.address || poi.name}
                      >
                        <Icon name={poi.iconName} size={13} stroke={1.7} />
                        <span class="poi-label">{poi.label}</span>
                        {#if poi.rating}
                          <span class="poi-rating">{Number(poi.rating).toFixed(1)}</span>
                        {/if}
                        <Icon name={poi.starred ? 'star' : 'star-outline'} size={11}
                              color={poi.starred ? '#D6A419' : '#9A9488'} stroke={0} />
                      </button>
                    {/if}
                  {/each}
                </div>
              </div>
            {/each}
          {/if}
        </div>
      {/if}

      {#if listing.description}
        <div class="section-label" style="margin:22px 2px 11px">Description</div>
        <div class="desc card-lite">
          {#if showTranslated && translated}
            <div class="desc-content markdown">{@html md(translated)}</div>
          {:else}
            <p class="raw-desc">{listing.description}</p>
          {/if}
          <button class="translate-btn" on:click={doTranslate} disabled={translating}>
            <Icon name="external" size={14} />
            {translating ? 'Translating…' : showTranslated ? 'Show original (PL)' : translated ? 'Show English version' : 'Translate & restructure with AI'}
          </button>
          {#if translateError}<div class="te-error">{translateError}</div>{/if}
        </div>
      {/if}
    </div>

    <div class="col-side">
      <div class="side-stick">
        <div class="price-block card-lite">
          <div class="price-main">{listing.priceLabel}<span class="per">/mo</span></div>
          {#if listing.totalEstimate && listing.totalEstimate !== listing.price}
            <div class="total-est">
              ≈ {fmt(listing.totalEstimate)} all-in
              {#if listing.totalBreakdown?.items?.length}
                <span class="te-hint">(+{fmt(listing.totalEstimate - listing.price).replace(' zł', '')} fees)</span>
              {/if}
            </div>
          {:else}
            <div class="total-est muted">rent only · utilities extra unless stated</div>
          {/if}

          {#if listing.totalBreakdown?.items?.length}
            <div class="breakdown">
              <div class="bd-title">Estimated monthly costs</div>
              <div class="bd-row"><span>Rent</span><b>{fmt(listing.price)}</b></div>
              {#each listing.totalBreakdown.items as it}
                <div class="bd-row"><span>{it.label}</span><b>+{fmt(it.amount_pln)}</b></div>
              {/each}
              <div class="bd-row bd-total"><span>Estimated total</span><b>{fmt(listing.totalEstimate)}</b></div>
              {#if listing.totalBreakdown.notes}
                <div class="bd-notes">{listing.totalBreakdown.notes}</div>
              {/if}
            </div>
          {/if}
        </div>

        {#if (listing.paramsEn?.length || listing.params?.length)}
          <div class="section-label" style="margin:18px 2px 11px">Details</div>
          <div class="params-grid">
            {#each (listing.paramsEn?.length ? listing.paramsEn : listing.params) as p}
              <div class="param-box">
                <div class="p-label">{p.label}</div>
                <div class="p-value">{p.value}</div>
              </div>
            {/each}
          </div>
        {/if}

        {#if listing.lat && listing.lng}
          <div class="section-label" style="margin:18px 2px 11px">Location</div>
          <div class="map-box">
            <div class="d-map" bind:this={mapEl}></div>
          </div>
        {/if}

        <div class="detail-actions">
          <button class="btn btn-primary btn-full" on:click={openSource}>
            <Icon name="external" size={16} />
            Open on {listing.source?.name}
          </button>
          <button class="btn btn-secondary btn-full" on:click={openMaps}>
            <Icon name="map" size={16} />
            Google Maps
          </button>
          {#if !isPublic && $user}
            <button class="btn btn-secondary btn-full" on:click={doShare} disabled={sharing}>
              <Icon name="share" size={16} />
              {copied ? 'Link copied!' : shareUrl ? 'Copy share link again' : 'Share listing'}
            </button>
          {/if}
          {#if shareUrl}
            <div class="share-url-box">{shareUrl}</div>
          {/if}
        </div>
      </div>
    </div>
  </div>
  <div style="height:26px"></div>
{/if}

<style>
  .sk-wrap { padding-top: 8px; }
  .sk-hero { aspect-ratio: 16/9; border-radius: 22px; }

  .detail-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 24px;
  }
  @media (min-width: 900px) {
    .detail-grid { grid-template-columns: minmax(0, 1.25fr) minmax(320px, .75fr); }
    .side-stick { position: sticky; top: calc(var(--appbar-h) + 16px); }
  }

  .gallery-wrap {
    position: relative;
    background: #141210;
    border-radius: 22px;
    overflow: hidden;
  }
  .gallery {
    display: flex;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
  }
  .g-slide {
    position: relative;
    flex: none;
    width: 100%;
    height: clamp(260px, 52vw, 480px);
    scroll-snap-align: start;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  @media (min-width: 900px) {
    .g-slide { height: 460px; }
  }
  .g-backdrop {
    position: absolute;
    inset: -24px;
    background-size: cover;
    background-position: center;
    filter: blur(22px) brightness(.72);
    transform: scale(1.12);
  }
  .g-img {
    position: relative;
    z-index: 1;
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
    object-fit: contain;
    box-shadow: 0 6px 30px rgba(0,0,0,.35);
  }
  .g-nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 38px; height: 38px;
    border-radius: 50%;
    background: rgba(255,255,255,.92);
    display: flex; align-items: center; justify-content: center;
    z-index: 3;
  }
  .g-prev { left: 10px; }
  .g-prev :global(svg) { transform: rotate(90deg); }
  .g-next { right: 10px; }
  .g-next :global(svg) { transform: rotate(-90deg); }
  .g-counter {
    position: absolute;
    bottom: 10px; right: 12px;
    z-index: 3;
    background: rgba(20,18,16,.65);
    color: #fff;
    font-size: 12px; font-weight: 600;
    padding: 3px 9px;
    border-radius: 8px;
  }
  .g-source {
    position: absolute;
    top: 10px; right: 12px;
    z-index: 3;
    background: rgba(255,255,255,.94);
    font-size: 11px; font-weight: 800; letter-spacing: .04em;
    padding: 4px 9px;
    border-radius: 7px;
  }

  .title {
    font-size: 21px;
    font-weight: 600;
    line-height: 1.35;
    color: #2E2B26;
    margin: 16px 0 8px;
  }
  @media (min-width: 900px) {
    .title { font-size: 24px; }
  }
  .meta-line {
    display: flex; align-items: center; gap: 6px;
    font-size: 14px; color: var(--muted);
    margin-bottom: 12px;
  }
  .conv { display: flex; flex-wrap: wrap; gap: 6px; }
  .conv-chip {
    display: inline-flex; align-items: center; gap: 5px;
    height: 28px; padding: 0 11px;
    border-radius: 9px;
    background: #F5F2EA;
    font-size: 12.5px; font-weight: 500; color: #5B574E;
  }
  .region-chip { background: var(--accent-soft); color: var(--accent); font-weight: 600; }

  /* Nearby-POIs section. */
  .pois-wrap {
    padding: 14px 16px 16px;
  }
  .pois-loading, .pois-error, .pois-empty {
    font-size: 13.5px; color: var(--muted-2); padding: 6px 0;
  }
  .pois-error { color: var(--otodom); }
  .poi-group + .poi-group { margin-top: 12px; }
  .poi-group-label {
    font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: .05em;
    color: var(--muted-2); margin-bottom: 7px;
  }
  .poi-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .poi-chip {
    display: inline-flex; align-items: center; gap: 6px;
    height: 30px; padding: 0 11px;
    border-radius: 9px;
    border: 1px solid transparent;
    background: #F5F2EA;
    font-size: 12.5px; font-weight: 500; color: #5B574E;
    cursor: pointer; line-height: 1;
    transition: background .12s, border-color .12s;
  }
  .poi-chip:hover { background: #EFE9DA; }
  .poi-chip.poi-starred {
    background: #FFF6E0;
    border-color: #E8C766;
    color: #8A6512;
    font-weight: 600;
  }
  /* Static (info-only) chip for public viewers — same look, no cursor */
  .poi-chip-static {
    cursor: default;
  }
  .poi-chip-static:hover { background: #F5F2EA; }
  .poi-chip .poi-label {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 220px;
  }
  .poi-chip .poi-rating {
    font-size: 11px; color: #9A9488; font-weight: 600;
  }
  .poi-chip.poi-starred .poi-rating { color: #B0822B; }

  .card-lite {
    background: var(--card);
    border: 1px solid var(--line-soft);
    border-radius: 16px;
    padding: 14px 16px;
  }

  .price-main {
    font-family: var(--serif);
    font-size: 30px;
    font-weight: 600;
    color: var(--ink);
  }
  .per { font-size: 16px; color: var(--muted); font-family: var(--sans); font-weight: 500; }
  .total-est {
    margin-top: 2px;
    font-size: 14.5px;
    font-weight: 600;
    color: var(--accent);
  }
  .total-est .te-hint { color: var(--muted); font-weight: 500; }
  .total-est.muted { color: var(--muted-2); font-weight: 500; }

  .breakdown { margin-top: 12px; border-top: 1px solid var(--line-soft); padding-top: 10px; }
  .bd-title { font-size: 13px; font-weight: 700; color: var(--muted-2); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 8px; }
  .bd-row {
    display: flex; justify-content: space-between; gap: 10px;
    font-size: 14px; color: var(--ink-2);
    padding: 4px 0;
  }
  .bd-row b { color: var(--ink); font-weight: 600; }
  .bd-total {
    border-top: 1px solid var(--line-soft);
    margin-top: 6px; padding-top: 8px;
    font-weight: 600;
  }
  .bd-notes { font-size: 12.5px; color: var(--muted); margin-top: 8px; line-height: 1.5; }

  .params-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .param-box {
    background: var(--card);
    border: 1px solid var(--line-soft);
    border-radius: 12px;
    padding: 10px 12px;
  }
  .p-label { font-size: 11.5px; color: var(--muted-2); font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
  .p-value { font-size: 14px; color: var(--ink); font-weight: 600; margin-top: 2px; }

  .desc .raw-desc {
    font-size: 14.5px; line-height: 1.6; color: var(--ink-2);
    white-space: pre-wrap; margin: 0 0 12px;
  }
  .desc-content { font-size: 14.5px; line-height: 1.6; color: var(--ink-2); }
  .desc-content :global(h3) { font-family: var(--serif); font-size: 18px; margin: 14px 0 6px; color: var(--ink); }
  .desc-content :global(h4) { font-family: var(--serif); font-size: 16px; margin: 12px 0 5px; color: var(--ink); }
  .desc-content :global(p) { margin: 0 0 9px; }
  .desc-content :global(ul) { margin: 0 0 10px; padding-left: 20px; }
  .desc-content :global(li) { margin-bottom: 4px; }
  .translate-btn {
    display: inline-flex; align-items: center; gap: 6px;
    height: 38px; padding: 0 14px;
    border-radius: 10px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 13.5px; font-weight: 600;
  }
  .te-error { color: var(--otodom); font-size: 13px; margin-top: 8px; }

  .map-box {
    border-radius: 16px; overflow: hidden;
    border: 1px solid var(--line-soft);
  }
  .d-map { height: 240px; width: 100%; z-index: 1; }

  .detail-actions {
    margin-top: 18px;
    display: flex; flex-direction: column; gap: 9px;
  }
  .detail-actions .btn { height: 50px; }
  .share-url-box {
    font-size: 12.5px; color: var(--muted);
    background: var(--card-soft);
    border-radius: 10px;
    padding: 10px 12px;
    word-break: break-all;
  }

  .error-state {
    padding: 70px 24px;
    display: flex; flex-direction: column; align-items: center; gap: 12px;
    text-align: center;
  }
  .error-title { font-family: var(--serif); font-size: 22px; color: var(--ink); }
  .error-msg { color: var(--muted); font-size: 14px; }
</style>
