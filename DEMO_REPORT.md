# Get A Room acceptance report

## Current result

Completed on 2026-08-05. The branded Cloudflare Worker is live at:

`https://get-a-room.pissa.workers.dev`

The implementation keeps the proven room transport and adds the simpler product surface:

- a lead agent creates a room and receives one ready-to-forward invitation;
- a guest agent joins from the complete invitation text;
- each machine remembers its own room state privately;
- agents use `say` and `check` without handling tokens, room IDs, message numbers, or cursors;
- only the lead can submit and collect the final result;
- a Codex plugin teaches both roles the workflow.

## Automated verification

```text
plugin validation  -> passed
skill validation   -> passed
pnpm typecheck     -> passed
pnpm lint          -> passed
pnpm test          -> 3 files, 14 tests, all passed
```

The Worker tests exercise the real Cloudflare SQLite Durable Object runtime: creation, branded join page headers, role capabilities, task access, ordered messaging, invitation tampering and expiry, size and message limits, SHA-256 collection, manual closure, and alarm cleanup.

The CLI tests verify secret-safe creation, restrictive session permissions, joining from a forwarded invitation, collection integrity, and diagnostic redaction.

## Production acceptance

Two isolated `GET_A_ROOM_HOME` directories represented two different machines. The production path verified:

- lead room creation and guest join from the forwarded invitation;
- four ordered coordination messages, including a final `READY` from the guest;
- lead-only final submission;
- collected bytes exactly matching submitted bytes;
- SHA-256 `d7a4bf671a06b940eb27bcf9a04bcb37155c3d92bea582c99166c2b1328e3c8a`;
- `HTTP 410` after collection, confirming cleanup.

The first guest request was made immediately after the initial deployment and briefly received a propagation-time `404`. The same invitation succeeded on retry; direct checks of both task and status routes returned `200`. This was confined to the seconds after first deployment, not an invitation or room-state failure.

## Security and scope

- Invitations never appear in this report, Git, or Worker content logs.
- The join link stores its private capability in the URL fragment, which browsers do not send to the Worker join page.
- Local session directories and files use modes `700` and `600`.
- Preview deployment URLs are disabled; the named workers.dev route remains enabled.
- Invitations are bearer capabilities reusable until room expiry or closure. They are short-lived passwords, not single-use links.
- The service intentionally has no accounts, dashboard, agent execution, transcript archive, or external database.

The earlier Portuguese Worker remains untouched; the product deployment uses the new `get-a-room` Worker name.
