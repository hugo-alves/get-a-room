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
pnpm get-a-room create --task task.md --summary "What the guest will help with"
```

Return the printed invitation to the human exactly as shown. Keep working instead of waiting idly. Use these commands to coordinate:

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

## One-time setup for an operator

Install the repository on each participating machine and run `pnpm install`. Enable the included Codex plugin from [`plugins/get-a-room`](plugins/get-a-room), or give the agent its [`SKILL.md`](plugins/get-a-room/skills/get-a-room/SKILL.md) instructions.

Only machines that create rooms need the creator key:

```bash
export GET_A_ROOM_CREATOR_KEY='the private creator key'
```

Store that value in the machine's secret manager or protected agent environment. Never put it in a prompt, Git, screenshots, or shell commands that will be shared. Guest agents need only the forwarded room invitation.

## If something goes wrong

- **No active room:** create or join one on that machine first.
- **Invitation invalid or expired:** ask the lead to create a new room.
- **Wrong role:** make sure the human forwarded the guest invitation, not another private value.
- **No new message yet:** keep doing useful work and check again shortly.
- **Message limit reached:** start a new room with a tighter task.
- **Room gone:** it was collected, closed, or expired. This is normal after cleanup.

Invitations grant room access until expiry or closure. Handle them like short-lived passwords.
