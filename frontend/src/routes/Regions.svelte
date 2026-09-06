<script>
  import { onMount, onDestroy } from 'svelte';
  // leaflet CSS is imported dynamically inside initMap() so it lands in the
  // same lazy chunk as the leaflet JS — the user only pays the ~3 KB gzip
  // cost when they actually open the regions map. (Was: a top-level static
  // import which Vite hoisted into the main CSS bundle, paid on every page
  // load even for users who never visit /regions.)
  import { api } from '../lib/api';
  import { ui } from '../lib/store';
  import { navigate } from '../lib/router';
  import Icon from '../lib/icons/Icon.svelte';

  let cities = [];
  let regions = [];
  let loading = true;
  let error = '';

  // map state
  let mapEl;
  let map = null;
  let L = null;
  let city = null;

  // drawing state
  let drawing = false;
  let points = [];            // [[lat,lng], ...]
  let draftLayers = [];       // leaflet layers for the in-progress polygon
  let regionLayers = [];      // rendered existing polygons
  let saveName = '';
  let saveColor = '#C15F3C';
  let saving = false;
  let deleting = null;

  const COLORS = ['#C15F3C', '#0A6E68', '#A4133C', '#2C7A54', '#D6A419', '#4A6FA5', '#7B5EA7', '#B08968'];

  $: if (city && map) {
    map.setView([city.lat, city.lng], 12);
  }

  onMount(async () => {
    try {
      const cR = await api.cities();
      cities = cR.cities;
      city = cities.find(c => c.slug === $ui.citySlug) || cities[0];
      await Promise.all([loadRegions(), initMap()]);
    } catch (e) {
      error = e.message || 'Failed to load';
    } finally {
      loading = false;
    }
  });

  onDestroy(() => {
    if (map) { map.remove(); map = null; }
  });

  async function loadRegions() {
    const r = await api.regions(city?.slug);
    regions = r.regions || [];
    renderRegions();
  }

  async function initMap() {
    // Fetch leaflet JS + leaflet CSS in parallel — both land in the lazy
    // 'leaflet' chunk defined in vite.config.js#manualChunks.
    [L] = await Promise.all([
      import('leaflet').then(m => m.default),
      import('leaflet/dist/leaflet.css')
    ]);
    if (!mapEl || map) return;
    map = L.map(mapEl, {
      center: [city?.lat || 52.2297, city?.lng || 21.0122],
      zoom: 12,
      scrollWheelZoom: true,
      doubleClickZoom: false
    });
    // OpenStreetMap tiles explicitly allow overlays (their tile usage policy
    // permits overlaying your own data). Attribution is required and shown.
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }).addTo(map);
    renderRegions();
    map.on('click', onMapClick);
    map.on('dblclick', onMapDblClick);
  }

  function renderRegions() {
    if (!map || !L) return;
    for (const layer of regionLayers) map.removeLayer(layer);
    regionLayers = [];
    // Multiple regions may freely overlap — each is drawn semi-transparent so
    // overlapping areas stay visible and every region remains distinguishable.
    for (const r of regions) {
      const poly = r.polygon;
      if (!poly || poly.type !== 'Polygon') continue;
      const latlngs = poly.coordinates[0].map(([lng, lat]) => [lat, lng]);
      const layer = L.polygon(latlngs, {
        color: r.color,
        weight: 2,
        fillColor: r.color,
        fillOpacity: 0.18,
        opacity: 0.85
      }).addTo(map);
      layer.bindTooltip(r.name, { sticky: true });
      regionLayers.push(layer);
    }
  }

  function onMapClick(e) {
    if (!drawing) return;
    points = [...points, [e.latlng.lat, e.latlng.lng]];
    redrawDraft();
  }

  function onMapDblClick(e) {
    if (!drawing) return;
    // finish polygon (needs at least 3 points)
    if (points.length >= 3) {
      drawing = false;
      redrawDraft();
    }
  }

  function redrawDraft() {
    if (!map || !L) return;
    for (const layer of draftLayers) map.removeLayer(layer);
    draftLayers = [];
    for (const p of points) {
      draftLayers.push(L.circleMarker(p, {
        radius: 5, color: saveColor, weight: 2, fillColor: '#fff', fillOpacity: 1
      }).addTo(map));
    }
    if (points.length >= 2) {
      const ring = points.length >= 3 ? [...points, points[0]] : points;
      draftLayers.push(L.polygon(ring, {
        color: saveColor, weight: 2, dashArray: '6 5', fillColor: saveColor, fillOpacity: 0.12
      }).addTo(map));
    }
  }

  function startDrawing() {
    drawing = true;
    points = [];
    saveName = '';
    redrawDraft();
  }

  function cancelDrawing() {
    drawing = false;
    points = [];
    saveName = '';
    redrawDraft();
  }

  function undoPoint() {
    points = points.slice(0, -1);
    redrawDraft();
  }

  async function saveRegion() {
    if (points.length < 3 || !saveName.trim() || saving) return;
    saving = true;
    error = '';
    try {
      // GeoJSON: [lng, lat], closed ring
      const ring = [...points, points[0]].map(([lat, lng]) => [lng, lat]);
      await api.createRegion({
        name: saveName.trim(),
        color: saveColor,
        city_id: city.id,
        polygon: { type: 'Polygon', coordinates: [ring] }
      });
      cancelDrawing();
      await loadRegions();
    } catch (e) {
      error = e.message || 'Failed to save region';
    } finally {
      saving = false;
    }
  }

  async function removeRegion(r) {
    if (deleting) return;
    if (!confirm(`Delete region "${r.name}"?`)) return;
    deleting = r.id;
    try {
      await api.deleteRegion(r.id);
      await loadRegions();
    } catch (e) {
      error = e.message;
    } finally {
      deleting = null;
    }
  }

  async function pickCity(c) {
    city = c;
    ui.update(u => ({ ...u, citySlug: c.slug }));
    regions = [];
    await loadRegions();
  }
