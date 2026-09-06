<!-- Reusable SVG icon set, all 24x24 -->
<script>
  export let name;
  export let size = 20;
  export let color = 'currentColor';
  export let stroke = 1.7;
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round">
  {#if name === 'back'}
    <path d="M15 5l-7 7 7 7"/>
  {:else if name === 'close'}
    <path d="M6 6l12 12M18 6L6 18"/>
  {:else if name === 'chevron-down'}
    <path d="M6 9l6 6 6-6"/>
  {:else if name === 'chevron-right'}
    <path d="M9 6l6 6-6 6"/>
  {:else if name === 'filter'}
    <path d="M4 6h16M7 12h10M10 18h4"/>
  {:else if name === 'location'}
    <path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/>
    <circle cx="12" cy="10" r="2.4"/>
  {:else if name === 'heart'}
    <path d="M12 20s-7-4.3-9.2-8.5C1.3 8.6 2.6 5.5 5.6 5.1c1.9-.2 3.4.9 4.4 2.4 1-1.5 2.5-2.6 4.4-2.4 3 .4 4.3 3.5 2.8 6.4C19 15.7 12 20 12 20z"/>
  {:else if name === 'heart-filled'}
    <path d="M12 20s-7-4.3-9.2-8.5C1.3 8.6 2.6 5.5 5.6 5.1c1.9-.2 3.4.9 4.4 2.4 1-1.5 2.5-2.6 4.4-2.4 3 .4 4.3 3.5 2.8 6.4C19 15.7 12 20 12 20z" fill={color}/>
  {:else if name === 'star'}
    <!-- Task F: filled star — the same SVG path A4 documented in the seam. -->
    <path d="M12 2l2.9 6.3 6.8.7-5 4.6 1.5 6.7L12 17.8 5.8 21.7l1.5-6.7-5-4.6 6.8-.7z" fill={color} stroke="none"/>
  {:else if name === 'star-outline'}
    <!-- Outline-only variant for the un-starred chip state. -->
    <path d="M12 2l2.9 6.3 6.8.7-5 4.6 1.5 6.7L12 17.8 5.8 21.7l1.5-6.7-5-4.6 6.8-.7z" fill="none" stroke={color}/>
  {:else if name === 'settings'}
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  {:else if name === 'map'}
    <path d="M9 20 3 17V4l6 3 6-3 6 3v13l-6-3-6 3z"/>
    <path d="M9 7v13M15 4v13"/>
  {:else if name === 'check'}
    <path d="M20 6 9 17l-5-5"/>
  {:else if name === 'passkey'}
    <path d="M12 2a5 5 0 0 0-5 5v2m10 0V7a5 5 0 0 0-2-4M7 9.5C6 11 6 13 6.5 15.5M17 9.5c1 2 .9 5 0 7.5M9.5 10.5a2.7 2.7 0 0 1 5 1.3c0 3-.4 5-1.2 6.7M12 12.5v3.5c0 2 0 3 .8 4.5"/>
  {:else if name === 'external'}
    <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
  {:else if name === 'play'}
    <path d="M5 3l14 9-14 9V3z" fill={color} stroke="none"/>
  {:else if name === 'clock'}
    <circle cx="12" cy="12" r="9"/>
    <path d="M12 7v5l3 2"/>
  {:else if name === 'logout'}
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
    <path d="M16 17l5-5-5-5M21 12H9"/>
  {:else if name === 'plus'}
    <path d="M12 5v14M5 12h14"/>
  {:else if name === 'trash'}
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
  {:else if name === 'edit'}
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  {:else if name === 'park'}
    <path d="M12 22v-5m0 0 4.5-4.5M12 17 7 12"/>
    <path d="M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" stroke="#5F8A4E"/>
  {:else if name === 'gym'}
    <path d="M6.5 6.5v11M17.5 6.5v11M4 9v6M20 9v6M6.5 12h11" stroke="#B06A3B"/>
  {:else if name === 'mall'}
    <path d="M4 8h16l-1 12H5L4 8Z" stroke="#9A5EA8"/>
    <path d="M8.5 8V6a3.5 3.5 0 0 1 7 0v2" stroke="#9A5EA8"/>
  {:else if name === 'market'}
    <path d="M4 5h2l2 11h9l2-8H7" stroke="#3E82A8"/>
    <circle cx="9.5" cy="19.5" r="1.3" fill="#3E82A8" stroke="none"/>
    <circle cx="16" cy="19.5" r="1.3" fill="#3E82A8" stroke="none"/>
  {:else if name === 'transport'}
    <rect x="5" y="3" width="14" height="14" rx="2" stroke="#4A6FA5"/>
    <path d="M5 11h14M8 17v3M16 17v3" stroke="#4A6FA5"/>
  {:else if name === 'restaurant'}
    <!-- Task F: fork+knife for the 'restaurant' category (Google Places type). -->
    <path d="M11 2v8a2 2 0 0 1-2 2H8v10H6V12H5a2 2 0 0 1-2-2V2h2v5h2V2h2v8a2 2 0 0 0 2-2V2h2v6a2 2 0 0 1-2 2z" stroke="#A86543"/>
    <path d="M18 2c-1.5 1.5-2 3.5-2 6v4h2v10h2V2" stroke="#A86543"/>
  {:else if name === 'school'}
    <path d="M22 10 12 5 2 10l10 5 10-5z" stroke="#7B5DBA"/>
    <path d="M6 12v5c0 1 2 3 6 3s6-2 6-3v-5" stroke="#7B5DBA"/>
  {:else if name === 'share'}
    <circle cx="18" cy="5" r="3"/>
    <circle cx="6" cy="12" r="3"/>
    <circle cx="18" cy="19" r="3"/>
    <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>
  {:else if name === 'copy'}
    <rect x="9" y="9" width="13" height="13" rx="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  {:else if name === 'region'}
    <path d="M12 3l7 5-2 9H7l-2-9 7-5z"/>
    <circle cx="12" cy="11" r="2"/>
  {:else if name === 'send'}
    <path d="M22 2 11 13"/>
    <path d="M22 2 15 22l-4-9-9-4 20-7z"/>
  {:else if name === 'upload'}
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <path d="M17 8l-5-5-5 5M12 3v12"/>
  {:else if name === 'zap'}
    <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>
  {/if}
</svg>
