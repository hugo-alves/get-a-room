/* Minimal analytics for public pages only. Browser configuration is generated from env. */
(() => {
  const config = window.SWT_POSTHOG;
  if (!config?.token || !config?.host || window.posthog || typeof window.va === 'function') return;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const verification = local && new URL(location.href).searchParams.get('analytics_test') === '1';
  if (local && !verification) return;
  // These routes can carry capabilities or private application state.
  if (/^\/(?:v1|watch|join|new|api)(?:\/|$)/.test(location.pathname)) return;
  let client;
  const queue = [];
  window.swtAnalyticsCapture = (name, properties) => {
    if (client) client.capture(name, properties);
    else queue.push([name, properties]);
  };
  const script = document.createElement('script');
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.src = config.host.replace('.i.posthog.com', '-assets.i.posthog.com') + '/static/array.js';
  script.onload = () => {
    if (!window.posthog?.init) return;
    window.posthog.init(config.token, {
      api_host: config.host, defaults: '2026-08-30',
      autocapture: false, capture_pageview: false, capture_pageleave: false,
      disable_session_recording: true, disable_surveys: true,
      advanced_disable_flags: true, person_profiles: 'never', persistence: 'memory',
      respect_dnt: true,
      before_send: event => {
        // No arbitrary URL parameters, fragments, referring paths, form values or identity data.
        const old = event.properties || {};
        event.properties = {
          token: old.token, distinct_id: old.distinct_id,
          $lib: old.$lib, $lib_version: old.$lib_version,
          $process_person_profile: false,
          $current_url: location.origin + location.pathname,
          $host: location.hostname, $pathname: location.pathname,
          site: location.hostname, environment: verification ? 'verification' : 'public',
          ...(old.provider ? { provider: old.provider, signal: old.signal } : {})
        };
        return event;
      },
      loaded: instance => {
        client = instance;
        client.capture('$pageview');
        for (const [name, properties] of queue.splice(0)) client.capture(name, properties);
      }
    });
  };
  document.head.appendChild(script);
})();
