// Global POI store (Task F).
//
// The starred-POI list is shared across every ListingCard on the feed:
// tapping the star on a Żabka chip on card A should immediately mark
// the same Żabka as starred on card B (matched by place_id when
// Google-sourced, else by name + coords within 50m).
//
// To keep that consistent without refetching every card, we hold the
// canonical starred list in a Svelte writable here. The backend's
// GET /api/listings/:id/pois already returns each POI with a `starred`
// flag computed at fetch time — this store is the cross-card sync
// layer for AFTER a toggle.
//
// `matchPoiAgainstStarred(poi, starred)` mirrors the backend matcher
// in services/pois.js#matchStarred so the client can re-derive the
// starred flag locally without a round-trip.

import { writable, get } from 'svelte/store';
import { api } from './api';

export const starredPois = writable([]);
export const starredLoaded = writable(false);

let inFlight = null;

export async function initStarredPois() {
  if (get(starredLoaded)) return;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const r = await api.starredPois();
      starredPois.set(r.starred || []);
    } catch {
      // Public / unauthenticated context — no starred list to load.
      starredPois.set([]);
    } finally {
      starredLoaded.set(true);
      inFlight = null;
    }
  })();
  return inFlight;
}

// Haversine in meters — small-distance precision is fine for the 50m
// matcher; the backend uses the same formula. Exported so a card can
// compute distance labels without re-fetching.
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function formatDistance(m) {
  if (m == null || !Number.isFinite(m)) return '';
  if (m < 1000) return Math.round(m / 10) * 10 + 'm';
  const km = m / 1000;
  return (km >= 10 ? Math.round(km) : km.toFixed(1)) + 'km';
}

// Mirrors backend matcher (services/pois.js#matchStarred):
//   1. Exact place_id match (Google-sourced both sides).
//   2. Same name (lowercased, trimmed) + Haversine <= 50m.
export function matchPoiAgainstStarred(poi, starred) {
  if (!poi || !Array.isArray(starred) || !starred.length) return null;
  for (const s of starred) {
    if (poi.place_id && s.place_id && poi.place_id === s.place_id) return s;
  }
  if (!poi.name) return null;
  const nameLower = String(poi.name).toLowerCase().trim();
  for (const s of starred) {
    if (!s.name) continue;
    if (String(s.name).toLowerCase().trim() !== nameLower) continue;
    const d = haversineMeters(poi.lat, poi.lng, s.lat, s.lng);
    if (d <= 50) return s;
  }
  return null;
}

export function isStarred(poi, starred) {
  return matchPoiAgainstStarred(poi, starred) != null;
}

// Toggle a POI's starred state. Optimistically updates the store, then
// calls the API. On failure, reverts (the chip flips back).
export async function toggleStarPoi(poi) {
  let prev;
  let wasStarred;
  starredPois.update(s => {
    prev = s;
    wasStarred = isStarred(poi, s);
    if (wasStarred) {
      // remove: filter by matchPoiAgainstStarred result
      return s.filter(x => {
        if (poi.place_id && x.place_id === poi.place_id) return false;
        if (poi.name && x.name === poi.name) {
          const d = haversineMeters(poi.lat, poi.lng, x.lat, x.lng);
          if (d <= 50) return false;
        }
        return true;
      });
    }
    // add
    return [
      ...s,
      {
        id: null, // filled by backend
        user_id: null,
        place_id: poi.place_id || null,
        name: poi.name,
        type: poi.type,
        lat: poi.lat,
        lng: poi.lng,
        address: poi.address || null,
        created_at: new Date().toISOString()
      }
    ];
  });

  try {
    if (wasStarred) {
      const r = await api.unstarPoi({
        starred_id: poi.starred_id || null,
        place_id: poi.place_id || null,
        name: poi.name,
        lat: poi.lat,
        lng: poi.lng
      });
      starredPois.set(r.starred || []);
    } else {
      const r = await api.starPoi({
        name: poi.name,
        type: poi.type,
        lat: poi.lat,
        lng: poi.lng,
        place_id: poi.place_id || null,
        address: poi.address || null
      });
      starredPois.set(r.starred || []);
    }
  } catch (e) {
    // Revert on failure.
    starredPois.set(prev);
    throw e;
  }
}
