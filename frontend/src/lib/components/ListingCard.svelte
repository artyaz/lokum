<script>
  import Icon from '../icons/Icon.svelte';
  import { api } from '../api';
  import { user } from '../store';
  import { navigate } from '../router';
  import { onMount, onDestroy } from 'svelte';
  import {
    starredPois,
    initStarredPois,
    toggleStarPoi,
    matchPoiAgainstStarred,
    formatDistance
  } from '../pois';

  export let listing;

  let currentImage = 0;
  let saving = false;

  $: images = listing.images || [];
  $: imgCount = images.length;

  // Task E: total monthly + breakdown chips. The fees object comes from
  // normalizeFees() in listings-helpers.js (server-side). Falls back to the
  // legacy totalEstimate/totalBreakdown fields when a stale feedCache entry
  // from before Task E is rendered.
  $: fees = listing.fees || listing.totalBreakdown || null;
  $: totalMonthly = listing.totalMonthly ?? listing.totalEstimate ?? null;

  // Build the chip list from the normalized fees shape. Handles both the
  // new shape {rent, admin_fee, utilities, parking, extras:[{name, amount}]}
  // and the legacy shape {items:[{label, amount_pln, ...}]} (for stale caches).
  function chipFmt(n) {
    if (n == null) return '';
    return n.toLocaleString('pl-PL').replace(/,/g, ' ') + ' zł';
  }

  $: feeChips = (() => {
    if (!fees) return [];
    const out = [];
    // New shape: explicit buckets
    if ('rent' in fees || 'admin_fee' in fees) {
      const rent = fees.rent != null ? fees.rent : listing.price;
      out.push({ label: 'Rent', fmt: chipFmt(rent), isRent: true });
      if (fees.admin_fee != null) out.push({ label: 'Admin fee', fmt: chipFmt(fees.admin_fee) });
      if (fees.utilities != null) out.push({ label: 'Utilities', fmt: chipFmt(fees.utilities) });
      if (fees.parking != null) out.push({ label: 'Parking', fmt: chipFmt(fees.parking) });
      if (Array.isArray(fees.extras)) {
        for (const e of fees.extras) {
          if (e && e.amount > 0) out.push({ label: e.name || 'Fee', fmt: chipFmt(e.amount) });
        }
      }
      return out;
    }
    // Legacy shape: items[]
    if (Array.isArray(fees.items)) {
      for (const it of fees.items) {
        const amt = it.amount_pln != null ? it.amount_pln : it.amount;
        if (amt > 0) out.push({ label: it.label || it.name || 'Fee', fmt: chipFmt(amt) });
      }
      return out;
    }
    return [];
  })();

  // ============================================================
  // Task F: POI chips — lazy-fetched when the card scrolls into view.
  // ------------------------------------------------------------
  // The backend route GET /api/listings/:id/pois returns POIs around
  // the listing's lat/lng (Google Maps Places API, cached for 30 days
  // at a ~1m grid in the poi_cache table). Each POI comes back with a
  // `starred: boolean` flag computed at fetch time by matching against
  // the user's starred_pois rows (place_id exact, else name+coords
  // within 50m). The global `starredPois` Svelte store (lib/pois.js)
  // is the cross-card sync layer: a star tap on this card optimistically
  // updates the store, every other card with the same POI re-derives
  // its starred flag locally without a round-trip.
  // ============================================================
  let pois = [];
  let poisLoaded = false;
  let poisLoading = false;
  let poisError = '';
  let poiCardEl = null;
  let poiObserver = null;

  // Subscribe to the global starred-POI store so chip states stay in sync
  // across all visible cards (e.g. star on card A → immediately the same
  // POI chip on card B flips to filled).
  let starred = [];
  const unsubStarred = starredPois.subscribe(s => { starred = s || []; });
  // Kick off the one-time global fetch of the starred list. Safe to call
  // repeatedly — initStarredPois dedupes via the inFlight promise.
  initStarredPois();

  // The 4-6 most relevant chips for the card (one per category, then
  // nearest-fill). Computed reactively from `pois` + `starred`.
  $: poiChips = (() => {
    if (!pois.length) return [];
    // Derive the live starred flag from the global store (handles
    // cross-card updates that happened AFTER our pois were fetched).
    const withStar = pois.map(p => {
      const m = matchPoiAgainstStarred(p, starred);
      return m ? { ...p, starred: true, starred_id: m.id } : { ...p, starred: false, starred_id: null };
    });
    // Pick one per category first (nearest within each category).
    const byType = new Map();
    for (const p of withStar) {
      const cur = byType.get(p.type);
      if (!cur || (p.distance_m || 0) < (cur.distance_m || 0)) byType.set(p.type, p);
    }
    // Starred entries always surface, even if not the nearest in category.
    const starredSet = new Set();
    for (const p of withStar) {
      if (p.starred) starredSet.add(p.type);
    }
    const picked = new Map(byType);
    // Top up to 6 chips total using nearest leftover POIs (any type).
    const leftovers = withStar
      .filter(p => !picked.has(p.type) || (picked.get(p.type) !== p && p.starred))
      .sort((a, b) => (a.distance_m || 0) - (b.distance_m || 0));
    for (const p of leftovers) {
      if (picked.size >= 6) break;
      // Don't duplicate the exact POI already picked.
      if ([...picked.values()].some(x => x === p)) continue;
      picked.set(`${p.type}:${p.name}:${p.lat}`, p);
    }
    return [...picked.values()]
      .sort((a, b) => {
        // starred first, then by distance
        if (a.starred !== b.starred) return a.starred ? -1 : 1;
        return (a.distance_m || 0) - (b.distance_m || 0);
      })
      .slice(0, 6)
      .map(p => ({
        ...p,
        id: p.place_id || `${p.name}|${p.lat}|${p.lng}`,
        label: `${p.name} · ${formatDistance(p.distance_m)}`,
        iconName: p.type === 'restaurant' ? 'restaurant' : p.type
      }));
  })();

  async function loadPois() {
    if (poisLoaded || poisLoading) return;
    // Skip cards without coords — backend would return [] anyway and we
    // avoid a wasted round-trip.
    if (listing.lat == null || listing.lng == null) {
      poisLoaded = true;
      return;
    }
    poisLoading = true;
    poisError = '';
    try {
      const r = await api.listingPois(listing.id);
      pois = r.pois || [];
      poisLoaded = true;
    } catch (e) {
      poisError = e?.message || 'POIs failed';
      // Don't set poisLoaded so a future re-intersect retries? No — set
      // it to avoid hammering the API on every scroll. The error stays
      // in poisError so we can show a small "unavailable" hint if needed.
      poisLoaded = true;
    } finally {
      poisLoading = false;
    }
  }

  function setupPoiObserver() {
    if (poiObserver || !poiCardEl) return;
    // rootMargin: start the fetch 600px before the card enters the viewport
    // so chips are ready by the time the user actually sees the card.
    poiObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          loadPois();
          // No disconnect — once loaded, future intersects are no-ops.
        }
      }
    }, { rootMargin: '600px 0px' });
    poiObserver.observe(poiCardEl);
  }

  onMount(() => {
    // Defer observer setup to next tick so the bound element exists.
    setTimeout(setupPoiObserver, 0);
  });
  onDestroy(() => {
    if (poiObserver) { poiObserver.disconnect(); poiObserver = null; }
    unsubStarred && unsubStarred();
  });

  async function togglePoiStar(e, poi) {
    e?.stopPropagation();
    try {
      await toggleStarPoi(poi);
    } catch {
      // toggleStarPoi reverts the store on failure; nothing else to do.
    }
  }

  function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    const d = Math.floor(h / 24);
    return d + 'd ago';
  }

  async function toggleSave(e) {
    e?.stopPropagation();
    if (!$user || saving) return;
    saving = true;
    try {
      if (listing.saved) { await api.unsave(listing.id); listing = { ...listing, saved: false }; }
      else { await api.save(listing.id); listing = { ...listing, saved: true }; }
    } catch {} finally { saving = false; }
  }

  function openDetail() {
    navigate('/listing/' + listing.id);
  }

  function prevImage(e) {
    e?.stopPropagation();
    if (imgCount > 0) currentImage = (currentImage - 1 + imgCount) % imgCount;
  }
  function nextImage(e) {
    e?.stopPropagation();
    if (imgCount > 0) currentImage = (currentImage + 1) % imgCount;
  }

  // Horizontal swipe changes photo; vertical gesture keeps scrolling the
  // page (touch-action: pan-y lets the browser own the vertical axis).
  let pressX = 0, pressY = 0, tracking = false, axis = null;
  function onPointerDown(e) {
    pressX = e.clientX; pressY = e.clientY; tracking = true; axis = null;
  }
  function onPointerUp(e) {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - pressX;
    const dy = e.clientY - pressY;
    if (axis === 'y') return;                    // was a vertical scroll
    if (Math.abs(dx) > 32 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) nextImage(); else prevImage();
    }
  }
  function onPointerMove(e) {
    if (!tracking || axis) return;
    const dx = Math.abs(e.clientX - pressX);
    const dy = Math.abs(e.clientY - pressY);
    if (dx > 8 || dy > 8) axis = dy > dx ? 'y' : 'x';
  }
  function onCarouselClick(e) {
    if (axis === 'x') { axis = null; return; }   // swipe, not a tap
    openDetail();
  }

  function openSource(e) {
    e?.stopPropagation();
    if (listing.url) window.open(listing.url, '_blank', 'noopener');
  }

  function openMaps(e) {
    e?.stopPropagation();
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

<article class="card listing-card" bind:this={poiCardEl}>
  <div
    class="carousel-wrap"
    on:click={onCarouselClick}
    on:pointerdown={onPointerDown}
    on:pointerup={onPointerUp}
    on:pointercancel={() => (tracking = false)}
    role="link"
    tabindex="0"
    on:keydown={(e) => e.key === 'Enter' && openDetail()}
  >
    <div class="carousel">
      {#if imgCount > 0}
        <img src={images[currentImage]} alt={listing.title} loading="lazy" decoding="async" draggable="false" />
      {:else}
        <div class="no-img">
          <Icon name="location" size={40} color="#B7B1A4" />
        </div>
      {/if}
      {#if imgCount > 1}
        <button class="car-arrow car-prev" on:click={prevImage} aria-label="Previous photo">
          <Icon name="chevron-down" size={18} color="#201E1B" stroke={2.4} />
        </button>
        <button class="car-arrow car-next" on:click={nextImage} aria-label="Next photo">
          <Icon name="chevron-down" size={18} color="#201E1B" stroke={2.4} />
        </button>
      {/if}
    </div>

    <div class="top-row">
      <div class="top-left">
        {#if listing.isNew}
          <span class="badge-new">NEW TODAY</span>
        {/if}
      </div>
      <button class="save-btn" on:click={toggleSave} aria-label="Save">
        {#if listing.saved}
          <Icon name="heart-filled" size={20} color="#C15F3C" stroke={0} />
        {:else}
          <Icon name="heart" size={20} color="#4A473F" />
        {/if}
      </button>
    </div>

    {#if imgCount > 1}
      <div class="dots">
        {#each images as _, i}
          <span class="dot" class:active={i === currentImage}></span>
        {/each}
      </div>
    {/if}

    {#if listing.source?.name}
      <div class="source-badge" style="color:{listing.source.color}">{listing.source.name}</div>
    {/if}
  </div>

  <!-- Task F: POI chips. Lazy-fetched when the card scrolls into view via
       IntersectionObserver (rootMargin 600px). 4-6 chips, one per category
       (restaurant/store/gym/shopping_mall/park) plus nearest-fill if a
       category was empty. Starred POIs bubble to the front. Each chip's
       star tap calls toggleStarPoi which optimistically updates the global
       `starredPois` Svelte store (lib/pois.js) so every other card with the
       same POI (matched by place_id or name+coords) re-renders immediately.
       on:click|stopPropagation so the chip tap does NOT navigate to detail. -->
  {#if poiChips.length}
    <div class="poi-chips">
      {#each poiChips as poi (poi.id)}
        <button
          class="poi-chip"
          class:poi-starred={poi.starred}
          on:click|stopPropagation={(e) => togglePoiStar(e, poi)}
          aria-label={`${poi.starred ? 'Unstar' : 'Star'} ${poi.name}`}
          title={poi.address || poi.name}
        >
          <Icon name={poi.iconName} size={13} stroke={1.7} />
          <span class="poi-label">{poi.label}</span>
          <Icon name={poi.starred ? 'star' : 'star-outline'} size={11}
                color={poi.starred ? '#D6A419' : '#9A9488'} stroke={0} />
        </button>
      {/each}
    </div>
  {/if}

  <div class="body">
    <!--
      Task E: prominent total monthly price + compact breakdown chips.
      The fees object comes back from /api/listings as `fees` (the normalized
      shape from services/totalprice.js -> listings-helpers.js#normalizeFees).
      Falls back to the legacy totalEstimate/totalBreakdown fields when a stale
      feedCache entry from before the Task E swap is rendered.
    -->
    {#if totalMonthly && totalMonthly !== listing.price}
      <div class="total-block" on:click={openDetail} role="link" tabindex="0">
        <span class="total-big">≈ {fmt(totalMonthly)}</span>
        <span class="total-unit">zł/mo</span>
        <span class="total-sub">all-in incl. fees</span>
      </div>
    {:else}
      <div class="price-row">
        <span class="price">{listing.priceLabel}</span>
        <span class="posted">{timeAgo(listing.firstSeenAt || listing.postedAt)}</span>
      </div>
    {/if}

    {#if feeChips.length}
      <div class="fee-chips">
        {#each feeChips as chip}
          <span class="fee-chip" class:fee-chip-rent={chip.isRent}>
            <span class="fc-label">{chip.label}</span>
            <span class="fc-amount">{chip.isRent ? '' : '+'}{chip.fmt}</span>
          </span>
        {/each}
      </div>
    {:else if totalMonthly && totalMonthly !== listing.price}
      <!-- total exists but no breakdown to show; surface the advertised rent
           inline so the user sees what the total is composed of -->
      <div class="fee-chips">
        <span class="fee-chip fee-chip-rent">
          <span class="fc-label">Rent</span>
          <span class="fc-amount">{fmt(listing.price)}</span>
        </span>
      </div>
    {/if}

    <div class="title" on:click={openDetail} role="link" tabindex="0">{listing.title}</div>
    <div class="meta">
      <Icon name="location" size={14} color="#9A9488" stroke={1.7} />
      <span>{listing.district || listing.city?.name}, {listing.city?.name} · {listing.rooms || '?'} rooms · {listing.area || '?'} m²{#if listing.floor} · floor {listing.floor}{/if}</span>
    </div>

    {#if listing.conveniences?.length}
      <div class="conv">
        {#each listing.conveniences.slice(0, 4) as c}
          <span class="conv-chip" class:region-chip={c.type === 'region'}>
            <Icon name={c.type} size={13} stroke={1.7} />
            {c.label}
          </span>
        {/each}
      </div>
    {/if}

    <div class="actions">
      <button class="action-btn primary" on:click={openDetail}>
        <Icon name="external" size={16} stroke={1.8} />
        View listing
      </button>
      <button class="action-btn" on:click={openSource}>
        {listing.source?.name || 'Source'}
      </button>
      <button class="action-btn action-map" on:click={openMaps} aria-label="Open in Google Maps">
        <Icon name="map" size={16} stroke={1.8} />
      </button>
    </div>
  </div>
</article>

<style>
  /* content-visibility: the browser fully skips layout/paint for cards
     outside the viewport. Scroll height stays correct (intrinsic size),
     so this gives virtualization-like speed with zero scroll glitches. */
  .listing-card {
    content-visibility: auto;
    /* close to the real rendered height so restored scroll positions land
       accurately before the card is laid out for the first time. Bumped
       ~40px for the Task E fee-chips row, then +28px more for the Task F
       POI chips row below the image (one row of 24px chips + 8px margin). */
    contain-intrinsic-size: auto 608px;
    /* Flex column so the .body region grows and the .actions row sticks
       to the bottom of the card — matches the height of the tallest card
       in the same grid row (grid align-items: stretch). */
    display: flex;
    flex-direction: column;
  }
  .carousel-wrap {
    position: relative;
    background: var(--card-soft);
    cursor: pointer;
    touch-action: pan-y;
  }
  .carousel {
    position: relative;
    aspect-ratio: 4/3;
    background: var(--card-soft);
    user-select: none;
    -webkit-user-select: none;
    overflow: hidden;
  }
  .carousel > img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .no-img {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .car-arrow {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: rgba(255,255,255,.9);
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    opacity: 0;
    transition: opacity .15s;
  }
  .carousel-wrap:hover .car-arrow { opacity: 1; }
  @media (hover: none) {
    .car-arrow { display: none; }
  }
  .car-prev { left: 10px; }
  .car-prev :global(svg) { transform: rotate(90deg); }
  .car-next { right: 10px; }
  .car-next :global(svg) { transform: rotate(-90deg); }
  .top-row {
    position: absolute;
    top: 12px;
    left: 12px;
    right: 12px;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    pointer-events: none;
  }
  .top-left, .save-btn { pointer-events: auto; }
  .badge-new {
    height: 26px;
    padding: 0 10px;
    border-radius: 13px;
    background: rgba(193, 95, 60, .95);
    color: var(--accent-ink);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: .02em;
    display: inline-flex;
    align-items: center;
  }
  .save-btn {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: rgba(255, 255, 255, .92);
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
  }
  .dots {
    position: absolute;
    bottom: 12px;
    left: 0;
    right: 0;
    display: flex;
    justify-content: center;
    gap: 5px;
    pointer-events: none;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: rgba(255, 255, 255, .55);
    transition: all .15s;
  }
  .dot.active {
    width: 7px;
    height: 7px;
    background: #fff;
  }
  .source-badge {
    position: absolute;
    bottom: 11px;
    right: 12px;
    height: 24px;
    padding: 0 9px;
    border-radius: 7px;
    background: rgba(255, 255, 255, .94);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: .04em;
    display: flex;
    align-items: center;
    pointer-events: none;
  }
  .body {
    padding: 15px 16px 17px;
    /* Grow to fill the card height (grid stretches cards to match the
       tallest sibling). The .actions row below gets margin-top:auto so
       the buttons land on the same baseline across all cards in a row,
       regardless of how many POI/fee/convenience chips the card has. */
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
  }

  /* Task F: POI chips below the image. Mirrors `.fee-chips` wrapping
     pattern (flex; flex-wrap: wrap; gap). Lives between .carousel-wrap
     and .body so the chips stay anchored to the image visually. */
  .poi-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 10px 12px 0;
    margin: 0;
  }
  .poi-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 28px;
    padding: 0 10px;
    border-radius: 9px;
    border: 1px solid transparent;
    background: #F5F2EA;
    font-size: 12px;
    font-weight: 500;
    color: #5B574E;
    cursor: pointer;
    line-height: 1;
    transition: background .12s, border-color .12s;
  }
  .poi-chip:hover {
    background: #EFE9DA;
  }
  .poi-chip.poi-starred {
    background: #FFF6E0;
    border-color: #E8C766;
    color: #8A6512;
    font-weight: 600;
  }
  .poi-chip .poi-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 140px;
  }
  .price-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 5px;
  }
  .price {
    font-family: var(--serif);
    font-size: 22px;
    font-weight: 600;
    color: var(--ink);
  }
  /* Task E: prominent total monthly + compact breakdown chips */
  .total-block {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 4px 6px;
    margin-bottom: 8px;
    cursor: pointer;
    line-height: 1.15;
  }
  .total-block:hover .total-big { color: var(--accent); }
  .total-big {
    font-family: var(--serif);
    font-size: 26px;
    font-weight: 700;
    color: var(--ink);
    letter-spacing: -.01em;
  }
  .total-unit {
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
  }
  .total-sub {
    flex-basis: 100%;
    font-size: 12px;
    color: var(--muted-2);
    font-weight: 500;
    margin-top: -2px;
  }
  .fee-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin: 0 0 10px;
  }
  .fee-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 5px;
    height: 24px;
    padding: 0 9px;
    border-radius: 7px;
    background: #F1ECE2;
    font-size: 11.5px;
    font-weight: 600;
    color: #5B574E;
    line-height: 1;
  }
  .fee-chip-rent {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .fee-chip .fc-label {
    font-weight: 500;
    color: inherit;
    opacity: .85;
  }
  .fee-chip .fc-amount {
    font-weight: 700;
  }
  .posted {
    font-size: 13px;
    color: var(--muted-2);
    flex: none;
  }
  .title {
    font-size: 15px;
    font-weight: 600;
    color: #2E2B26;
    line-height: 1.35;
    margin-bottom: 5px;
    cursor: pointer;
  }
  .title:hover { color: var(--accent); }
  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13.5px;
    color: var(--muted);
    margin-bottom: 12px;
  }
  .conv {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 14px;
  }
  .conv-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 28px;
    padding: 0 11px;
    border-radius: 9px;
    background: #F5F2EA;
    font-size: 12.5px;
    font-weight: 500;
    color: #5B574E;
  }
  .region-chip {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }
  .actions {
    display: flex;
    gap: 8px;
    /* Push the button row to the bottom of the card so every card in a
       grid row has its buttons on the same baseline. Cards with fewer
       chips above leave whitespace between content and buttons; cards
       with many chips have buttons tight under them. */
    margin-top: auto;
  }
  .action-btn {
    flex: 1;
    height: 42px;
    border-radius: 12px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink);
    font-size: 14px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    cursor: pointer;
  }
  .action-btn:hover { background: #FAF9F5; }
  .action-btn.primary {
    background: var(--ink);
    color: var(--bg);
    border-color: var(--ink);
    flex: 2;
  }
  .action-btn.primary:hover { background: #2c2823; }
  .action-map { flex: none; width: 46px; }
</style>
