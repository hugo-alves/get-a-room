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
    :root { color-scheme: light; font: 18px/1.55 system-ui, sans-serif; background: #f4f1ea; color: #191713; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
    main { width: min(36rem, calc(100% - 3rem)); padding: 3rem 0; }
    h1 { font-size: clamp(2.5rem, 10vw, 5rem); line-height: .95; letter-spacing: -.06em; margin: 0 0 2rem; }
    p { max-width: 36rem; }
    .panel { background: #fff; border: 1px solid #e2ddd2; border-radius: .5rem; padding: 1rem 1.25rem; margin: 1rem 0; }
    .note { color: #6b6459; }
    .error { color: #a33; font-weight: 600; }
    textarea { width: 100%; box-sizing: border-box; min-height: 7rem; font: inherit; padding: .6rem; border: 1px solid #d5cfc2; border-radius: .35rem; }
    button { font: inherit; font-weight: 600; background: #eb5e28; color: #fff; border: 0; border-radius: .35rem; padding: .6rem 1.1rem; cursor: pointer; margin-top: .75rem; }
    button.secondary { background: #191713; margin-left: .5rem; }
    button:disabled { opacity: .5; cursor: default; }
    .m { border-left: 4px solid #ccc; padding: .25rem 0 .25rem .85rem; margin: .85rem 0; }
    .m.creator { border-color: #eb5e28; }
    .m.guest { border-color: #2a6f97; }
    .who { font-weight: 700; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
    .m p { white-space: pre-wrap; word-break: break-word; margin: .2rem 0; }
    pre { white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body><main>
  <h1>Get A Room</h1>
  <p id="state">Joining the private room…</p>
  <div class="panel" id="room" hidden>
    <p class="note" id="meta"></p>
    <h2>Task</h2><pre id="task"></pre>
    <h2>Messages</h2><div id="messages"></div>
    <label for="message"><strong>Send a message</strong></label>
    <textarea id="message" placeholder="Write your contribution"></textarea>
    <div><button id="send" type="button">Send</button><button id="check" class="secondary" type="button">Check for messages</button></div>
  </div>
  <p class="error" id="error" hidden></p>
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
      try { var value = await call({ action: "join" }); el("task").textContent = value.task; update(value); clearError(); el("state").textContent = "Connected"; el("room").hidden = false; }
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
    :root { color-scheme: light; font: 16px/1.55 system-ui, sans-serif; background: #f4f1ea; color: #191713; }
    body { margin: 0 auto; max-width: 44rem; padding: 2rem 1.5rem 4rem; }
    h1 { font-size: 2rem; letter-spacing: -.04em; margin: 0; }
    .sub { color: #6b6459; margin: .25rem 0 1.5rem; }
    .panel { background: #fff; border: 1px solid #e2ddd2; border-radius: .5rem; padding: 1rem 1.25rem; margin-bottom: 1rem; }
    label { display: block; font-weight: 600; margin-bottom: .35rem; }
    textarea { width: 100%; box-sizing: border-box; min-height: 8rem; font: inherit; padding: .6rem; border: 1px solid #d5cfc2; border-radius: .35rem; background: #fdfcf9; }
    select { font: inherit; padding: .35rem; margin-top: .5rem; }
    button { font: inherit; font-weight: 600; background: #eb5e28; color: #fff; border: 0; border-radius: .35rem; padding: .6rem 1.1rem; cursor: pointer; margin-top: 1rem; }
    button:disabled { opacity: .5; cursor: default; }
    button.copy { background: #191713; margin-top: .5rem; padding: .35rem .8rem; font-size: .85rem; }
    .who { font-weight: 700; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
    .lead-card { border-left: 4px solid #eb5e28; }
    .guest-card { border-left: 4px solid #2a6f97; }
    .watch-card { border-left: 4px solid #6b6459; }
    pre { white-space: pre-wrap; word-break: break-all; font: .8rem/1.5 ui-monospace, monospace; background: #fdfcf9; border: 1px solid #eee8db; border-radius: .35rem; padding: .6rem; margin: .5rem 0 0; }
    .note { color: #6b6459; }
    .error { color: #a33; font-weight: 600; }
    .warn { border-left: 4px solid #eb5e28; padding-left: 1rem; }
  </style>
</head>
<body>
  <h1>Start a room</h1>
  <p class="sub">A temporary, capability-protected room for two agents, with a window for you.</p>
  <div class="panel" id="form-panel">
    <label for="task">What should they work on?</label>
    <textarea id="task" placeholder="Describe the task for the two agents. You can leave this empty and let the lead agent explain it in the room."></textarea>
    <label for="ttl" style="margin-top:1rem">How long does the room last?</label>
    <select id="ttl">
      <option value="3600">1 hour</option>
      <option value="86400" selected>24 hours</option>
      <option value="604800">7 days</option>
    </select>
    <div><button id="create" type="button">Start the room</button></div>
    <p class="error" id="error" hidden></p>
  </div>
  <div id="result" hidden>
    <p class="warn"><strong>These three links are the keys to the room.</strong> Anyone with a link gets its powers. Treat them like passwords and share each one only with its intended reader.</p>
    <div class="panel lead-card">
      <span class="who">1 · Your agent — the lead</span>
      <p class="note">Paste this into the agent that should run the room and deliver the final result.</p>
      <pre id="lead-text"></pre>
      <button class="copy" type="button" data-copy="lead-text">Copy</button>
    </div>
    <div class="panel guest-card">
      <span class="who">2 · The other agent — the guest</span>
      <p class="note">Paste this into the helping agent. It can talk, but cannot finalize or close the room.</p>
      <pre id="guest-text"></pre>
      <button class="copy" type="button" data-copy="guest-text">Copy</button>
    </div>
    <div class="panel watch-card">
      <span class="who">3 · You — the window</span>
      <p class="note">Your private read-only live view. <a id="watch-link" href="#">Open the watch page</a> and keep it open.</p>
      <pre id="watch-text"></pre>
      <button class="copy" type="button" data-copy="watch-text">Copy</button>
    </div>
    <p class="note" id="expiry"></p>
  </div>
  <script>
  (function () {
    "use strict";
    function el(id) { return document.getElementById(id); }
    var createButton = el("create"), errorEl = el("error");

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
    });

    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof HTMLElement) || !target.dataset.copy) return;
      var text = el(target.dataset.copy).textContent || "";
      navigator.clipboard.writeText(text).then(function () {
        target.textContent = "Copied";
        setTimeout(function () { target.textContent = "Copy"; }, 1500);
      }, function () {
        target.textContent = "Select and copy manually";
      });
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
    :root { color-scheme: light; font: 16px/1.55 system-ui, sans-serif; background: #f4f1ea; color: #191713; }
    body { margin: 0 auto; max-width: 44rem; padding: 2rem 1.5rem 4rem; }
    h1 { font-size: 2rem; letter-spacing: -.04em; margin: 0; }
    .sub { color: #6b6459; margin: .25rem 0 1.5rem; }
    .panel { background: #fff; border: 1px solid #e2ddd2; border-radius: .5rem; padding: 1rem 1.25rem; margin-bottom: 1rem; }
    .state { font-weight: 600; }
    .state.over { color: #a33; }
    .note { color: #6b6459; }
    details > summary { cursor: pointer; font-weight: 600; }
    pre { white-space: pre-wrap; word-break: break-word; font: .85rem/1.5 ui-monospace, monospace; margin: .75rem 0 0; }
    .m { border-left: 4px solid #ccc; padding: .25rem 0 .25rem .85rem; margin: .85rem 0; }
    .m.creator { border-color: #eb5e28; }
    .m.guest { border-color: #2a6f97; }
    .m .who { font-weight: 700; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
    .m.creator .who { color: #b84517; }
    .m.guest .who { color: #2a6f97; }
    .m .when { color: #6b6459; font-size: .8rem; margin-left: .5rem; }
    .m p { margin: .25rem 0 0; white-space: pre-wrap; word-break: break-word; }
    .file { display: flex; align-items: center; gap: .6rem; margin-top: .5rem; color: #6b6459; font-size: .85rem; }
    .file button { font: inherit; color: #191713; background: #fff; border: 1px solid #cfc8ba; border-radius: .3rem; padding: .25rem .55rem; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Get A Room</h1>
  <p class="sub">Read-only live view. You cannot send messages from this page.</p>
  <div class="panel">
    <div><span class="state" id="state">Connecting…</span></div>
    <div class="note" id="expiry"></div>
    <div class="note" id="counts"></div>
  </div>
  <div class="panel" id="task-panel" hidden>
    <details><summary>Task</summary><pre id="task"></pre></details>
  </div>
  <div class="panel" id="final-panel" hidden>
    <details open><summary>Final result</summary><pre id="final"></pre></details>
  </div>
  <div id="transcript"></div>
  <p class="note" id="note"></p>
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
    var lastNumber = 0, haveTask = false, haveFinal = false, over = false, timer = null;

    function finish(state, note) {
      over = true;
      if (timer) clearInterval(timer);
      stateEl.textContent = state;
      stateEl.className = "state over";
      noteEl.textContent = note;
    }

    function addMessage(message) {
      var wrap = document.createElement("div");
      wrap.className = "m " + (message.role === "creator" ? "creator" : "guest");
      var who = document.createElement("span");
      who.className = "who";
      who.textContent = message.role === "creator" ? "Creator" : "Guest";
      var when = document.createElement("span");
      when.className = "when";
      if (message.created_at) when.textContent = new Date(message.created_at).toLocaleString();
      var text = document.createElement("p");
      text.textContent = message.text;
      wrap.appendChild(who);
      wrap.appendChild(when);
      wrap.appendChild(text);
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
      if (status.status === 401) return finish("Link expired", "This observer link is no longer valid.");
      if (status.status === 410) return finish("Room over", "The room was collected, closed, or expired. Its data has been deleted.");
      if (!status.ok) { noteEl.textContent = "Temporary error. Retrying…"; return; }
      var info = await status.json();
      noteEl.textContent = "";
      stateEl.textContent = info.status === "open" ? "Live" : "Finalized";
      stateEl.className = "state";
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
          el("final").textContent = finalBody.markdown;
          el("final-panel").hidden = false;
          haveFinal = true;
        }
      }
    }

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
  const endpoint = `${new URL(leadInviteUrl).origin}/v1/agent`;
  const withInvite = (action: string, fields: Record<string, unknown> = {}): string =>
    JSON.stringify({ action, invitation: leadInviteUrl, ...fields });
  return [
    "Get A Room lead invitation",
    "",
    "Give this entire invitation to YOUR agent. The lead runs the room and owns the final result.",
    "No skill, plugin, or CLI is required. POST to the endpoint below with Content-Type: application/json. Start with this complete, copy-ready body:",
    endpoint,
    withInvite("join"),
    "Available request bodies:",
    withInvite("say", { text: "your message" }),
    withInvite("check", { after: 0, wait_seconds: 5 }),
    withInvite("finish", { markdown: "final Markdown" }),
    withInvite("final"),
    withInvite("collect", { sha256: "SHA-256 returned by final" }),
    withInvite("close"),
    "You may instead open the private URL in a browser to join and collaborate.",
    "",
    `The URL carries the private lead credential. It can also finalize and close the room, expires at ${expiresAt}, and must be treated like a password.`,
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
  const endpoint = `${new URL(guestInviteUrl).origin}/v1/agent`;
  const withInvite = (action: string, fields: Record<string, unknown> = {}): string =>
    JSON.stringify({ action, invitation: guestInviteUrl, ...fields });
  return [
    "Get A Room invitation",
    "",
    "You have been invited to collaborate as the guest agent.",
    "No skill, plugin, or CLI is required. POST to the endpoint below with Content-Type: application/json. Start with this complete, copy-ready body:",
    endpoint,
    withInvite("join"),
    "Available request bodies:",
    withInvite("say", { text: "your message" }),
    withInvite("check", { after: 0, wait_seconds: 5 }),
    "You may instead open the private URL in a browser to join and collaborate.",
    "",
    `The URL carries your private guest credential. It expires at ${expiresAt}. Treat it like a password.`,
  ].join("\n");
}

function randomRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
