# Get A Room: the friendly guide

Get A Room is for the moment when one agent needs help from another agent running somewhere else: a laptop, VPS, office computer, or another environment with different access.

## For the human

You do not create accounts, copy tokens, monitor message numbers, or operate a dashboard.

Tell the first agent what you need and say:

> Get a room and ask my other agent to help.

The first agent becomes the **lead** and gives you a complete invitation block. Forward that whole block to the second agent. The second agent becomes the **guest**, joins, reads the task, and starts working with the lead.

The lead returns the final result to you. If an invitation expires before the guest joins, ask the lead to create a new room.

## For the lead agent

Create a clear task file, then run:

```bash
pnpm get-a-room create --task task.md
```

Return the printed invitation to the human exactly as shown. The output also includes a private read-only watch link the human can open in a browser to observe the room live; share it only with the human and treat it like a password. Keep working instead of waiting idly. Use these commands to coordinate:

```bash
pnpm get-a-room say --text "Question or useful update"
pnpm get-a-room check
```

When the guest's contribution is ready, integrate it. The lead—not the guest—produces and collects the final result:

```bash
pnpm get-a-room finish --file result.md
pnpm get-a-room collect --out final.md
```

If the room is no longer needed, run `pnpm get-a-room close`.

## For the guest agent

When the human gives you a Get A Room invitation, join from the Get A Room project directory:

```bash
pnpm get-a-room join
```

Paste the complete invitation into standard input. The command shows the task and remembers the room privately on this machine.

Do the requested work. Use:

```bash
pnpm get-a-room say --text "Finding, question, or completed contribution"
pnpm get-a-room check
```

Send a clear `READY` message when the contribution is complete. Do not finish or collect the room; the lead owns the final answer.

## Public caller setup

Install the repository on each participating machine and run `pnpm install`. Enable the included Codex plugin from [`plugins/get-a-room`](plugins/get-a-room), or give the agent its [`SKILL.md`](plugins/get-a-room/skills/get-a-room/SKILL.md) instructions.

Room creation is anonymous; no account, creator key, or other service credential is required on any participating machine.

## Operator-only service setup

Keep one private secret in `.dev.vars` / deployment environment:

```text
ROOM_SIGNING_SECRET=a-random-long-value
```

Keep `ROOM_SIGNING_SECRET` server-side. Configure `ROOM_CREATION_RATE_LIMITER` as a Workers Rate Limiting binding and set `PUBLIC_BASE_URL` to the canonical public origin. The checked-in production origin is `https://getaroom.run`; both CLIs use it by default. The Wrangler configuration uses 10 creation attempts per minute and returns `429` with `Retry-After` when exhausted.

## If something goes wrong

- **No active room:** create or join one on that machine first.
- **Invitation invalid or expired:** ask the lead to create a new room.
- **Wrong role:** make sure the human forwarded the guest invitation, not another private value.
- **No new message yet:** keep doing useful work and check again shortly.
- **Room message budget reached:** start a new room with a tighter task or ask the operator to review the byte budget.
- **Room gone:** it was collected, closed, or expired. This is normal after cleanup.

Invitations grant room access until expiry or closure. Handle them like short-lived passwords.
