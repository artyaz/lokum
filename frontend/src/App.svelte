<script>
  import { onMount } from 'svelte';
  import { api } from './lib/api';
  import { user, booting } from './lib/store';
  import { route, navigate } from './lib/router';
  import Icon from './lib/icons/Icon.svelte';

  import Login from './routes/Login.svelte';
  import Signup from './routes/Signup.svelte';
  import PasskeySetup from './routes/PasskeySetup.svelte';
  import PasskeyLogin from './routes/PasskeyLogin.svelte';
  import Feed from './routes/Feed.svelte';
  import Filters from './routes/Filters.svelte';
  import Saved from './routes/Saved.svelte';
  import Settings from './routes/Settings.svelte';
  import Regions from './routes/Regions.svelte';
  import ListingDetail from './routes/ListingDetail.svelte';
  import PublicShare from './routes/PublicShare.svelte';
  import Duplicates from './routes/Duplicates.svelte';
  import Import from './routes/Import.svelte';
  // Task G — dedicated cron editor route. Settings has a quick toggle,
  // /crons is the full inline schedule editor with run-now + next-runs.
  import Crons from './routes/Crons.svelte';

  import { initStarredPois } from './lib/pois';

  const PUBLIC_ROUTES = ['/login', '/signup', '/passkey-login'];

  onMount(async () => {
    try {
      const r = await api.me();
      user.set(r.user);
    } catch (e) {
      user.set(null);
    } finally {
      booting.set(false);
    }
    // Task F: prefetch the user's starred-POI list once the session is
    // resolved (or once we know there's no session — single-user mode
    // still works with user_id=NULL). Safe to call repeatedly — the
    // promise dedupes inside lib/pois.js#initStarredPois.
    try { await initStarredPois(); } catch {}
  });

  $: path = $route.path;
  $: isShare = path.startsWith('/s/');
  $: shareToken = isShare ? path.slice(3) : null;
  $: isListing = path.startsWith('/listing/');
  $: listingId = isListing ? path.slice(9) : null;
  $: isPublic = PUBLIC_ROUTES.includes(path) || isShare;
  $: showBar = !isShare && !PUBLIC_ROUTES.includes(path) && !$booting && !!$user;

  // Route guard
  $: if (!$booting && !isPublic && !$user) {
    navigate('/login');
  }
  $: if (!$booting && PUBLIC_ROUTES.includes(path) && $user && path !== '/passkey-setup') {
    navigate('/feed');
  }

  function currentScreen() {
    switch (path) {
      case '/login': return Login;
      case '/signup': return Signup;
      case '/passkey-setup': return PasskeySetup;
      case '/passkey-login': return PasskeyLogin;
      case '/feed': return Feed;
      case '/filters': return Filters;
      case '/saved': return Saved;
      case '/settings': return Settings;
      case '/regions': return Regions;
      case '/duplicates': return Duplicates;
      case '/import': return Import;
      case '/crons': return Crons;
      default: return Feed;
    }
  }
</script>

<div class="app-shell">
  {#if $booting}
    <div class="boot">
      <div class="boot-logo"><Icon name="map" size={32} color="#FAF9F5" stroke={1.9} /></div>
      <div class="boot-name">Lokum</div>
    </div>
  {:else if isShare}
    <div class="app-frame">
      <PublicShare token={shareToken} />
    </div>
  {:else if isPublic || $user}
    {#if showBar}
      <nav class="app-bar">
        <div class="app-bar-inner">
          <button class="brand" on:click={() => navigate('/feed')}>Lokum</button>
          <div class="app-bar-actions">
            <button class="icon-btn" class:nav-active={path === '/regions'} on:click={() => navigate('/regions')} aria-label="Regions" title="Regions">
              <Icon name="map" size={20} color="#201E1B" />
            </button>
            <button class="icon-btn" class:nav-active={path === '/saved'} on:click={() => navigate('/saved')} aria-label="Saved" title="Saved">
              <Icon name="heart" size={20} color="#201E1B" />
            </button>
            <button class="icon-btn icon-btn-soft" class:nav-active={path === '/settings'} on:click={() => navigate('/settings')}
              style="font-family:var(--serif);font-size:17px;color:var(--accent);font-weight:600;" aria-label="Settings" title="Settings">
              {$user?.name?.[0] || 'A'}
            </button>
          </div>
        </div>
      </nav>
    {/if}

    <div class="app-frame">
      {#if isListing}
        <ListingDetail id={listingId} />
      {:else}
        {#key path}
          <svelte:component this={currentScreen()} />
        {/key}
      {/if}
    </div>
  {:else}
    <div class="boot">
      <div class="boot-logo"><Icon name="map" size={32} color="#FAF9F5" stroke={1.9} /></div>
    </div>
  {/if}
</div>

<style>
  .boot {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
  }
  .boot-logo {
    width: 64px; height: 64px;
    border-radius: 18px;
    background: var(--accent);
    display: flex; align-items: center; justify-content: center;
    animation: pulse-soft 2.5s ease-in-out infinite;
  }
  .boot-name {
    font-family: var(--serif);
    font-size: 26px;
    font-weight: 600;
    color: var(--ink);
  }
  .nav-active {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
</style>
