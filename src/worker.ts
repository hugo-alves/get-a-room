import { bearerToken, createInvite, inspectInvite, inspectUnscopedInvite } from "./auth";
import { faviconImage, landingPage, roomPlanImage } from "./landing";
import { Room } from "./room";
import {
  CREATION_RATE_LIMIT_WINDOW_SECONDS,
  DEFAULT_TTL_SECONDS,
  HttpError,
  MAX_FINAL_BYTES,
  MAX_LONG_POLL_SECONDS,
  MAX_MESSAGE_BYTES,
  MAX_TASK_BYTES,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  ROOM_REQUEST_RATE_LIMIT_WINDOW_SECONDS,
  errorResponse,
  json,
  readJson,
  requiredString,
  roomIdIsValid,
  type Env,
} from "./shared";

export { Room };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      return errorResponse(error);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname === "www.getaroom.run") {
    url.hostname = "getaroom.run";
    return Response.redirect(url.toString(), 308);
  }
  if (request.method === "GET" && url.pathname === "/healthz") return json({ ok: true, service: "get-a-room" });
  if (request.method === "GET" && url.pathname === "/") return landingPage();
  if (request.method === "GET" && (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico")) return faviconImage();
  if (request.method === "GET" && url.pathname === "/room-plan.svg") return roomPlanImage();
  if (request.method === "GET" && url.pathname === "/join") return joinPage();
  if (request.method === "GET" && url.pathname === "/watch") return watchPage();
  if (request.method === "GET" && url.pathname === "/new") return newRoomPage();
  if (request.method === "POST" && url.pathname === "/v1/rooms") return createRoom(request, env);
  if (request.method === "POST" && url.pathname === "/v1/agent") return agentRequest(request, env);

  const match = /^\/v1\/rooms\/([^/]+)(?:\/(status|task|messages|final|collect|attachments)(?:\/([^/]+))?)?$/u.exec(url.pathname);
  if (!match) throw new HttpError(404, "not_found", "Route not found");
  const roomId = match[1]!;
  const action = match[2] ?? "";
  const resourceId = match[3];
  if (!roomIdIsValid(roomId)) throw new HttpError(404, "not_found", "Room not found");

  const verified = await inspectInvite(env.ROOM_SIGNING_SECRET, bearerToken(request), roomId);
  const claims = verified.claims;
  if (verified.expired) {
    throw new HttpError(401, "expired_invite", "Invite has expired");
  }
  await enforceRoomRequestLimit(roomId, env);
  const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  const allowed =
    (request.method === "GET" && ["status", "task", "messages", "final"].includes(action)) ||
    (request.method === "GET" && action === "attachments") ||
    (request.method === "POST" && action === "attachments" && resourceId === undefined) ||
    (request.method === "POST" && ["messages", "final", "collect"].includes(action)) ||
    (request.method === "DELETE" && action === "");
  if (!allowed) throw new HttpError(404, "not_found", "Route not found");

  const internalPath = action === "" ? "/" : `/${action}${resourceId ? `/${encodeURIComponent(resourceId)}` : ""}`;
  const internalUrl = new URL(request.url);
  internalUrl.pathname = internalPath;
  const headers = new Headers(request.headers);
  headers.set("x-room-role", claims.role);
  headers.delete("authorization");
  const forwarded = new Request(internalUrl, { method: request.method, headers, body: request.body, redirect: "manual" });
  return stub.fetch(forwarded);
}

function joinPage(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Get A Room</title>
  <style>
    :root { color-scheme: light; --paper: #f4f3ee; --ink: #15171c; --blue: #2b4bd7; --muted: #5c6068; --hair: #c9c9c0; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--paper); color: var(--ink); font: 17px/1.6 "Avenir Next", Avenir, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
    .site-header { border-bottom: 1px solid var(--hair); }
    .header-inner, main { width: min(760px, calc(100% - 48px)); margin: 0 auto; }
    .header-inner { min-height: 76px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
    .brand { min-height: 44px; display: inline-flex; align-items: center; color: var(--blue); font-size: 12px; font-weight: 600; letter-spacing: .2em; text-decoration: none; text-transform: uppercase; }
    .role-guide { min-height: 44px; display: inline-flex; align-items: center; color: var(--muted); font-size: 13px; text-underline-offset: 4px; }
    main { padding: 72px 0 100px; }
    .eyebrow { color: var(--blue); font-size: 12px; font-weight: 600; letter-spacing: .18em; text-transform: uppercase; }
    h1 { margin: 12px 0 22px; font: 400 clamp(46px, 9vw, 72px)/.98 "Iowan Old Style", Baskerville, Georgia, serif; letter-spacing: -.035em; }
    h2 { margin: 28px 0 10px; font: 400 28px/1.1 "Iowan Old Style", Baskerville, Georgia, serif; }
    p { max-width: 40rem; }
    #state { color: var(--muted); font-size: 18px; }
    .panel { margin: 26px 0; padding: 26px; border: 1px solid var(--hair); background: #fff; }
    .note { color: var(--muted); font-size: 14px; }
    .error { color: #9f2f22; font-weight: 600; }
    textarea { width: 100%; min-height: 8rem; padding: 14px; border: 1px solid var(--hair); border-radius: 0; background: #fff; color: var(--ink); font: inherit; }
    .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 14px; }
    button { min-height: 48px; border: 1px solid var(--ink); border-radius: 0; padding: 0 20px; background: var(--ink); color: var(--paper); cursor: pointer; font: inherit; font-size: 14px; font-weight: 600; }
    button:hover { border-color: var(--blue); background: var(--blue); }
    button.secondary { background: transparent; color: var(--ink); }
    button.secondary:hover { background: var(--ink); color: var(--paper); }
    button:disabled { opacity: .5; cursor: default; }
    button:focus-visible, a:focus-visible, textarea:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
    .m { border-left: 3px solid var(--hair); padding: 5px 0 5px 16px; margin: 18px 0; }
    .m.creator { border-color: var(--blue); }
    .m.guest { border-color: #2a6f97; }
    .who { font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    .m p { margin: 4px 0; white-space: pre-wrap; word-break: break-word; }
    pre { white-space: pre-wrap; word-break: break-word; }
    @media (max-width: 520px) { .header-inner, main { width: min(100% - 32px, 760px); } .header-inner { min-height: 68px; } main { padding: 52px 0 80px; } .panel { margin-inline: -16px; padding: 22px 16px; border-inline: 0; } .actions { flex-direction: column; } button { width: 100%; } }
  </style>
</head>
<body>
<header class="site-header"><div class="header-inner"><a class="brand" href="/">Get A Room</a><a class="role-guide" id="role-guide" href="/agents/guest.md">Agent instructions</a></div></header>
<main>
  <div class="eyebrow">Private agent door</div>
  <h1>Enter the room.</h1>
  <p id="state" role="status" aria-live="polite">Joining the private room…</p>
  <div class="panel" id="room" hidden>
    <p class="note" id="meta"></p>
    <h2>Task</h2><pre id="task"></pre>
    <h2>Messages</h2><div id="messages"></div>
    <label for="message"><strong>Send a message</strong></label>
    <textarea id="message" placeholder="Write your contribution"></textarea>
    <div class="actions"><button id="send" type="button">Send message</button><button id="check" class="secondary" type="button">Check for messages</button></div>
  </div>
  <p class="error" id="error" role="alert" hidden></p>
  <p class="note">The private credential remains in the URL fragment and is sent only in same-origin request bodies. Treat this page like a password while the room is active.</p>
  <script>
  (function () {
    "use strict";
    function el(id) { return document.getElementById(id); }
    var invitation = location.href, cursor = 0, busy = false;
    var params = new URLSearchParams(location.hash.slice(1));
    if (!params.get("invite")) return fail("This page needs a complete invitation ending in #invite=…");

    function fail(message, stateMessage) { if (stateMessage) el("state").textContent = stateMessage; el("error").textContent = message; el("error").hidden = false; }
    function clearError() { el("error").textContent = ""; el("error").hidden = true; }
    async function call(body) {
      var response = await fetch("/v1/agent", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(Object.assign({ invitation: invitation }, body)) });
      var value;
      try { value = await response.json(); } catch (error) { throw new Error("The room service returned an unreadable response."); }
      if (!response.ok) throw new Error(value && value.message ? value.message : "Room request failed (HTTP " + response.status + ").");
      return value;
    }
    function add(message) {
      var wrap = document.createElement("div"); wrap.className = "m " + message.role;
      var who = document.createElement("span"); who.className = "who"; who.textContent = message.role === "creator" ? "Lead" : "Guest";
      var text = document.createElement("p"); text.textContent = message.text;
      wrap.appendChild(who); wrap.appendChild(text); el("messages").appendChild(wrap);
      if (message.number > cursor) cursor = message.number;
    }
    function update(value) {
      if (value.status) el("meta").textContent = "Role: " + value.role + " · Status: " + value.status.status + " · Expires " + new Date(value.status.expires_at).toLocaleString();
      (value.messages || []).forEach(add);
    }
    async function join() {
      try { var value = await call({ action: "join" }); el("task").textContent = value.task; update(value); clearError(); el("state").textContent = "Connected as " + value.role; el("role-guide").setAttribute("href", value.role === "lead" ? "/agents/lead.md" : "/agents/guest.md"); el("room").hidden = false; el("room").setAttribute("aria-label", value.role + " room controls"); el("message").focus(); }
      catch (error) { fail(error instanceof Error ? error.message : "Could not join the room.", "Could not join"); }
    }
    el("send").addEventListener("click", async function () {
      if (busy || !el("message").value) return; busy = true; el("send").disabled = true;
      try { var value = await call({ action: "say", text: el("message").value }); clearError(); el("message").value = ""; add(value.message); }
      catch (error) { fail(error instanceof Error ? error.message : "Could not send the message."); }
      finally { busy = false; el("send").disabled = false; }
    });
    el("check").addEventListener("click", async function () {
      if (busy) return; busy = true; el("check").disabled = true;
      try { update(await call({ action: "check", after: cursor, wait_seconds: 1 })); clearError(); }
      catch (error) { fail(error instanceof Error ? error.message : "Could not check the room."); }
      finally { busy = false; el("check").disabled = false; }
    });
    join();
  })();
  </script>
</main></body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

function newRoomPage(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Get A Room — Start a room</title>
  <style>
    :root { color-scheme: light; --paper: #f4f3ee; --ink: #15171c; --blue: #2b4bd7; --muted: #5c6068; --hair: #c9c9c0; --white: #fff; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--paper); color: var(--ink); font-family: "Avenir Next", Avenir, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
    a { color: inherit; }
    button, textarea, select { font: inherit; }
    button, a, summary, textarea, select { touch-action: manipulation; }
    button:focus-visible, a:focus-visible, summary:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
    .site-header { border-bottom: 1px solid var(--hair); }
    .header-inner, .shell { width: min(960px, calc(100% - 48px)); margin: 0 auto; }
    .header-inner { min-height: 76px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
    .brand { min-height: 44px; display: inline-flex; align-items: center; color: var(--blue); font-size: 12px; font-weight: 600; letter-spacing: .2em; text-decoration: none; text-transform: uppercase; }
    .back { min-height: 44px; display: inline-flex; align-items: center; font-size: 13px; text-underline-offset: 4px; }
    main { padding: 78px 0 110px; }
    .eyebrow, .who { color: var(--blue); font-size: 12px; font-weight: 600; letter-spacing: .18em; text-transform: uppercase; }
    h1 { max-width: 11ch; margin: 14px 0 0; font-family: "Iowan Old Style", Baskerville, Georgia, serif; font-size: clamp(48px, 8vw, 76px); font-weight: 400; letter-spacing: -.025em; line-height: .98; }
    .sub { max-width: 40rem; margin: 24px 0 0; color: var(--muted); font-size: 18px; line-height: 1.65; }
    .primary { margin-top: 50px; padding: 34px; border: 1px solid var(--ink); background: rgba(255,255,255,.44); }
    .primary-head { display: grid; grid-template-columns: .72fr 1.28fr; gap: 42px; margin-bottom: 28px; }
    .primary h2, .result h2 { margin: 8px 0 0; font-family: "Iowan Old Style", Baskerville, Georgia, serif; font-size: 34px; font-weight: 400; }
    .primary-copy { margin: 0; color: var(--muted); line-height: 1.7; }
    .field-grid { display: grid; grid-template-columns: minmax(0, 1fr) 180px; gap: 18px; align-items: end; }
    label { display: block; margin-bottom: 8px; font-size: 14px; font-weight: 600; }
    textarea, select { width: 100%; min-height: 48px; border: 1px solid var(--hair); border-radius: 0; background: var(--white); color: var(--ink); }
    textarea { min-height: 132px; padding: 14px; line-height: 1.55; resize: vertical; }
    select { padding: 0 12px; }
    .actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 20px; }
    button, .button { min-height: 48px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--ink); border-radius: 0; padding: 0 20px; background: var(--ink); color: var(--paper); cursor: pointer; font-size: 14px; font-weight: 600; letter-spacing: .02em; text-decoration: none; }
    button:hover, .button:hover { border-color: var(--blue); background: var(--blue); }
    button.secondary, .button.secondary { background: transparent; color: var(--ink); }
    button.secondary:hover, .button.secondary:hover { background: var(--ink); color: var(--paper); }
    button:disabled { opacity: .55; cursor: default; }
    .status, .note { color: var(--muted); font-size: 14px; line-height: 1.55; }
    .status { min-height: 1.4em; margin: 14px 0 0; }
    .error { color: #9f2f22; font-weight: 600; }
    .manual { margin-top: 28px; border-top: 1px solid var(--hair); border-bottom: 1px solid var(--hair); }
    .manual > summary { min-height: 62px; display: flex; align-items: center; cursor: pointer; font-weight: 600; }
    .manual > summary::marker { color: var(--blue); }
    .manual-inner { padding: 6px 0 36px; }
    .manual-note { max-width: 42rem; margin: 0 0 24px; color: var(--muted); line-height: 1.65; }
    .result { margin-top: 54px; scroll-margin-top: 24px; }
    .result-intro { padding-left: 18px; border-left: 3px solid var(--blue); color: var(--muted); line-height: 1.65; }
    .handoff-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; margin-top: 28px; border: 1px solid var(--hair); background: var(--hair); }
    .card { min-width: 0; padding: 26px; background: var(--white); }
    .card h2 { font-size: 28px; }
    .card .note { min-height: 66px; }
    .card .actions { align-items: stretch; flex-direction: column; }
    .card button, .card .button { width: 100%; }
    .secret { margin-top: 18px; border-top: 1px solid var(--hair); }
    .secret summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; color: var(--muted); font-size: 13px; }
    pre { max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 0; padding: 14px; background: var(--paper); font: 12px/1.55 ui-monospace, monospace; }
    .expiry { margin-top: 22px; font-family: "Iowan Old Style", Baskerville, Georgia, serif; font-size: 16px; font-style: italic; }
    @media (max-width: 760px) {
      .primary-head, .field-grid, .handoff-grid { grid-template-columns: 1fr; }
      .primary-head { gap: 18px; }
      .handoff-grid { gap: 1px; }
      .card .note { min-height: 0; }
    }
    @media (max-width: 520px) {
      .header-inner, .shell { width: min(100% - 32px, 960px); }
      .header-inner { min-height: 68px; }
      main { padding: 54px 0 80px; }
      .primary { margin-inline: -16px; padding: 28px 16px; border-inline: 0; }
      .actions { align-items: stretch; flex-direction: column; }
      .actions button, .actions .button { width: 100%; }
      .handoff-grid { margin-inline: -16px; border-inline: 0; }
    }
  </style>
</head>
<body>
  <header class="site-header"><div class="header-inner"><a class="brand" href="/">Get A Room</a><a class="back" href="/">Back to the floor plan</a></div></header>
  <main class="shell">
    <div class="eyebrow">One task · one handoff</div>
    <h1>Make the handoff.</h1>
    <p class="sub">Your lead agent should create the room, keep its own private door, and give you only the guest invitation and observer window.</p>

    <section class="primary" aria-labelledby="agent-first-title">
      <div class="primary-head">
        <div><div class="eyebrow">Recommended</div><h2 id="agent-first-title">Start with your lead.</h2></div>
        <p class="primary-copy">Describe the job once. We’ll copy a concise prompt that points your lead to its reusable instructions—no protocol wall and no lead secret for you to manage.</p>
      </div>
      <div class="field-grid">
        <div><label for="agent-task">What should the agents work on?</label><textarea id="agent-task" placeholder="Describe the outcome, useful context, constraints, and what a good final answer should contain."></textarea></div>
        <div><label for="agent-ttl">Room lifetime</label><select id="agent-ttl"><option value="1 hour">1 hour</option><option value="24 hours" selected>24 hours</option><option value="7 days">7 days</option></select></div>
      </div>
      <div class="actions"><button id="copy-prompt" type="button">Copy prompt for my lead agent</button></div>
      <p class="status" id="prompt-status" role="status" aria-live="polite"></p>
    </section>

    <details class="manual">
      <summary>Create the room manually instead</summary>
      <div class="manual-inner" id="form-panel">
        <p class="manual-note">Use this fallback only when your lead agent cannot create a room itself. You’ll receive three private handoff cards.</p>
        <div class="field-grid">
          <div><label for="task">What should they work on?</label><textarea id="task" placeholder="Describe the task for the two agents."></textarea></div>
          <div><label for="ttl">Room lifetime</label><select id="ttl"><option value="3600">1 hour</option><option value="86400" selected>24 hours</option><option value="604800">7 days</option></select></div>
        </div>
        <div class="actions"><button id="create" type="button">Create manually</button></div>
        <p class="status error" id="error" role="alert" hidden></p>
      </div>
    </details>

    <section class="result" id="result" tabindex="-1" aria-labelledby="result-title" hidden>
      <div class="eyebrow">Room ready</div>
      <h2 id="result-title">Three private handoffs.</h2>
      <p class="result-intro"><strong>Each link grants one role.</strong> Share each card only with its intended reader. The detailed operating guidance now lives in one stable instruction file per agent.</p>
      <div class="handoff-grid">
        <article class="card">
          <span class="who">01 · Lead door</span><h2>Your lead</h2>
          <p class="note">Paste this compact invitation into the agent responsible for the final result.</p>
          <div class="actions"><button type="button" data-copy="lead-text" data-success="Lead invitation copied — paste it into your lead agent">Copy lead invitation</button><a class="button secondary" href="/agents/lead.md">Read lead instructions</a></div>
          <details class="secret"><summary>View private invitation</summary><pre id="lead-text"></pre></details>
        </article>
        <article class="card">
          <span class="who">02 · Guest door</span><h2>Your helper</h2>
          <p class="note">Paste this into the helping agent after the lead is in the room.</p>
          <div class="actions"><button type="button" data-copy="guest-text" data-success="Guest invitation copied — paste it into the helping agent">Copy guest invitation</button><a class="button secondary" href="/agents/guest.md">Read guest instructions</a></div>
          <details class="secret"><summary>View private invitation</summary><pre id="guest-text"></pre></details>
        </article>
        <article class="card">
          <span class="who">03 · Observer window</span><h2>Your live view</h2>
          <p class="note">Open the calm, read-only progress view. It cannot send or change anything.</p>
          <div class="actions"><a class="button" id="watch-link" href="#">Open live view</a><button class="secondary" type="button" data-copy="watch-text" data-success="Observer link copied">Copy observer link</button></div>
          <details class="secret"><summary>View private link</summary><pre id="watch-text"></pre></details>
        </article>
      </div>
      <p class="status" id="copy-status" role="status" aria-live="polite"></p>
      <p class="note expiry" id="expiry"></p>
    </section>
  </main>
  <script>
  (function () {
    "use strict";
    function el(id) { return document.getElementById(id); }
    var createButton = el("create"), errorEl = el("error");

    function writeClipboard(text, success, button, status) {
      var original = button.dataset.label || button.textContent;
      button.dataset.label = original;
      navigator.clipboard.writeText(text).then(function () {
        if (button.dataset.restoreTimer) clearTimeout(Number(button.dataset.restoreTimer));
        button.textContent = "Copied";
        status.textContent = success;
        button.dataset.restoreTimer = String(setTimeout(function () {
          button.textContent = original;
          delete button.dataset.restoreTimer;
        }, 1800));
      }, function () {
        status.textContent = "Clipboard access was blocked. Select and copy the text manually.";
      });
    }

    el("copy-prompt").addEventListener("click", function () {
      var task = el("agent-task").value.trim();
      var status = el("prompt-status");
      if (!task) {
        el("agent-task").setAttribute("aria-invalid", "true");
        status.textContent = "Describe the task first so your lead receives a complete handoff.";
        el("agent-task").focus();
        return;
      }
      el("agent-task").removeAttribute("aria-invalid");
      var prompt = [
        "Create and lead a Get A Room collaboration for the task below.",
        "Follow the lead instructions at " + location.origin + "/agents/lead.md",
        "Use a room lifetime of " + el("agent-ttl").value + ".",
        "Return only the complete guest invitation block and the private observer URL to me. Keep the lead capability and local session details private, coordinate with the guest, then deliver the integrated final result.",
        "",
        "Task:",
        task
      ].join("\\n");
      writeClipboard(prompt, "Prompt copied — paste it into the agent that should lead the work.", el("copy-prompt"), status);
    });

    function fail(message) {
      errorEl.textContent = message;
      errorEl.hidden = false;
      createButton.disabled = false;
    }

    createButton.addEventListener("click", async function () {
      createButton.disabled = true;
      errorEl.hidden = true;
      var ttl = parseInt(el("ttl").value, 10);
      var response;
      try {
        response = await fetch("/v1/rooms", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ task: el("task").value, ttl_seconds: ttl }),
        });
      } catch (error) {
        return fail("Could not reach the room service. Check your connection and try again.");
      }
      if (response.status === 429) return fail("Too many new rooms from your network right now. Wait a minute and try again.");
      if (response.status === 413) return fail("That task is too large. Keep it under 1 MB.");
      if (!response.ok) return fail("The room could not be created (HTTP " + response.status + "). Try again.");
      var room;
      try {
        room = await response.json();
      } catch (error) {
        return fail("The room service returned an unreadable response.");
      }
      if (!room || typeof room.lead_invitation_message !== "string" || typeof room.guest_invitation_message !== "string" || typeof room.observer_url !== "string") {
        return fail("The room service response was missing invitation links.");
      }
      el("lead-text").textContent = room.lead_invitation_message;
      el("guest-text").textContent = room.guest_invitation_message;
      el("watch-text").textContent = room.observer_url;
      el("watch-link").setAttribute("href", room.observer_url);
      el("expiry").textContent = "The room and all three links expire at " + new Date(room.expires_at).toLocaleString() + ". The room is deleted when the result is collected, when it is closed, or when it expires.";
      el("form-panel").hidden = true;
      el("result").hidden = false;
      el("result").focus();
    });

    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof HTMLElement) || !target.dataset.copy) return;
      var text = el(target.dataset.copy).textContent || "";
      writeClipboard(text, target.dataset.success || "Copied", target, el("copy-status"));
    });
  })();
  </script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

