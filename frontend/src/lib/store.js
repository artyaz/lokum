import { writable } from 'svelte/store';

// Persisted UI state (city, date filter, max price)
const LS_KEY = 'lokum_ui_v1';
const initial = (() => {
  try {
    const s = localStorage.getItem(LS_KEY);
    if (s) return JSON.parse(s);
  } catch {}
  return {
    citySlug: 'warsaw',
    maxPrice: 6000,
    runId: null  // selected cron run; null = latest
  };
})();

export const ui = writable(initial);
ui.subscribe(v => {
  try { localStorage.setItem(LS_KEY, JSON.stringify(v)); } catch {}
});

// User store
export const user = writable(null); // { id, email, name, hasPasskey }

// Loading flags
export const booting = writable(true);
