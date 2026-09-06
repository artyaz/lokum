<script>
  import { api } from '../lib/api';
  import { user } from '../lib/store';
  import { navigate } from '../lib/router';
  import Icon from '../lib/icons/Icon.svelte';
  import { startAuthentication } from '@simplewebauthn/browser';

  let loading = false;
  let error = '';

  async function passkeyLogin() {
    error = '';
    loading = true;
    try {
      const opts = await api.passkeyLoginOptions();
      const asseResp = await startAuthentication({ optionsJSON: opts });
      const r = await api.passkeyLoginVerify(asseResp);
      user.set(r.user);
      navigate('/feed');
    } catch (e) {
      if (e?.name !== 'AbortError') {
        error = e.message || 'Passkey sign-in failed.';
      }
    } finally {
      loading = false;
    }
  }

  // Try immediately on mount
  import { onMount } from 'svelte';
  onMount(() => { passkeyLogin(); });
</script>

<div class="screen">
  <div class="top">
    <button class="back-btn" on:click={() => navigate('/login')}>
      <Icon name="back" size={18} color="#201E1B" />
    </button>
  </div>
  <div class="content">
    <div class="avatar">{$user?.name?.[0] || 'A'}</div>
    <h1>Welcome back, {$user?.name?.split(' ')[0] || 'Anna'}</h1>
    <p class="email">{$user?.email || 'anna@lokum.pl'}</p>
    <button class="orb" on:click={passkeyLogin} disabled={loading}>
      <Icon name="passkey" size={58} color="#FDF6F1" stroke={1.6} />
    </button>
    <p class="hint">{loading ? 'Waiting for passkey…' : 'Tap to sign in with your passkey'}</p>
    {#if error}<div class="error">{error}</div>{/if}
  </div>
  <button class="btn btn-ghost btn-full" on:click={() => navigate('/login')}>Use password instead</button>
</div>

<style>
  .screen {
    padding: 8px 28px 36px;
    text-align: center;
    display: flex;
    flex-direction: column;
  }
  .top { padding: 6px 0; display: flex; }
  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .avatar {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: var(--card-soft);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 18px;
    font-family: var(--serif);
    font-size: 26px;
    color: var(--accent);
  }
  h1 {
    font-family: var(--serif);
    font-weight: 500;
    font-size: 30px;
    line-height: 1.12;
    color: var(--ink);
    margin: 0 0 6px;
  }
  .email {
    font-size: 15px;
    color: var(--muted);
    margin: 0 0 42px;
  }
  .orb {
    width: 120px;
    height: 120px;
    border-radius: 50%;
    background: var(--accent);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: 0 18px 40px -14px rgba(193, 95, 60, .7);
    border: none;
    transition: transform .12s;
  }
  .orb:active { transform: scale(.95); }
  .orb:disabled { opacity: .8; }
  .hint {
    font-size: 14px;
    color: var(--muted-2);
    margin: 20px 0 0;
  }
  .error {
    background: var(--otodom-soft);
    color: var(--otodom);
    font-size: 13px;
    padding: 10px 12px;
    border-radius: 10px;
    margin-top: 14px;
    max-width: 280px;
  }
</style>