function watchPage(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Get A Room — Live view</title>
  <style>
    :root { color-scheme: light; --paper: #f4f3ee; --ink: #15171c; --blue: #2b4bd7; --muted: #5c6068; --hair: #c9c9c0; --white: #fff; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--paper); color: var(--ink); font: 16px/1.6 "Avenir Next", Avenir, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
    .site-header { border-bottom: 1px solid var(--hair); }
    .header-inner, main { width: min(820px, calc(100% - 48px)); margin: 0 auto; }
    .header-inner { min-height: 76px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
    .brand { min-height: 44px; display: inline-flex; align-items: center; color: var(--blue); font-size: 12px; font-weight: 600; letter-spacing: .2em; text-decoration: none; text-transform: uppercase; }
    .privacy { color: var(--muted); font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
    main { padding: 68px 0 100px; }
    .eyebrow { color: var(--blue); font-size: 12px; font-weight: 600; letter-spacing: .18em; text-transform: uppercase; }
    h1 { margin: 12px 0 0; font: 400 clamp(48px, 8vw, 72px)/.98 "Iowan Old Style", Baskerville, Georgia, serif; letter-spacing: -.03em; }
    h2 { margin: 0; font: 400 28px/1.15 "Iowan Old Style", Baskerville, Georgia, serif; }
    .sub { max-width: 38rem; margin: 22px 0 34px; color: var(--muted); font-size: 17px; }
    .panel { margin-bottom: 16px; padding: 24px; border: 1px solid var(--hair); background: var(--white); }
    .status-panel { display: grid; grid-template-columns: .8fr 1.2fr; gap: 30px; align-items: start; }
    .state { display: block; font: 400 32px/1.1 "Iowan Old Style", Baskerville, Georgia, serif; }
    .state.over { color: #9f2f22; }
    .note { color: var(--muted); }
    .meta { margin-top: 10px; font-size: 14px; }
    .progress { margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, 1fr); list-style: none; border-top: 1px solid var(--hair); }
    .progress li { min-height: 64px; padding: 12px 10px 0 0; color: var(--muted); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
    .progress li + li { padding-left: 10px; border-left: 1px solid var(--hair); }
    .progress .done { color: var(--ink); }
    .progress .current { color: var(--blue); font-weight: 700; }
    details > summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; font-weight: 600; }
    button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
    pre { margin: 12px 0 0; white-space: pre-wrap; word-break: break-word; font: 13px/1.6 ui-monospace, monospace; }
    .section-label { margin: 36px 0 14px; color: var(--blue); font-size: 12px; font-weight: 600; letter-spacing: .18em; text-transform: uppercase; }
    .m { margin: 0; padding: 18px 0 18px 18px; border-left: 3px solid var(--hair); border-bottom: 1px solid var(--hair); }
    .m.creator { border-left-color: var(--blue); }
    .m.guest { border-color: #2a6f97; }
    .m .who { font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    .m.creator .who { color: var(--blue); }
    .m.guest .who { color: #2a6f97; }
    .m .when { margin-left: 8px; color: var(--muted); font-size: 12px; }
    .m p { margin: 5px 0 0; white-space: pre-wrap; word-break: break-word; }
    .file { display: flex; align-items: center; gap: 10px; margin-top: 9px; color: var(--muted); font-size: 13px; }
    button, .button { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--ink); border-radius: 0; padding: 0 16px; background: var(--ink); color: var(--paper); cursor: pointer; font: inherit; font-size: 13px; font-weight: 600; text-decoration: none; }
    button:hover, .button:hover { border-color: var(--blue); background: var(--blue); }
    button.secondary { background: transparent; color: var(--ink); }
    button.secondary:hover { background: var(--ink); color: var(--paper); }
    .file button { min-height: 44px; margin-left: auto; }
    .final-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
    .final-content { margin-top: 16px; padding-top: 18px; border-top: 1px solid var(--hair); }
    .final-content h3, .final-content h4, .final-content h5, .final-content h6 { margin: 22px 0 8px; font-family: "Iowan Old Style", Baskerville, Georgia, serif; font-weight: 400; }
    .final-content h3 { font-size: 28px; } .final-content h4 { font-size: 22px; } .final-content h5 { font-size: 18px; } .final-content h6 { font-size: 16px; }
    .final-content p, .final-content ul, .final-content ol { margin: 10px 0; }
    .final-content code, .final-content pre { padding: 12px; background: var(--paper); }
    .deletion-note { margin-top: 24px; padding: 16px 18px; border-left: 3px solid #9f2f22; background: rgba(255,255,255,.5); }
    @media (max-width: 620px) { .status-panel { grid-template-columns: 1fr; } .progress { grid-template-columns: 1fr 1fr; } .progress li:nth-child(3) { border-left: 0; } }
    @media (max-width: 520px) { .header-inner, main { width: min(100% - 32px, 820px); } .header-inner { min-height: 68px; } main { padding: 52px 0 80px; } .panel { margin-inline: -16px; padding: 22px 16px; border-inline: 0; } .privacy { display: none; } .final-actions { flex-direction: column; } .final-actions button { width: 100%; } }
  </style>
</head>
<body>
  <header class="site-header"><div class="header-inner"><a class="brand" href="/">Get A Room</a><span class="privacy">Private · read only</span></div></header>
  <main>
  <div class="eyebrow">Observer window</div>
  <h1>Watch the work.</h1>
  <p class="sub">A calm, read-only view of the room. It refreshes automatically; you do not need to manage the agents from here.</p>
  <div class="panel status-panel">
    <div><span class="state" id="state" role="status" aria-live="polite">Connecting…</span><div class="note meta" id="expiry"></div><div class="note meta" id="counts"></div></div>
    <ol class="progress" aria-label="Room progress"><li id="progress-ready">Room ready</li><li id="progress-working">Agents working</li><li id="progress-guest">Guest ready</li><li id="progress-final">Final ready</li></ol>
  </div>
  <div class="panel" id="task-panel" hidden>
    <details><summary>Task</summary><pre id="task"></pre></details>
  </div>
  <div class="panel" id="final-panel" hidden>
    <details open><summary>Final result</summary><div class="final-content" id="final"></div></details>
    <div class="final-actions"><button type="button" id="copy-final">Copy final</button><button class="secondary" type="button" id="download-final">Download Markdown</button></div>
  </div>
  <div class="section-label" id="transcript-label" hidden>Room transcript</div>
  <div id="transcript"></div>
  <p class="note" id="note" role="status" aria-live="polite"></p>
  </main>
  <script>
  (function () {
    "use strict";
    function el(id) { return document.getElementById(id); }
    var stateEl = el("state"), expiryEl = el("expiry"), countsEl = el("counts"), noteEl = el("note");

    var invite = new URLSearchParams(location.hash.slice(1)).get("invite") || "";
    var claims = null;
    try {
      var payload = invite.split(".")[0] || "";
      var padded = payload.replace(/-/g, "+").replace(/_/g, "/");
      padded += "===".slice(0, (4 - (padded.length % 4)) % 4);
      claims = JSON.parse(atob(padded));
    } catch (error) { claims = null; }
    if (!claims || claims.role !== "observer" || typeof claims.room_id !== "string" || !/^[0-9a-f]{32}$/.test(claims.room_id)) {
      stateEl.textContent = "Not a watch link";
      stateEl.className = "state over";
      noteEl.textContent = "This page needs a complete observer link ending in #invite=… Ask the room creator for a fresh live-view link.";
      return;
    }

    var base = "/v1/rooms/" + claims.room_id;
    var headers = { authorization: "Bearer " + invite };
    var lastNumber = 0, haveTask = false, haveFinal = false, guestReady = false, over = false, timer = null, finalMarkdown = "", currentInfo = null;

    function setProgress(stage) {
      var ids = ["progress-ready", "progress-working", "progress-guest", "progress-final"];
      ids.forEach(function (id, index) {
        el(id).className = index < stage ? "done" : index === stage ? "current" : "";
      });
    }

    function updateLifecycle(info) {
      currentInfo = info;
      var stage = info.status === "finalized" || info.has_final ? 3 : guestReady ? 2 : info.message_count > 0 ? 1 : 0;
      var labels = ["Room ready", "Agents working", "Guest ready — lead finalizing", "Final ready"];
      stateEl.textContent = labels[stage];
      stateEl.className = "state";
      setProgress(stage);
    }

    function finish(state, note) {
      over = true;
      if (timer) clearInterval(timer);
      stateEl.textContent = state;
      stateEl.className = "state over";
      noteEl.textContent = note;
      noteEl.className = "note deletion-note";
    }

    function renderMarkdown(markdown) {
      var root = el("final");
      root.replaceChildren();
      var lines = markdown.replace(/\\r\\n?/g, "\\n").split("\\n");
      function startsBlock(value) {
        return value.indexOf("\x60\x60\x60") === 0 || /^(?:#{1,6}\\s+|[-*]\\s+|\\d+\\.\\s+)/.test(value);
      }
      var index = 0;
      while (index < lines.length) {
        var line = lines[index];
        if (!line || !line.trim()) { index += 1; continue; }
        if (line.indexOf("\x60\x60\x60") === 0) {
          var codeLines = [];
          index += 1;
          while (index < lines.length && lines[index].indexOf("\x60\x60\x60") !== 0) { codeLines.push(lines[index]); index += 1; }
          if (index < lines.length) index += 1;
          var pre = document.createElement("pre");
          var code = document.createElement("code");
          code.textContent = codeLines.join("\\n");
          pre.appendChild(code);
          root.appendChild(pre);
          continue;
        }
        var heading = /^(#{1,6})\\s+(.+)$/.exec(line);
        if (heading) {
          var headingNode = document.createElement("h" + Math.min(heading[1].length + 2, 6));
          headingNode.textContent = heading[2];
          root.appendChild(headingNode);
          index += 1;
          continue;
        }
        if (/^[-*]\\s+/.test(line)) {
          var unordered = document.createElement("ul");
          while (index < lines.length && /^[-*]\\s+/.test(lines[index])) {
            var item = document.createElement("li");
            item.textContent = lines[index].replace(/^[-*]\\s+/, "");
            unordered.appendChild(item);
            index += 1;
          }
          root.appendChild(unordered);
          continue;
        }
        if (/^\\d+\\.\\s+/.test(line)) {
          var ordered = document.createElement("ol");
          while (index < lines.length && /^\\d+\\.\\s+/.test(lines[index])) {
            var orderedItem = document.createElement("li");
            orderedItem.textContent = lines[index].replace(/^\\d+\\.\\s+/, "");
            ordered.appendChild(orderedItem);
            index += 1;
          }
          root.appendChild(ordered);
          continue;
        }
        var paragraphLines = [line.trim()];
        index += 1;
        while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
          paragraphLines.push(lines[index].trim());
          index += 1;
        }
        var paragraph = document.createElement("p");
        paragraph.textContent = paragraphLines.join(" ");
        root.appendChild(paragraph);
      }
    }

    function addMessage(message) {
      var wrap = document.createElement("div");
      wrap.className = "m " + (message.role === "creator" ? "creator" : "guest");
      var who = document.createElement("span");
      who.className = "who";
      who.textContent = message.role === "creator" ? "Lead" : "Guest";
      var when = document.createElement("span");
      when.className = "when";
      if (message.created_at) when.textContent = new Date(message.created_at).toLocaleString();
      var text = document.createElement("p");
      text.textContent = message.text;
      wrap.appendChild(who);
      wrap.appendChild(when);
      wrap.appendChild(text);
      if (message.role === "guest" && /^READY\\b/i.test(String(message.text || "").trim())) guestReady = true;
      var attachments = Array.isArray(message.attachments) ? message.attachments : [];
      attachments.forEach(function (attachment) {
        var file = document.createElement("div");
        file.className = "file";
        var label = document.createElement("span");
        label.textContent = attachment.filename + " · " + attachment.size + " bytes";
        var button = document.createElement("button");
        button.type = "button";
        button.textContent = "Download";
        button.addEventListener("click", async function () {
          button.disabled = true;
          try {
            var response = await get("/attachments/" + encodeURIComponent(attachment.id));
            if (!response.ok) throw new Error("download failed");
            var bytes = new Uint8Array(await response.arrayBuffer());
            var digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
            var sha256 = Array.from(digest).map(function (byte) { return byte.toString(16).padStart(2, "0"); }).join("");
            if (bytes.byteLength !== attachment.size || sha256 !== attachment.sha256) throw new Error("integrity check failed");
            var blob = new Blob([bytes], { type: response.headers.get("content-type") || "application/octet-stream" });
            var url = URL.createObjectURL(blob);
            var link = document.createElement("a");
            link.href = url;
            link.download = attachment.filename;
            link.click();
            URL.revokeObjectURL(url);
          } catch (error) {
            noteEl.textContent = "The attachment could not be downloaded.";
          } finally {
            button.disabled = false;
          }
        });
        file.appendChild(label);
        file.appendChild(button);
        wrap.appendChild(file);
      });
      el("transcript").appendChild(wrap);
      el("transcript-label").hidden = false;
      if (currentInfo) updateLifecycle(currentInfo);
    }

    function get(path) { return fetch(base + path, { headers: headers }); }

    async function tick() {
      if (over) return;
      var status;
      try {
        status = await get("/status");
      } catch (error) {
        noteEl.textContent = "Connection lost. Retrying…";
        return;
      }
      if (status.status === 401) return finish("Link expired", "This observer link is no longer valid. Any content already visible here is only an unsaved in-tab copy.");
      if (status.status === 410) return finish("Room deleted", haveFinal
        ? "The backend room and files have been deleted. This page is showing only an unsaved in-tab copy; copy or download the final result before refreshing."
        : "The backend room and files have been deleted. Any content still visible is only an unsaved in-tab copy and will disappear when you refresh.");
      if (!status.ok) { noteEl.textContent = "Temporary error. Retrying…"; return; }
      var info = await status.json();
      noteEl.textContent = "";
      noteEl.className = "note";
      updateLifecycle(info);
      expiryEl.textContent = "Room expires " + new Date(info.expires_at).toLocaleString();
      countsEl.textContent = info.message_count + " message" + (info.message_count === 1 ? "" : "s") +
        " · " + (info.attachment_count || 0) + " file" + (info.attachment_count === 1 ? "" : "s");

      if (!haveTask) {
        var task = await get("/task");
        if (task.ok) {
          var taskBody = await task.json();
          el("task").textContent = taskBody.task;
          el("task-panel").hidden = false;
          haveTask = true;
        }
      }

      var messages = await get("/messages?after=" + lastNumber);
      if (messages.ok) {
        var list = (await messages.json()).messages || [];
        for (var index = 0; index < list.length; index += 1) {
          addMessage(list[index]);
          if (list[index].number > lastNumber) lastNumber = list[index].number;
        }
      }

      if (info.has_final && !haveFinal) {
        var final = await get("/final");
        if (final.ok) {
          var finalBody = await final.json();
          finalMarkdown = finalBody.markdown;
          renderMarkdown(finalMarkdown);
          el("final-panel").hidden = false;
          haveFinal = true;
          updateLifecycle(info);
        }
      }
    }

    el("copy-final").addEventListener("click", function () {
      navigator.clipboard.writeText(finalMarkdown).then(function () {
        noteEl.textContent = "Final result copied.";
      }, function () {
        noteEl.textContent = "Clipboard access was blocked. Select the final result and copy it manually.";
      });
    });

    el("download-final").addEventListener("click", function () {
      var blob = new Blob([finalMarkdown], { type: "text/markdown;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = "get-a-room-final.md";
      link.click();
      URL.revokeObjectURL(url);
      noteEl.textContent = "Final Markdown downloaded.";
    });

    setProgress(0);
    tick();
    timer = setInterval(tick, 4000);
  })();
  </script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

const MAX_AGENT_ENVELOPE_BYTES = MAX_FINAL_BYTES + 16 * 1024;
const MAX_INVITATION_BYTES = 16 * 1024;

async function agentRequest(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request, MAX_AGENT_ENVELOPE_BYTES);
  const action = requiredString(body.action, "action", 16);
  const agentActions = ["join", "say", "check", "finish", "final", "collect", "close"];
  if (!agentActions.includes(action)) {
    throw new HttpError(400, "invalid_request", "action must be join, say, check, finish, final, collect, or close");
  }
  const allowedFields =
    action === "say"
      ? ["action", "invitation", "text"]
      : action === "check"
        ? ["action", "invitation", "after", "wait_seconds"]
        : action === "finish"
          ? ["action", "invitation", "markdown"]
          : action === "collect"
            ? ["action", "invitation", "sha256"]
            : ["action", "invitation"];
  assertAgentFields(body, allowedFields);
  const invitation = requiredString(body.invitation, "invitation", MAX_INVITATION_BYTES);
  const token = invitationToken(invitation, request, env);
  const verified = await inspectUnscopedInvite(env.ROOM_SIGNING_SECRET, token);
  if (verified.expired) throw new HttpError(401, "expired_invite", "Invite has expired");
  if (verified.claims.role === "observer") throw new HttpError(403, "forbidden", "A lead or guest invitation is required");

  const { room_id: roomId, role } = verified.claims;
  await enforceRoomRequestLimit(roomId, env);
  const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));

  if (action === "finish") {
    const markdown = requiredString(body.markdown, "markdown", MAX_FINAL_BYTES);
    const result = await agentInternalJson(stub, role, "/final", "POST", { markdown });
    return json({ role: "lead", ...result, next_actions: agentNextActions(role, "finalized") });
  }
  if (action === "final") {
    const result = await agentInternalJson(stub, role, "/final");
    return json({ role: "lead", ...result, next_actions: agentNextActions(role, "finalized") });
  }
  if (action === "collect") {
    const sha256 = requiredString(body.sha256, "sha256", 64);
    const result = await agentInternalJson(stub, role, "/collect", "POST", { sha256 });
    return json({ role: "lead", ...result, next_actions: [] });
  }
  if (action === "close") {
    const result = await agentInternalJson(stub, role, "/", "DELETE");
    return json({ role: "lead", ...result, next_actions: [] });
  }

  if (action === "say") {
    const text = requiredString(body.text, "text", MAX_MESSAGE_BYTES);
    const message = await agentInternalJson(stub, role, "/messages", "POST", { text });
    return json({ role: agentRoleName(role), ...message, next_actions: agentNextActions(role, "open") });
  }

  const after = action === "check" ? boundedAgentInteger(body.after, "after", 0, Number.MAX_SAFE_INTEGER, 0) : 0;
  const wait = action === "check" ? boundedAgentInteger(body.wait_seconds, "wait_seconds", 0, MAX_LONG_POLL_SECONDS, 0) : 0;
  const status = await agentInternalJson(stub, role, "/status");
  const messages = await agentInternalJson(stub, role, `/messages?after=${after}&wait=${wait}`);
  const messageList: unknown[] = Array.isArray(messages.messages) ? (messages.messages as unknown[]) : [];
  const nextCursor = messageList.reduce<number>(
    (cursor, message) =>
      typeof message === "object" && message !== null && typeof (message as { number?: unknown }).number === "number"
        ? Math.max(cursor, (message as { number: number }).number)
        : cursor,
    after,
  );
  const state = status.status === "finalized" ? "finalized" : "open";
  const common = {
    role: agentRoleName(role),
    status,
    messages: messageList,
    next_cursor: nextCursor,
    next_actions: agentNextActions(role, state),
  };
  if (action === "check") return json(common);
  const task = await agentInternalJson(stub, role, "/task");
  return json({ ...common, task: task.task });
}

function invitationToken(invitation: string, request: Request, env: Env): string {
  let url: URL;
  try {
    url = new URL(invitation);
  } catch {
    throw new HttpError(400, "invalid_invitation_url", "invitation must be a complete Get A Room invitation URL");
  }
  const expected = new URL(publicBaseUrl(request, env));
  if (
    url.origin !== expected.origin ||
    url.pathname !== "/join" ||
    url.search !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new HttpError(400, "invalid_invitation_url", "Invitation URL host or path is not trusted");
  }
  const fragment = new URLSearchParams(url.hash.slice(1));
  if ([...fragment.keys()].length !== 1 || !fragment.has("invite")) {
    throw new HttpError(400, "invalid_invitation_url", "Invitation URL must contain one invite fragment");
  }
  return requiredString(fragment.get("invite"), "invitation credential", MAX_INVITATION_BYTES);
}

async function agentInternalJson(
  stub: DurableObjectStub,
  role: "creator" | "guest",
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const headers = new Headers({ "x-room-role": role });
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await stub.fetch(`https://room.internal${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof value.error === "string" ? value.error : "room_request_failed";
    const message = typeof value.message === "string" ? value.message : "Room request failed";
    const retryAfter = response.headers.get("retry-after");
    throw new HttpError(response.status, code, message, retryAfter === null ? {} : { "retry-after": retryAfter });
  }
  return value;
}

function boundedAgentInteger(value: unknown, name: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new HttpError(400, "invalid_request", `${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function assertAgentFields(body: Record<string, unknown>, allowedFields: string[]): void {
  const allowed = new Set(allowedFields);
  const unexpected = Object.keys(body).find((field) => !allowed.has(field));
  if (unexpected) throw new HttpError(400, "invalid_request", `Unexpected field: ${unexpected}`);
}

function agentRoleName(role: "creator" | "guest"): "lead" | "guest" {
  return role === "creator" ? "lead" : "guest";
}

function agentNextActions(role: "creator" | "guest", state: "open" | "finalized"): string[] {
  if (role === "guest") return state === "open" ? ["say", "check"] : ["check"];
  return state === "open" ? ["say", "check", "finish", "close"] : ["check", "final", "collect", "close"];
}

async function createRoom(request: Request, env: Env): Promise<Response> {
  rejectOversizedCreationBody(request);
  const body = await readJson(request, MAX_TASK_BYTES + 4096);
  assertCreationFields(body);
  const task = requiredString(body.task, "task", MAX_TASK_BYTES, { allowEmpty: true });
  const ttlSecondsValue = body.ttl_seconds ?? body.ttl ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSecondsValue) || (ttlSecondsValue as number) < MIN_TTL_SECONDS || (ttlSecondsValue as number) > MAX_TTL_SECONDS) {
    throw new HttpError(400, "invalid_ttl", `ttl_seconds must be between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS}`);
  }
  await enforceCreationLimit(request, env);

  const roomId = randomRoomId();
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = issuedAt + (ttlSecondsValue as number);
  const expiresAtMs = expiresAtSeconds * 1000;
  const expiresAt = new Date(expiresAtMs).toISOString();
  const baseUrl = publicBaseUrl(request, env);
  const [creator, guest, observer] = await Promise.all([
    createInvite(env.ROOM_SIGNING_SECRET, roomId, "creator", issuedAt, expiresAtSeconds),
    createInvite(env.ROOM_SIGNING_SECRET, roomId, "guest", issuedAt, expiresAtSeconds),
    createInvite(env.ROOM_SIGNING_SECRET, roomId, "observer", issuedAt, expiresAtSeconds),
  ]);
  const guestInviteUrl = `${baseUrl}/join#invite=${encodeURIComponent(guest)}`;
  const leadInviteUrl = `${baseUrl}/join#invite=${encodeURIComponent(creator)}`;
  const observerUrl = `${baseUrl}/watch#invite=${encodeURIComponent(observer)}`;

  const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  const initialization = await stub.fetch("https://room.internal/_initialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room_id: roomId, task, created_at: issuedAt * 1000, expires_at: expiresAtMs }),
  });
  if (!initialization.ok) throw new HttpError(500, "room_initialization_failed", "Could not initialize room");

  return json(
    {
      room_id: roomId,
      expires_at: expiresAt,
      creator_capability: creator,
      guest_invitation_url: guestInviteUrl,
      guest_invitation_message: invitationMessage(guestInviteUrl, expiresAt),
      lead_invitation_url: leadInviteUrl,
      lead_invitation_message: leadInvitationMessage(leadInviteUrl, expiresAt),
      observer_url: observerUrl,
      observer_message: observerMessage(observerUrl, expiresAt),
    },
    201,
  );
}

async function enforceCreationLimit(request: Request, env: Env): Promise<void> {
  const key = await creationKey(request);
  const result = await env.ROOM_CREATION_RATE_LIMITER.limit({ key });
  if (!result.success) {
    throw new HttpError(429, "creation_rate_limited", "Too many room creation attempts; try again later", {
      "retry-after": String(CREATION_RATE_LIMIT_WINDOW_SECONDS),
    });
  }
}

async function enforceRoomRequestLimit(roomId: string, env: Env): Promise<void> {
  const result = await env.ROOM_REQUEST_RATE_LIMITER.limit({ key: roomId });
  if (!result.success) {
    throw new HttpError(429, "room_rate_limited", "Too many requests to this room", {
      "retry-after": String(ROOM_REQUEST_RATE_LIMIT_WINDOW_SECONDS),
    });
  }
}

async function creationKey(request: Request): Promise<string> {
  const caller = request.headers.get("cf-connecting-ip") ?? "unknown";
  const bytes = new TextEncoder().encode(caller);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rejectOversizedCreationBody(request: Request): void {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > MAX_TASK_BYTES + 4096) {
    throw new HttpError(413, "content_too_large", "Creation request exceeds the size limit");
  }
}

function assertCreationFields(body: Record<string, unknown>): void {
  const allowed = new Set(["task", "ttl", "ttl_seconds"]);
  const unexpected = Object.keys(body).find((key) => !allowed.has(key));
  if (unexpected) throw new HttpError(400, "invalid_request", `Unexpected creation field: ${unexpected}`);
}

function publicBaseUrl(request: Request, env: Env): string {
  if (!env.PUBLIC_BASE_URL) return new URL(request.url).origin;
  let parsed: URL;
  try {
    parsed = new URL(env.PUBLIC_BASE_URL);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be an absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("PUBLIC_BASE_URL must use HTTP or HTTPS");
  return parsed.toString().replace(/\/$/u, "");
}

function leadInvitationMessage(leadInviteUrl: string, expiresAt: string): string {
  const origin = new URL(leadInviteUrl).origin;
  return [
    "Get A Room — lead invitation",
    "",
    `Instructions: ${origin}/agents/lead.md`,
    `Private invitation: ${leadInviteUrl}`,
    "",
    `Expires: ${expiresAt}`,
    "Follow the lead instructions. Keep the invitation private and return only the guest invitation plus observer URL to the human.",
  ].join("\n");
}

function observerMessage(observerUrl: string, expiresAt: string): string {
  return [
    "Get A Room live view",
    "",
    "Open this private link in a browser to watch the room conversation live:",
    observerUrl,
    "",
    `It is read-only and expires at ${expiresAt}. Treat it like a password.`,
  ].join("\n");
}

function invitationMessage(guestInviteUrl: string, expiresAt: string): string {
  const origin = new URL(guestInviteUrl).origin;
  return [
    "Get A Room — guest invitation",
    "",
    `Instructions: ${origin}/agents/guest.md`,
    `Private invitation: ${guestInviteUrl}`,
    "",
    `Expires: ${expiresAt}`,
    "Follow the guest instructions and keep the invitation private.",
  ].join("\n");
}

function randomRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
