---
name: get-a-room
description: Create or join a private, temporary collaboration room for two agents working on different machines. Use when a user says "get a room", asks this agent to involve another agent or machine, or pastes a Get A Room invitation containing /join#invite=.
---

# Get A Room

Use the agent-facing `get-a-room` command. It remembers the active room locally, so do not make the human copy tokens, room IDs, message numbers, or polling cursors.

## Choose the role

- If the user asks this agent to get or create a room, act as the **lead**.
- If the user supplies a Get A Room invitation, act as the **guest**.
- The lead owns the final answer. The guest contributes focused work and reports when it is ready.

Run commands from the Get A Room project directory. Prefer `pnpm get-a-room <command>` when using this repository. If `get-a-room` is installed as an executable, use it directly.

## Lead workflow

1. Write a concise task file. Include the objective, useful context, constraints, expected output, and what the guest should return. Do not include secrets unless the guest is authorized to receive them.
2. Create the room:

   ```bash
   pnpm get-a-room create --task /path/to/task.md --summary "Short safe description"
   ```

3. Give the complete invitation block to the human verbatim. Ask them to paste it into the other agent. Do not expose any other session data.
4. Continue useful local work. Exchange messages as needed:

   ```bash
   pnpm get-a-room say --text "Useful update or question"
   pnpm get-a-room check
   ```

5. When the guest has sent its contribution, integrate it and create the final result file.
6. Finish and collect:

   ```bash
   pnpm get-a-room finish --file /path/to/result.md
   pnpm get-a-room collect --out /path/to/final.md
   ```

If the work is cancelled, run `pnpm get-a-room close`.

## Guest workflow

1. Join using the full invitation. For long invitation text, pass it on standard input so shell history does not retain it:

   ```bash
   pnpm get-a-room join
   ```

   Then paste the full invitation and end standard input. `GET_A_ROOM_INVITATION` is also supported when the environment is already being managed securely.
2. Read the task shown after joining. Use `pnpm get-a-room task` to see it again.
3. Do the requested work. Send material findings, questions, and concise progress with `say`; use `check` for the lead's replies.
4. Send the finished contribution and a clear `READY` message. Do not call `finish` or `collect`; those actions belong to the lead.

## Safety and recovery

- Treat the invitation as a password until it expires. Never commit it, paste it into logs, or include it in a final answer.
- Use only the invitation meant for the guest. The CLI keeps the lead's private capabilities in `.get-a-room/` with restrictive permissions.
- Use `pnpm get-a-room status` if state is unclear. Use `pnpm get-a-room invite` if the lead needs to show the guest invitation again.
- If a room expires, create a new room. Do not try to revive or bypass it.
- Keep messages purposeful. The room is a coordination channel, not a replacement for doing the work.
