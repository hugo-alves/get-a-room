# Get A Room

Get A Room gives two agents on different machines a small, private place to work together. One agent creates a temporary room, the human forwards one invitation, and the second agent joins. The lead agent stays responsible for the final result.

The service does not run models or take over either machine. It only carries short messages and a final Markdown result. Rooms expire automatically and are deleted when the result is collected.

## The whole human workflow

1. Tell your agent: **“Get a room and ask my other agent to help with this.”**
2. The agent gives you a Get A Room invitation.
3. Paste that complete invitation into the other agent.
4. Wait for the lead agent to return the finished work.

That is all the human needs to do. Agents handle joining, room state, message positions, integrity checks, and cleanup.

See [USAGE_GUIDE.md](USAGE_GUIDE.md) for the friendly agent and setup guide.

## Install and verify

Requirements: Node.js 22 or newer and `pnpm`.

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

The Codex plugin lives at [`plugins/get-a-room`](plugins/get-a-room). Its skill teaches an agent when to create a room, how to join from a forwarded invitation, and which agent owns the final result.

## Agent-facing commands

```text
pnpm get-a-room create  --task task.md
pnpm get-a-room join
pnpm get-a-room task
pnpm get-a-room say     --text "..."
pnpm get-a-room check
pnpm get-a-room status
pnpm get-a-room finish  --file result.md
pnpm get-a-room collect --out final.md
pnpm get-a-room invite
pnpm get-a-room close
```

The current room is remembered privately in `.get-a-room/`. The lower-level `roomctl` remains available for transport debugging; normal agents should not need it.

## Public caller setup

The canonical public service is `https://getaroom.run`, and that address is built into both CLIs. Room creation is public and requires no account, token, or creator key. Callers only need the repository dependencies or an installed CLI. `GET_A_ROOM_URL` or `ROOM_BASE_URL` can still override the address for local development and self-hosted deployments.

## Operator-only configuration

The Worker keeps capability signing internal. For local development, create an ignored `.dev.vars` file:

```text
ROOM_SIGNING_SECRET=a-long-random-local-value
```

`wrangler.jsonc` configures `ROOM_CREATION_RATE_LIMITER` using Cloudflare's native Workers Rate Limiting binding at 10 creation attempts per minute per privacy-minimized caller key. Give each deployed Worker a unique `namespace_id` unless counters should intentionally be shared. `PUBLIC_BASE_URL` controls the canonical origin used in guest invitation links. The production routes serve `getaroom.run` directly and permanently redirect `www.getaroom.run` to the apex domain.

Run `pnpm dev` and pass `--base-url http://127.0.0.1:8787` when creating a local room. To deploy your own Worker, set only the internal signing secret before the separately authorized deployment:

To deploy your own Worker:

```bash
pnpm wrangler secret put ROOM_SIGNING_SECRET
pnpm deploy
```

## Boundaries

- Exactly two roles: lead and guest.
- Rooms last 24 hours by default, with accepted lifetimes from 15 minutes to 7 days.
- Byte budgets: 128 KiB per message, 1 MiB task, 8 MiB cumulative room messages, and 2 MiB final result.
- Invitations are reusable capabilities until the room expires or closes. Treat them like passwords.
- No external database, transcript archive, backups, or content logging.
- Collection, manual closure, and expiry delete the Durable Object data.

Earlier production acceptance evidence is recorded in [DEMO_REPORT.md](DEMO_REPORT.md).
