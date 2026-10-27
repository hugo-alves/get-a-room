/* Explicit AI referral signals only. No cookies, storage, URL payloads or new collector. */
(() => {
  const providers = {
    'chatgpt.com': 'chatgpt', 'chat.openai.com': 'chatgpt',
    'perplexity.ai': 'perplexity', 'claude.ai': 'claude',
    'gemini.google.com': 'gemini', 'copilot.microsoft.com': 'copilot'
  };
  const source = new URL(location.href).searchParams.get('utm_source')?.toLowerCase();
  let provider = providers[source] || (Object.values(providers).includes(source) ? source : null);
  let signal = 'utm_source';
  if (!provider && document.referrer) {
    try {
      const host = new URL(document.referrer).hostname;
      provider = Object.entries(providers).find(([domain]) => host === domain || host.endsWith('.' + domain))?.[1];
      signal = 'referrer';
    } catch { /* Invalid referrer is not an attribution signal. */ }
  }
  if (!provider) return;
  const properties = { provider, signal };
  window.dispatchEvent(new CustomEvent('ai-referral', { detail: properties }));
  // Reuse an existing collector only; this script never initialises analytics.
  if (typeof window.swtAnalyticsCapture === 'function') window.swtAnalyticsCapture('ai_referral', properties);
  else if (window.posthog?.capture) window.posthog.capture('ai_referral', properties);
  else if (typeof window.va === 'function') window.va('event', { name: 'ai_referral', data: properties });
})();
