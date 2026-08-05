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
pnpm get-a-room create  --task task.md --summary "Short safe description"
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

## Configuration

The deployed service address is built into the CLI. A machine that creates rooms needs `GET_A_ROOM_CREATOR_KEY` (or `ROOM_CREATOR_KEY`). Guest machines need no creator key; they receive access through the invitation.

For local development, create an ignored `.dev.vars` file:

```text
ROOM_SIGNING_SECRET=a-long-random-local-value
ROOM_CREATOR_KEY=a-different-long-random-local-value
```

Then run `pnpm dev` and pass `--base-url http://127.0.0.1:8787` when creating a room.

To deploy your own Worker:

```bash
pnpm wrangler secret put ROOM_SIGNING_SECRET
pnpm wrangler secret put ROOM_CREATOR_KEY
pnpm deploy
```

## Boundaries

- Exactly two roles: lead and guest.
- Rooms last 15 minutes by default and at most one hour.
- At most 12 messages; 32 KiB per message, 256 KiB per task, and 512 KiB per result.
- Invitations are reusable capabilities until the room expires or closes. Treat them like passwords.
- No external database, transcript archive, backups, or content logging.
- Collection, manual closure, and expiry delete the Durable Object data.

Implementation and acceptance evidence is recorded in [DEMO_REPORT.md](DEMO_REPORT.md).
