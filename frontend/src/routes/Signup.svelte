<script>
  import { api, ApiError } from '../lib/api';
  import { user } from '../lib/store';
  import { navigate } from '../lib/router';
  import Icon from '../lib/icons/Icon.svelte';

  let name = '';
  let email = '';
  let password = '';
  let error = '';
  let loading = false;

  async function submit() {
    error = '';
    if (!name || !email || !password) { error = 'Please fill in all fields.'; return; }
    if (password.length < 6) { error = 'Password must be at least 6 characters.'; return; }
    loading = true;
    try {
      const r = await api.signup({ name, email, password });
      user.set(r.user);
      navigate('/passkey-setup');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'email_in_use') {
        error = 'An account with that email already exists.';
      } else {
        error = e.message || 'Could not create account.';
      }
    } finally {
      loading = false;
    }
  }
</script>

<div class="screen scroll no-scrollbar">
  <div style="padding:6px 0 22px;">
    <button class="back-btn" on:click={() => navigate('/login')}>
      <Icon name="back" size={18} color="#201E1B" />
    </button>
  </div>
  <h1>Create your account</h1>
  <p class="lede">Start your day with the newest listings, filtered your way.</p>

  <form on:submit|preventDefault={submit}>
    <label class="label" for="name">Full name</label>
    <input id="name" type="text" class="input" bind:value={name} placeholder="Anna Kowalska" autocomplete="name" />

    <label class="label" for="email" style="margin-top:16px">Email</label>
    <input id="email" type="email" class="input" bind:value={email} placeholder="you@email.com" autocomplete="email" />

    <label class="label" for="pw" style="margin-top:16px">Password</label>
    <input id="pw" type="password" class="input" bind:value={password} placeholder="Create a password" autocomplete="new-password" />

    {#if error}<div class="error">{error}</div>{/if}

    <button class="btn btn-primary btn-full" type="submit" style="margin-top:26px" disabled={loading}>
      {loading ? 'Creating…' : 'Create account'}
    </button>
  </form>
  <p class="terms">By continuing you agree to our Terms & Privacy Policy.</p>
  <div class="footer">
    Have an account? <a on:click={() => navigate('/login')}>Log in</a>
  </div>
</div>

<style>
  .screen { padding: 8px 28px 32px; }
  h1 {
    font-family: var(--serif);
    font-weight: 500;
    font-size: 34px;
    line-height: 1.1;
    color: var(--ink);
    margin: 0 0 8px;
  }
  .lede {
    font-size: 15px;
    line-height: 1.5;
    color: var(--muted);
    margin: 0 0 28px;
  }
  .error {
    background: var(--otodom-soft);
    color: var(--otodom);
    font-size: 13px;
    padding: 10px 12px;
    border-radius: 10px;
    margin-top: 12px;
  }
  .terms {
    font-size: 12px;
    line-height: 1.5;
    color: var(--muted-2);
    text-align: center;
    margin: 16px 0 auto;
  }
  .footer {
    text-align: center;
    font-size: 15px;
    color: var(--muted);
    padding-top: 24px;
  }
  .footer a {
    color: var(--accent);
    font-weight: 600;
    cursor: pointer;
  }
</style>
