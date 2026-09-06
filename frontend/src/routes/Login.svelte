<script>
  import { api, ApiError } from '../lib/api';
  import { user, ui } from '../lib/store';
  import { navigate } from '../lib/router';
  import Icon from '../lib/icons/Icon.svelte';
  import { startAuthentication } from '@simplewebauthn/browser';

  let email = '';
  let password = '';
  let error = '';
  let loading = false;

  async function submit() {
    error = '';
    if (!email || !password) { error = 'Please enter your email and password.'; return; }
    loading = true;
    try {
      const r = await api.login({ email, password });
      user.set(r.user);
      navigate('/feed');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_credentials') {
        error = 'Wrong email or password.';
      } else {
        error = e.message || 'Could not log in.';
      }
    } finally {
      loading = false;
    }
  }

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
      if (e?.name === 'AbortError') {
        // user cancelled
      } else {
        error = e.message || 'Passkey sign-in failed.';
      }
    } finally {
      loading = false;
    }
  }
</script>

<div class="screen scroll no-scrollbar">
  <div class="inner">
    <div class="brand">
      <div class="logo"><Icon name="map" size={30} color="#FAF9F5" stroke={1.9} /></div>
    </div>
    <h1>Welcome to Lokum</h1>
    <p class="lede">Fresh apartment rentals from OLX and Otodom across Poland, gathered every morning.</p>

    <form on:submit|preventDefault={submit}>
      <label class="label" for="email">Email</label>
      <input id="email" type="email" class="input" bind:value={email} placeholder="you@email.com" autocomplete="email" />

      <label class="label" for="pw" style="margin-top:16px">Password</label>
      <input id="pw" type="password" class="input" bind:value={password} placeholder="Password" autocomplete="current-password" />

      {#if error}<div class="error">{error}</div>{/if}

      <button class="btn btn-primary btn-full" type="submit" style="margin-top:22px" disabled={loading}>
        {loading ? 'Logging in…' : 'Log in'}
      </button>
    </form>

    <div class="divider"><span>OR</span></div>

    <button class="btn btn-secondary btn-full" on:click={passkeyLogin} disabled={loading}>
      <Icon name="passkey" size={20} color="#C15F3C" />
      Use a passkey
    </button>
  </div>
  <div class="footer">
    New here? <a on:click={() => navigate('/signup')}>Create account</a>
  </div>
</div>

<style>
  .inner {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 20px 0;
  }
  .screen {
    padding: 8px 28px 32px;
  }
  .brand {
    margin-bottom: 26px;
  }
  .logo {
    width: 56px;
    height: 56px;
    border-radius: 16px;
    background: var(--accent);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  h1 {
    font-family: var(--serif);
    font-weight: 500;
    font-size: 40px;
    line-height: 1.05;
    letter-spacing: -.01em;
    color: var(--ink);
    margin: 0 0 12px;
  }
  .lede {
    font-size: 16px;
    line-height: 1.5;
    color: var(--muted);
    margin: 0 0 32px;
    max-width: 290px;
  }
  .divider {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 22px 0;
  }
  .divider::before, .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--line);
  }
  .divider span {
    font-size: 12px;
    color: var(--muted-2);
    font-weight: 500;
    letter-spacing: .04em;
  }
  .error {
    background: var(--otodom-soft);
    color: var(--otodom);
    font-size: 13px;
    padding: 10px 12px;
    border-radius: 10px;
    margin-top: 12px;
  }
  .footer {
    text-align: center;
    font-size: 15px;
    color: var(--muted);
    padding-top: 16px;
  }
  .footer a {
    color: var(--accent);
    font-weight: 600;
    cursor: pointer;
  }
</style>
