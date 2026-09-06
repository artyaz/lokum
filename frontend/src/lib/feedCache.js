// Module-level cache of the feed's loaded state.
// Navigating feed -> listing -> back must be instant: no refetch, no
// skeleton flash, scroll where you left it. The cache survives route
// changes (components unmount) and is only invalidated when filters
// change or the data goes stale.

const TTL = 5 * 60 * 1000; // 5 minutes

export const feedCache = {
  filtersKey: null,      // JSON of {citySlug, maxPrice, runId}
  listings: [],
  count: 0,
  offset: 0,
  hasMore: true,
  fetchedAt: 0,
  meta: null             // { cities, sources, runs, dupCount, updatedLabel }
};

export function filtersKeyOf(ui) {
  return JSON.stringify({ city: ui.citySlug, maxPrice: ui.maxPrice, runId: ui.runId || null });
}

export function feedFresh(ui) {
  return (
    feedCache.filtersKey === filtersKeyOf(ui) &&
    feedCache.fetchedAt > 0 &&
    Date.now() - feedCache.fetchedAt < TTL
  );
}

export function invalidateFeed() {
  feedCache.filtersKey = null;
  feedCache.listings = [];
  feedCache.count = 0;
  feedCache.offset = 0;
  feedCache.hasMore = true;
  feedCache.fetchedAt = 0;
  feedCache.meta = null;
}
