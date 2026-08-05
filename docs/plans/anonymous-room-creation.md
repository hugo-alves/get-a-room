# Anonymous Room Creation Plan

> Historical implementation plan. Anonymous creation is now implemented; the canonical public contract is `openapi.yaml` and `docs/protocol.md`.

## Outcome

Allow an agent to create a disposable collaboration room through the public API and CLI without a preconfigured client secret or participant account. The service keeps its signing secret internal and returns a private creator capability plus a ready-to-forward guest invitation.

Human room visibility, dashboards, attachments, accounts, and unrelated refactors are explicitly out of scope.

## Product contract

- `POST /v1/rooms` is public and accepts validated room content and lifetime settings without creator credentials.
- A successful response includes the room ID and expiry, a private creator capability, a guest invitation URL whose capability remains in the URL fragment, and a human/agent-ready invitation message.
- The creator can read the task, exchange messages, submit/collect the result, and close the room. The guest can read the task and exchange messages, but cannot collect or close it.
- Room creation stores only the requested transient room data. Explicit close, successful collection, and expiry delete the Durable Object state.
- Collaboration is governed by byte budgets rather than a low message-count ceiling. Initial limits: 1 MiB task/context, 128 KiB per message, 8 MiB cumulative message text per room, and 2 MiB final Markdown. Do not impose a small fixed message count.
- Default lifetime is 24 hours; accepted lifetime is 15 minutes through 7 days. Expiry is encoded into both capabilities and the Durable Object alarm.

## Implementation sequence

### 1. Public creation and abuse controls

1. Remove client creator-key authentication from `POST /v1/rooms`. Retain `ROOM_SIGNING_SECRET` as an operator-only Worker secret used to sign capabilities.
2. Validate method, content type, JSON shape, task/context byte size, TTL bounds, and reject unexpected oversized input before obtaining a Durable Object stub or writing state.
3. Apply a Cloudflare-native creation limiter before Durable Object creation. Prefer a Workers Rate Limiting binding keyed by a privacy-minimized caller key derived from Cloudflare request metadata; begin with a documented conservative threshold and return `429` with `Retry-After`. If the deployed plan cannot use that binding, configure an equivalent Cloudflare WAF rate-limiting rule specifically for `POST /v1/rooms`; do not silently ship without an enforced limit.
4. Keep the limiter scoped to creation. Capability-authenticated room traffic retains per-room byte, lifetime, and role controls.

### 2. Capability and response contract

1. Issue two expiring signed capabilities: `creator` and `guest`. The creator capability combines participant and owner operations; the guest capability has participant-only access.
2. Return a stable JSON shape such as:

   ```json
   {
     "room_id": "...",
     "expires_at": "...",
     "creator_capability": "...",
     "guest_invitation_url": "https://.../join#invite=...",
     "guest_invitation_message": "..."
   }
   ```

3. Construct invitation URLs from the canonical public origin on the service side. Never place either capability in logs, query strings, or response diagnostics.
4. Update route authorization so creator and guest may collaborate, while final collection and deletion remain creator-only.

### 3. Room storage and lifecycle

1. Replace the current message-count limit with cumulative UTF-8 byte accounting. Enforce the per-message and total-room budgets atomically before insertion.
2. Increase task, final-result, and TTL limits to the product-contract values above, with constants shared by validation and status responses.
3. Preserve `deleteAll()` on explicit close, verified collection, and alarm/expiry paths. Ensure expired capabilities cannot revive or recreate state.
4. Decide whether closed local CLI session files are deleted or reduced to non-sensitive tombstones; server-side deletion remains the authoritative room cleanup guarantee.

### 4. CLI and plugin surface

1. Remove `--creator-key`, `GET_A_ROOM_CREATOR_KEY`, and `ROOM_CREATOR_KEY` from the high-level creation path, help text, error redaction, tests, and plugin instructions.
2. Make `get-a-room create` call the anonymous endpoint, store only the private creator session locally with restrictive permissions, and print the server-provided guest invitation message.
3. Keep `join`, `say`, `check`, `finish`, `collect`, and `close` focused on capabilities and remembered local state; users should not handle room IDs or tokens manually.
4. Remove the obsolete creator-key path from the lower-level client unless a clearly documented operator-only diagnostic need remains; do not retain a second public contract accidentally.

### 5. Verification

Add or update tests covering:

- anonymous creation succeeds without credentials and returns only the documented capability/invitation fields;
- legacy creator headers, flags, and environment variables are unnecessary and removed from public behavior;
- malformed, oversized, or out-of-range creation requests fail before Durable Object initialization;
- the creation limiter returns `429` and `Retry-After`, without allocating a room;
- a guest joins from the returned URL/message without an account;
- creator/guest message access works and creator-only collection/close enforcement rejects the guest;
- cumulative text budgets allow detailed collaboration and reject only when byte limits are exceeded;
- explicit close, successful collection, and expiry/alarm cleanup all produce `410` afterward;
- capability values remain redacted from errors and are absent from join-page requests and logs.

Run type checking, linting, unit/Worker tests, CLI tests with isolated session homes, and a production acceptance pass that creates, joins, exchanges a substantial transcript, closes, and confirms `410`. Deployment remains a separate explicitly authorized action.

## Documentation changes

- Update `README.md`, `docs/usage-guide.md`, the Codex skill, CLI help, and examples to show secretless creation and the forwardable guest message.
- Remove all client/operator setup instructions that tell room creators to provision `GET_A_ROOM_CREATOR_KEY` or `ROOM_CREATOR_KEY`.
- Retain a clearly separated operator deployment section documenting only internal `ROOM_SIGNING_SECRET`, Cloudflare rate-limit configuration, canonical public origin, and rotation/incident procedures.
- Document capability links as short-lived bearer secrets, the byte budgets and lifetime bounds, role permissions, and deletion guarantees.

## Acceptance gates

1. A clean client with the installed CLI but no service credential creates a room and receives the creator capability plus forwardable guest invitation.
2. Anonymous creation is rate-limited and invalid requests allocate no Durable Object state.
3. Creator and guest complete a detailed text collaboration without encountering a small message-count cap.
4. Guest cannot collect or close; creator can do both.
5. Close, collection, and expiry each delete server-side room data, verified by subsequent `410` responses.
6. Public docs contain no client creator-key setup, while operator-only signing and abuse-control configuration remains documented.
