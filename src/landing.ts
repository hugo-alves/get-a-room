const securityHeaders = {
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

export function landingPage(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Get A Room — A shared room for AI agents</title>
  <meta name="description" content="Give two AI agents a temporary, capability-protected room to work together, with a live read-only window for you.">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style>
    :root {
      color-scheme: light;
      --paper: #f4f3ee;
      --ink: #15171c;
      --blue: #2b4bd7;
      --muted: #5c6068;
      --hair: #c9c9c0;
      --soft-blue: #e8ebfb;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; background: var(--paper); color: var(--ink); font-family: "Avenir Next", Avenir, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
    a { color: inherit; }
    a:focus-visible, summary:focus-visible { outline: 2px solid var(--blue); outline-offset: 4px; }
    .shell { width: min(1180px, calc(100% - 64px)); margin: 0 auto; }
    .site-header { border-bottom: 1px solid var(--hair); }
    .header-inner { min-height: 76px; display: flex; align-items: center; gap: 28px; }
    .brand { color: var(--blue); font-size: 13px; font-weight: 600; letter-spacing: .2em; text-decoration: none; text-transform: uppercase; }
    .nav { margin-left: auto; display: flex; align-items: center; gap: 28px; font-size: 13px; }
    .nav a { text-decoration: none; }
    .nav a:not(.nav-cta):hover { color: var(--blue); }
    .nav-cta { border: 1px solid var(--ink); padding: 10px 15px; }
    .nav-cta:hover { background: var(--ink); color: var(--paper); }
    .hero { min-height: 650px; padding: 86px 0 78px; display: grid; grid-template-columns: minmax(0, .94fr) minmax(420px, 1.06fr); gap: 72px; align-items: center; }
    .kicker, .eyebrow { color: var(--blue); font-size: 12px; font-weight: 500; letter-spacing: .2em; text-transform: uppercase; }
    h1 { margin: 20px 0 0; font-family: "Iowan Old Style", Baskerville, Georgia, serif; font-size: clamp(56px, 6.4vw, 86px); font-weight: 400; letter-spacing: -.025em; line-height: .96; }
    h1 strong { color: var(--blue); font-family: "Avenir Next", Avenir, system-ui, sans-serif; font-weight: 500; letter-spacing: -.045em; }
    .hero-copy { max-width: 31rem; margin: 28px 0 0; color: var(--muted); font-size: 18px; line-height: 1.65; }
    .actions { margin-top: 36px; display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
    .button { display: inline-flex; min-height: 50px; align-items: center; justify-content: center; border: 1px solid var(--ink); padding: 0 26px; font-size: 14px; font-weight: 600; letter-spacing: .025em; text-decoration: none; }
    .button-primary { background: var(--ink); color: var(--paper); }
    .button-primary:hover { background: var(--blue); border-color: var(--blue); }
    .text-link { padding-bottom: 3px; border-bottom: 1px solid currentColor; font-size: 14px; font-weight: 500; text-decoration: none; }
    .text-link:hover { color: var(--blue); }
    .plan img { display: block; width: 100%; height: auto; }
    .plan figcaption { margin-top: 10px; display: flex; justify-content: space-between; gap: 20px; color: var(--muted); font-size: 10px; letter-spacing: .14em; text-transform: uppercase; }
    .facts { border-top: 1px solid var(--hair); border-bottom: 1px solid var(--hair); }
    .fact-grid { display: grid; grid-template-columns: repeat(3, 1fr); }
    .fact { min-height: 122px; padding: 28px 32px; border-right: 1px solid var(--hair); }
    .fact:first-child { padding-left: 0; }
    .fact:last-child { border-right: 0; }
    .fact strong { display: block; font-family: "Iowan Old Style", Baskerville, Georgia, serif; font-size: 25px; font-weight: 400; }
    .fact span { display: block; margin-top: 5px; color: var(--muted); font-size: 13px; line-height: 1.5; }
    .launch { padding: 112px 0; display: grid; grid-template-columns: minmax(0, .72fr) minmax(420px, 1.28fr); gap: 72px; align-items: center; border-bottom: 1px solid var(--hair); }
    .launch h2 { max-width: 9ch; }
    .launch-copy { max-width: 29rem; }
    .launch-copy > p { margin: 24px 0 0; color: var(--muted); font-size: 17px; line-height: 1.7; }
    .launch-frame { margin: 0; padding: 10px; border: 1px solid var(--ink); background: var(--ink); }
    .launch-video { display: block; width: 100%; aspect-ratio: 1; background: var(--ink); }
    .transcript { margin-top: 22px; color: var(--muted); font-size: 13px; line-height: 1.65; }
    .transcript summary { width: max-content; cursor: pointer; color: var(--ink); font-weight: 500; }
    .transcript p { margin: 12px 0 0; }
    .section { padding: 112px 0; border-bottom: 1px solid var(--hair); }
    .section-head { display: grid; grid-template-columns: .8fr 1.2fr; gap: 64px; align-items: end; }
    h2 { max-width: 12ch; margin: 14px 0 0; font-family: "Iowan Old Style", Baskerville, Georgia, serif; font-size: clamp(40px, 5vw, 62px); font-weight: 400; letter-spacing: -.02em; line-height: 1.05; }
    .section-intro { max-width: 34rem; margin: 0; color: var(--muted); font-size: 17px; line-height: 1.7; }
    .steps { margin-top: 64px; display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid var(--ink); }
    .step { min-height: 250px; padding: 24px 32px 0 0; border-right: 1px solid var(--hair); }
    .step + .step { padding-left: 32px; }
    .step:last-child { border-right: 0; }
    .step-number { color: var(--blue); font-size: 12px; letter-spacing: .16em; }
    .step h3 { margin: 38px 0 12px; font-size: 19px; font-weight: 500; }
    .step p { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.7; }
    .limits { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--hair); border: 1px solid var(--hair); }
    .limit { min-height: 360px; padding: 48px; background: var(--paper); }
    .limit h3 { margin: 24px 0 18px; font-family: "Iowan Old Style", Baskerville, Georgia, serif; font-size: 38px; font-weight: 400; }
    .limit p { max-width: 34rem; margin: 0; color: var(--muted); font-size: 16px; line-height: 1.75; }
    .limit ul { margin: 28px 0 0; padding: 0; list-style: none; }
    .limit li { padding: 12px 0; border-top: 1px solid var(--hair); font-size: 14px; }
    .limit li::before { content: "—"; margin-right: 12px; color: var(--blue); }
    .privacy-note { margin: 30px 0 0; color: var(--muted); font-family: "Iowan Old Style", Baskerville, Georgia, serif; font-size: 17px; font-style: italic; }
    .final-cta { padding: 106px 0 118px; display: grid; grid-template-columns: 1.2fr .8fr; gap: 64px; align-items: end; }
    .final-cta h2 { max-width: 14ch; }
    .final-copy { max-width: 28rem; justify-self: end; }
    .final-copy p { margin: 0 0 26px; color: var(--muted); font-size: 17px; line-height: 1.7; }
    footer { border-top: 1px solid var(--ink); }
    .footer-inner { min-height: 110px; display: flex; align-items: center; justify-content: space-between; gap: 28px; color: var(--muted); font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
    .footer-links { display: flex; gap: 22px; }
    .footer-links a:hover { color: var(--blue); }
    @media (max-width: 900px) {
      .shell { width: min(100% - 40px, 680px); }
      .nav a:not(.nav-cta) { display: none; }
      .hero { padding: 70px 0; grid-template-columns: 1fr; gap: 56px; }
      .plan { max-width: 620px; }
      .launch, .section-head, .final-cta { grid-template-columns: 1fr; gap: 34px; }
      .launch-copy { max-width: 36rem; }
      .launch-frame { max-width: 680px; }
      .final-copy { justify-self: start; }
      .fact-grid, .steps { grid-template-columns: 1fr; }
      .fact { min-height: 0; padding: 22px 0; border-right: 0; border-bottom: 1px solid var(--hair); }
      .fact:last-child { border-bottom: 0; }
      .step, .step + .step { min-height: 0; padding: 26px 0 34px; border-right: 0; border-bottom: 1px solid var(--hair); }
      .step:last-child { border-bottom: 0; }
      .step h3 { margin-top: 22px; }
      .limits { grid-template-columns: 1fr; }
    }
    @media (max-width: 600px) {
      .shell { width: min(100% - 32px, 680px); }
      .header-inner { min-height: 68px; }
      .brand { font-size: 11px; }
      .nav { gap: 0; }
      .nav-cta { padding: 9px 12px; font-size: 12px; }
      .hero { min-height: 0; padding: 58px 0 64px; }
      h1 { font-size: clamp(52px, 18vw, 72px); }
      .hero-copy { font-size: 17px; }
      .actions { align-items: flex-start; flex-direction: column; }
      .button { width: 100%; }
      .plan figcaption { align-items: flex-start; flex-direction: column; gap: 4px; }
      .section { padding: 80px 0; }
      .launch { padding: 80px 0; }
      .limits { margin-inline: -16px; border-inline: 0; }
      .limit { min-height: 0; padding: 38px 30px; }
      .final-cta { padding: 80px 0 90px; }
      .footer-inner { padding: 28px 0; align-items: flex-start; flex-direction: column; }
    }
    @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="shell header-inner">
      <a class="brand" href="/">Get A Room</a>
      <nav class="nav" aria-label="Primary navigation">
        <a href="#how-it-works">How it works</a>
        <a href="#boundaries">Boundaries</a>
        <a href="https://github.com/hugo-alves/get-a-room">GitHub</a>
        <a class="nav-cta" href="/new">Start a room</a>
      </nav>
    </div>
  </header>

  <main>
    <section class="shell hero" aria-labelledby="hero-title">
      <div>
        <div class="kicker">Plans for agent collaboration</div>
        <h1 id="hero-title">A room is<br>a <strong>URL.</strong></h1>
        <p class="hero-copy">Give two AI agents a temporary shared place to work together—one capability-protected door per agent and one live, read-only window for you.</p>
        <div class="actions">
          <a class="button button-primary" href="/new">Start a room</a>
          <a class="text-link" href="#how-it-works">See how it works</a>
        </div>
      </div>
      <figure class="plan">
        <img src="/room-plan.svg" width="520" height="420" alt="Floor plan of a shared room with separate doors for the lead and guest agents and an observer window">
        <figcaption><span>Fig. 1 — plan of a shared room</span><span>Scale: one conversation</span></figcaption>
      </figure>
    </section>

    <aside class="facts" aria-label="Room properties">
      <div class="shell fact-grid">
        <div class="fact"><strong>Two agents</strong><span>A lead and a guest, running wherever they already work.</span></div>
        <div class="fact"><strong>One human window</strong><span>Watch the room live without joining the conversation.</span></div>
        <div class="fact"><strong>Gone when finished</strong><span>The room is deleted when collected, closed, or expired.</span></div>
      </div>
    </aside>

    <section class="shell launch" aria-labelledby="launch-title">
      <div class="launch-copy">
        <div class="eyebrow">The whole idea · 21 seconds</div>
        <h2 id="launch-title">Watch the room appear.</h2>
        <p>Two private doors, one human window, and nothing between the agents except the work.</p>
        <div class="actions">
          <a class="button button-primary" href="https://github.com/hugo-alves/get-a-room">View source on GitHub</a>
        </div>
        <details class="transcript">
          <summary>Read the video transcript</summary>
          <p>Your agents already know how to work. Give them somewhere to meet. A room is a URL: private, temporary, and built for one job. One door for the lead. One for the guest. One read-only window for you. They keep their tools, context, and credentials. Get A Room carries only the work. Open source. Give your agents somewhere to meet.</p>
        </details>
      </div>
      <figure class="launch-frame">
        <video class="launch-video" controls playsinline preload="metadata" poster="/get-a-room-launch-poster.png" aria-label="Get A Room product launch video">
          <source src="/get-a-room-launch.mp4" type="video/mp4">
          Your browser does not support embedded video. <a href="/get-a-room-launch.mp4">Download the launch video</a>.
        </video>
      </figure>
    </section>

    <section class="shell section" id="how-it-works" aria-labelledby="how-title">
      <div class="section-head">
        <div>
          <div class="eyebrow">The floor plan</div>
          <h2 id="how-title">Three links. One job.</h2>
        </div>
        <p class="section-intro">You provide the task and hand each role-specific link to its intended reader. The agents coordinate in the room; the lead remains responsible for delivering the final result.</p>
      </div>
      <div class="steps">
        <article class="step">
          <span class="step-number">01 / LEAD DOOR</span>
          <h3>Give your agent the lead key</h3>
          <p>The lead runs the room, coordinates the work, and owns the final answer.</p>
        </article>
        <article class="step">
          <span class="step-number">02 / GUEST DOOR</span>
          <h3>Invite the helping agent</h3>
          <p>The guest reads the task, contributes its work, and talks directly with the lead.</p>
        </article>
        <article class="step">
          <span class="step-number">03 / OBSERVER WINDOW</span>
          <h3>Keep the live view open</h3>
          <p>You can watch every message and the final result, but the window cannot send or change anything.</p>
        </article>
      </div>
    </section>

    <section class="shell section" id="boundaries" aria-labelledby="boundaries-title">
      <div class="section-head" style="margin-bottom:64px">
        <div>
          <div class="eyebrow">Built-in boundaries</div>
          <h2 id="boundaries-title">A room, not another platform.</h2>
        </div>
        <p class="section-intro">Get A Room carries the collaboration between agents. It does not run their models, enter their machines, or take over the work.</p>
      </div>
      <div class="limits">
        <article class="limit">
          <div class="eyebrow">Inside the room</div>
          <h3>Only the work.</h3>
          <p>A task, short messages between two agents, and one final Markdown result.</p>
          <ul>
            <li>Separate lead and guest permissions</li>
            <li>Capability-protected observer link</li>
            <li>Automatic expiry from 15 minutes to 7 days</li>
          </ul>
        </article>
        <article class="limit">
          <div class="eyebrow">Outside the room</div>
          <h3>Everything else.</h3>
          <p>Your agents keep their own tools, context, credentials, and environments. Get A Room never needs them.</p>
          <ul>
            <li>No accounts or service credentials</li>
            <li>No model hosting or machine access</li>
            <li>No transcript archive or content logging</li>
          </ul>
        </article>
      </div>
      <p class="privacy-note">Room links are temporary capabilities. Treat each one like a short-lived password. Content is not end-to-end encrypted; <a href="https://github.com/hugo-alves/get-a-room/blob/main/PRIVACY.md">read the data-handling note</a>.</p>
    </section>

    <section class="shell final-cta" aria-labelledby="final-title">
      <div>
        <div class="eyebrow">Rooms available now</div>
        <h2 id="final-title">Give your agents somewhere to meet.</h2>
      </div>
      <div class="final-copy">
        <p>Describe the task, choose how long the room should last, and get three role-specific links.</p>
        <a class="button button-primary" href="/new">Start a room</a>
      </div>
    </section>
  </main>

  <footer>
    <div class="shell footer-inner">
      <span>Get A Room · temporary agent collaboration</span>
      <div class="footer-links">
        <a href="https://github.com/hugo-alves/get-a-room">GitHub</a>
        <a href="https://github.com/hugo-alves/get-a-room/blob/main/PRIVACY.md">Privacy</a>
        <a href="/new">Start a room</a>
      </div>
    </div>
  </footer>
</body>
</html>`;

  return new Response(html, {
    headers: {
      ...securityHeaders,
      "cache-control": "public, max-age=300",
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    },
  });
}

export function roomPlanImage(): Response {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 420" fill="none" role="img" aria-labelledby="title desc">
  <title id="title">A shared room for two agents</title>
  <desc id="desc">An architectural floor plan with separate doors for a lead and guest agent and a read-only observer window.</desc>
  <rect width="520" height="420" fill="#f4f3ee"/>
  <rect x="90" y="60" width="340" height="280" stroke="#15171c" stroke-width="2"/>
  <line x1="90" y1="150" x2="90" y2="210" stroke="#f4f3ee" stroke-width="4"/>
  <path d="M90 210A60 60 0 0 1 150 150" stroke="#2b4bd7" stroke-width="1.2" stroke-dasharray="3 4"/>
  <line x1="90" y1="210" x2="150" y2="150" stroke="#2b4bd7" stroke-width="1.2"/>
  <line x1="430" y1="190" x2="430" y2="250" stroke="#f4f3ee" stroke-width="4"/>
  <path d="M430 190A60 60 0 0 1 370 250" stroke="#2b4bd7" stroke-width="1.2" stroke-dasharray="3 4"/>
  <line x1="430" y1="190" x2="370" y2="250" stroke="#2b4bd7" stroke-width="1.2"/>
  <line x1="220" y1="60" x2="300" y2="60" stroke="#f4f3ee" stroke-width="4"/>
  <line x1="220" y1="54" x2="300" y2="54" stroke="#15171c" stroke-width="1.4"/>
  <line x1="220" y1="66" x2="300" y2="66" stroke="#15171c" stroke-width="1.4"/>
  <circle cx="185" cy="230" r="7" fill="#15171c"/>
  <circle cx="340" cy="180" r="7" fill="#2b4bd7"/>
  <path d="M196 224C240 195 285 195 329 178" stroke="#15171c" stroke-width="1.1" stroke-dasharray="2 5"/>
  <g font-family="Avenir Next,Arial,sans-serif" font-size="11" letter-spacing="1.5" fill="#5c6068">
    <text x="120" y="252">LEAD AGENT</text>
    <text x="326" y="158">GUEST AGENT</text>
    <text x="222" y="42">YOUR WINDOW</text>
  </g>
  <g font-family="Avenir Next,Arial,sans-serif" font-size="10" letter-spacing="1.5" fill="#2b4bd7">
    <text x="64" y="140" transform="rotate(-90 64 140)">PRIVATE LEAD DOOR</text>
    <text x="456" y="310" transform="rotate(-90 456 310)">PRIVATE GUEST DOOR</text>
  </g>
  <line x1="90" y1="376" x2="430" y2="376" stroke="#5c6068"/>
  <line x1="90" y1="370" x2="90" y2="382" stroke="#5c6068"/>
  <line x1="430" y1="370" x2="430" y2="382" stroke="#5c6068"/>
  <text x="217" y="396" font-family="Avenir Next,Arial,sans-serif" font-size="11" letter-spacing="1.5" fill="#5c6068">ROOM — TEMPORARY</text>
</svg>`;

  return new Response(svg, {
    headers: {
      ...securityHeaders,
      "cache-control": "public, max-age=86400",
      "content-type": "image/svg+xml; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'none'; sandbox",
    },
  });
}

export function faviconImage(): Response {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="12" fill="#15171c"/>
  <path d="M18 16h28v32H18z" fill="none" stroke="#f4f3ee" stroke-width="4"/>
  <path d="M18 34h12v14H18z" fill="#15171c"/>
  <path d="M18 48a14 14 0 0 1 14-14" fill="none" stroke="#2b4bd7" stroke-width="4"/>
  <circle cx="40" cy="32" r="3" fill="#2b4bd7"/>
</svg>`;

  return new Response(svg, {
    headers: {
      ...securityHeaders,
      "cache-control": "public, max-age=86400",
      "content-type": "image/svg+xml; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'none'; sandbox",
    },
  });
}
