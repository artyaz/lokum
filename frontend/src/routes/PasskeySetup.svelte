<script>
  import { api } from '../lib/api';
  import { user } from '../lib/store';
  import { navigate } from '../lib/router';
  import Icon from '../lib/icons/Icon.svelte';
  import { startRegistration } from '@simplewebauthn/browser';

  let loading = false;
  let error = '';
  let skipped = false;

  async function createPasskey() {
    error = '';
    loading = true;
    try {
      const opts = await api.passkeyRegOptions();
      const attResp = await startRegistration({ optionsJSON: opts });
      await api.passkeyRegVerify(attResp);
      navigate('/feed');
    } catch (e) {
      if (e?.name === 'AbortError') {
        // user cancelled
      } else {
        error = e.message || 'Could not create passkey.';
      }
    } finally {
      loading = false;
    }
  }
</script>

<div class="screen">
  <div class="top">
    <button class="back-btn" on:click={() => navigate('/feed')}>
      <Icon name="back" size={18} color="#201E1B" />
    </button>
  </div>
  <div class="content">
    <div class="orb pulse-soft">
      <Icon name="passkey" size={52} color="#C15F3C" stroke={1.6} />
    </div>
    <h1>Set up a passkey</h1>
    <p class="lede">Sign in with your face or fingerprint — no password to remember, and nothing to leak.</p>
    <div class="perks">
      <div class="perk">
        <div class="perk-icon"><Icon name="check" size={18} color="#C15F3C" stroke={2} /></div>
        <span>Faster sign-in, every morning</span>
      </div>
      <div class="perk">
        <div class="perk-icon"><Icon name="check" size={18} color="#C15F3C" stroke={2} /></div>
        <span>Protected by your device hardware</span>
      </div>
    </div>
  </div>
  <div class="bottom">
    {#if error}<div class="error">{error}</div>{/if}
    <button class="btn btn-primary btn-full" on:click={createPasskey} disabled={loading}>
      {loading ? 'Creating…' : 'Create passkey'}
    </button>
    <button class="btn btn-ghost btn-full" on:click={() => navigate('/feed')}>Maybe later</button>
  </div>
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
  .orb {
    width: 110px;
    height: 110px;
    border-radius: 50%;
    background: var(--accent-soft);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 30px;
  }
  h1 {
    font-family: var(--serif);
    font-weight: 500;
    font-size: 32px;
    line-height: 1.12;
    color: var(--ink);
    margin: 0 0 14px;
  }
  .lede {
    font-size: 16px;
    line-height: 1.55;
    color: var(--muted);
    margin: 0 0 8px;
    max-width: 300px;
  }
  .perks {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-top: 26px;
    width: 100%;
    text-align: left;
  }
  .perk {
    display: flex;
    gap: 12px;
    align-items: center;
  }
  .perk-icon {
    width: 34px;
    height: 34px;
    border-radius: 10px;
    background: var(--card-soft);
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .perk span { font-size: 14px; color: var(--ink-2); }
  .bottom { margin-top: 30px; display: flex; flex-direction: column; gap: 14px; }
  .error {
    background: var(--otodom-soft);
    color: var(--otodom);
    font-size: 13px;
    padding: 10px 12px;
    border-radius: 10px;
  }
</style>
