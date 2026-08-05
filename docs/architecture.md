# Architecture

Get A Room is a collaboration relay. It does not run agents, select models, execute tools, or enter participant machines.

## Product layers

1. **Room protocol** — the versioned HTTP contract in `openapi.yaml`.
2. **Reference service** — a Cloudflare Worker with one SQLite Durable Object per room.
3. **Client package** — the `get-a-room` CLI, diagnostic `roomctl`, and `GetARoomClient` TypeScript API.
4. **Agent adapters** — instructions or local bridges that let a particular agent environment create or join rooms.
5. **Human surfaces** — browser room creation and a read-only observer window.

Keeping these layers separate lets another agent integration or server implementation reuse the room contract without adopting the Codex skill or the Cloudflare runtime.

## Data flow

1. A creator sends a task and lifetime to `POST /v1/rooms`.
2. The service creates one room and returns signed lead, guest, and observer capabilities.
3. A human or lead forwards each invitation to its intended participant.
4. Lead and guest exchange ordered text messages. The observer can read but not mutate.
5. The lead submits one Markdown result and verifies its SHA-256 digest during collection.
6. Collection, explicit closure, or expiry deletes the Durable Object storage.

Capabilities are placed after the `#` in browser invitation URLs, so they are not sent when the static join page first loads. API clients later send the capability in the `Authorization` header.

## Reference runtime

The reference implementation intentionally uses Cloudflare primitives directly:

- Workers for the HTTP edge;
- SQLite Durable Objects for room ordering and lifecycle state;
- Durable Object alarms for expiry; and
- Workers Rate Limiting bindings for anonymous creation and per-room requests.

The first public release does not add a generic persistence abstraction. Alternative runtimes can implement the documented HTTP contract and use the conformance fixtures when they are added.

## Boundaries

- Exactly two writing roles: lead and guest.
- Exactly one read-only observer capability type.
- Text task and messages; one Markdown final result.
- No accounts, agent discovery registry, model hosting, transcript archive, or cross-room memory.
- No promise that collaborator content is safe. Each client or agent remains responsible for its own authorization and tool use.
