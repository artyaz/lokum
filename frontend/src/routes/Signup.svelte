<script>
  import { navigate } from '../lib/router';
  import Icon from '../lib/icons/Icon.svelte';

  // New registrations are paused — see the notice below. The repo's issue
  // tracker is where account requests are handled for now.
  const ISSUES_URL = 'https://github.com/artyaz/lokum/issues/new';
</script>

<div class="screen scroll no-scrollbar">
  <div style="padding:6px 0 22px;">
    <button class="back-btn" on:click={() => navigate('/login')}>
      <Icon name="back" size={18} color="#201E1B" />
    </button>
  </div>
  <h1>New accounts are currently disabled</h1>
  <p class="lede">We're not accepting new registrations right now. If you need an account, please open a GitHub issue and we'll sort it out quickly.</p>

  <a class="btn btn-primary btn-full" style="text-decoration:none" href={ISSUES_URL} target="_blank" rel="noopener noreferrer">
    Open a GitHub issue
  </a>
  <button class="btn btn-secondary btn-full" style="margin-top:12px" on:click={() => navigate('/login')}>
    Back to log in
  </button>
  <p class="terms">Please include the email address you'd like to register and we'll create the account for you.</p>
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