</script>

<div class="screen">
  <div class="sub-header">
    <button class="back-btn" on:click={() => navigate('/feed')}>
      <Icon name="back" size={18} color="#201E1B" />
    </button>
    <div class="sub-header-title">Regions</div>
    <div style="width:40px"></div>
  </div>

  <div class="scroll no-scrollbar">
    <div class="intro">
      <div class="intro-title">Draw regions on the map</div>
      <div class="intro-sub">Listings inside a region show its name in the feed. Regions can overlap freely — a listing can belong to several at once.</div>
    </div>

    <div class="city-row no-scrollbar">
      {#each cities as c}
        <button class="chip" class:chip-dark={city?.id === c.id} on:click={() => pickCity(c)}>{c.name}</button>
      {/each}
    </div>

    <div class="map-wrap">
      <div class="map" bind:this={mapEl}></div>
      {#if loading}
        <div class="map-loading">Loading map…</div>
      {/if}
      {#if !drawing && !points.length}
        <button class="draw-fab" on:click={startDrawing}>
          <Icon name="plus" size={16} color="#FDF6F1" stroke={2.2} />
          Draw region
        </button>
      {/if}
    </div>

    {#if drawing || points.length}
      <div class="drawing-panel fadein">
        {#if drawing}
          <div class="drawing-status">
            <span class="dot-pulse"></span>
            Drawing… {points.length} point{points.length === 1 ? '' : 's'} placed.
            <span class="hint">Click to add points, double-click to close the polygon.</span>
          </div>
          <div class="drawing-actions">
            <button class="btn btn-secondary btn-sm" on:click={undoPoint} disabled={!points.length}>Undo point</button>
            <button class="btn btn-secondary btn-sm" on:click={cancelDrawing}>Cancel</button>
          </div>
        {:else}
          <div class="save-form">
            <input class="input" bind:value={saveName} placeholder="Region name (e.g. Śródmieście)" />
            <div class="color-row">
              <span class="label-inline">Color:</span>
              {#each COLORS as c}
                <button
                  class="color-dot"
                  class:selected={saveColor === c}
                  style="background:{c}"
                  on:click={() => { saveColor = c; redrawDraft(); }}
                  aria-label="color {c}"
                ></button>
              {/each}
            </div>
            <div class="save-actions">
              <button class="btn btn-secondary" on:click={cancelDrawing}>Discard</button>
              <button class="btn btn-primary" on:click={saveRegion} disabled={!saveName.trim() || saving}>
                {saving ? 'Saving…' : 'Save region'}
              </button>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    {#if error}<div class="error-box">{error}</div>{/if}

    <div class="section-label" style="margin:22px 2px 11px">Your regions ({regions.length})</div>
    {#if regions.length}
      <div class="regions-list">
        {#each regions as r (r.id)}
          <div class="region-row">
            <span class="region-color" style="background:{r.color}"></span>
            <div class="region-name">{r.name}</div>
            <button class="icon-btn" on:click={() => removeRegion(r)} style="width:34px;height:34px;border-radius:10px">
              <Icon name="trash" size={15} color="#A4133C" />
            </button>
          </div>
        {/each}
      </div>
    {:else if !loading}
      <div class="empty-note">No regions yet — tap "Draw region" on the map.</div>
    {/if}
    <div style="height:20px"></div>
  </div>
</div>

<style>
  .scroll { padding: 6px 0 20px; }
  .intro { margin: 8px 2px 14px; }
  .intro-title { font-size: 15px; font-weight: 600; color: var(--ink); }
  .intro-sub { font-size: 13px; color: var(--muted); margin-top: 3px; line-height: 1.45; }
  .city-row {
    display: flex; gap: 8px; overflow-x: auto; margin-bottom: 12px;
  }
  .map-wrap {
    position: relative;
    border-radius: 18px;
    overflow: hidden;
    border: 1px solid var(--line-soft);
    background: var(--card-soft);
  }
  .map { height: 380px; width: 100%; z-index: 1; }
  .map-loading {
    position: absolute; inset: 0; z-index: 2;
    display: flex; align-items: center; justify-content: center;
    color: var(--muted); font-size: 14px; background: var(--card-soft);
  }
  .draw-fab {
    position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%);
    z-index: 500;
    display: inline-flex; align-items: center; gap: 7px;
    height: 44px; padding: 0 20px; border-radius: 22px;
    background: var(--accent); color: var(--accent-ink);
    font-size: 14.5px; font-weight: 600;
    box-shadow: 0 8px 24px -8px rgba(193,95,60,.55);
  }
  .drawing-panel {
    margin-top: 12px;
    background: var(--card);
    border: 1px solid var(--line-soft);
    border-radius: 16px;
    padding: 14px 16px;
  }
  .drawing-status {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    font-size: 14px; color: var(--ink); font-weight: 500;
  }
  .drawing-status .hint {
    width: 100%; font-size: 12.5px; color: var(--muted-2); font-weight: 400;
  }
  .dot-pulse {
    width: 9px; height: 9px; border-radius: 50%; background: var(--accent);
    animation: pulse-soft 1.4s ease-in-out infinite;
  }
  .drawing-actions { display: flex; gap: 8px; margin-top: 12px; }
  .btn-sm { height: 40px; font-size: 14px; padding: 0 14px; }
  .save-form .input { margin-bottom: 12px; }
  .color-row {
    display: flex; align-items: center; gap: 9px; margin-bottom: 14px;
  }
  .label-inline { font-size: 13px; color: var(--muted); font-weight: 500; }
  .color-dot {
    width: 26px; height: 26px; border-radius: 50%;
    border: 2px solid transparent; cursor: pointer; flex: none;
  }
  .color-dot.selected { border-color: var(--ink); }
  .save-actions { display: flex; gap: 8px; }
  .save-actions .btn { flex: 1; height: 46px; }
  .error-box {
    margin-top: 12px;
    background: var(--otodom-soft); color: var(--otodom);
    font-size: 13px; padding: 10px 12px; border-radius: 10px;
  }
  .regions-list {
    background: var(--card);
    border: 1px solid var(--line-soft);
    border-radius: 16px;
    overflow: hidden;
  }
  .region-row {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 14px;
    border-bottom: 1px solid #F1ECE2;
  }
  .region-row:last-child { border-bottom: none; }
  .region-color {
    width: 16px; height: 16px; border-radius: 5px; flex: none;
  }
  .region-name { flex: 1; font-size: 14.5px; font-weight: 500; color: var(--ink); }
  .empty-note {
    text-align: center; color: var(--muted-2); font-size: 13.5px; padding: 18px;
  }
</style>
