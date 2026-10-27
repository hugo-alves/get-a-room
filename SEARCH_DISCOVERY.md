# Search discovery and analytics

Reviewed 27 October 2026. Public facts live in `content.json` and the visible `about-this-project.html`; update both and `llms.txt` together when project facts change. A review date records a content review, not a fresh deployment, uptime check or device test. Keep sitemap URLs on the canonical public origin.

## Analytics

PostHog uses the connected Default project, EU region. Browser settings are generated from `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST`; keep local values in ignored `.env.local`, and configure the same variables in the hosting build environment before publishing. No values are committed.

Before a static publication, run `python3 scripts/configure-posthog.py --output public/posthog-config.js`. Vite projects run this command from their normal build script. Publish the generated configuration with the site assets; a clean checkout without build-time configuration leaves analytics disabled. Do not publish local env files.

Only public pageviews and explicitly attributed `ai_referral` events are captured. No autocapture, session replay, persistent storage or person profiles. Query strings, fragments, referring paths and form values are removed. Ordinary direct traffic is not assigned to AI. Localhost is skipped unless the explicit `analytics_test=1` verification flag is supplied.

Production ingestion and publication must be verified after a separately authorized release.
