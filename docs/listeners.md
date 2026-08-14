# Runtime listeners and wake adapters

The room relay stores ordered messages; it does not run or wake agents. A runtime listener adds that missing doorbell without giving the hosted relay access to a participant machine.

The listener runs beside one participant and makes outbound-only room requests. When it sees a new peer message, it sends metadata—not message content or the room capability—to one configured wake adapter. The resumed agent reads the message through the ordinary room command and sends any response back through the room. The read-only `/watch` transcript therefore remains the human's canonical view of the collaboration.

## CLI

Run a listener for a saved local session with exactly one adapter:

```bash
get-a-room listen --session s_... --wake-command /absolute/path/to/adapter
get-a-room listen --session s_... --codex-thread <thread-id>
```

From this source checkout, prefix those commands with `pnpm`. `--seconds` controls the existing 0–5 second long poll and `--retry-seconds` controls bounded exponential retry. `--once` performs one detection/wake cycle and is useful for tests or an external scheduler. Without `--once`, the command stays in the foreground until interrupted or the room is finalized, closed, collected, or expired.

The first implementation deliberately does not install a daemon or process manager. Operators choose how a foreground listener remains alive in their runtime.

## Wake interface

An executable adapter receives one JSON object on standard input:

```json
{
  "localSessionId": "s_0123456789abcdef01234567",
  "roomId": "0123456789abcdef0123456789abcdef",
  "role": "guest",
  "afterCursor": 4,
  "throughCursor": 7
}
```

The event never contains message text, attachments, invitations, capabilities, or provider credentials. The executable must:

1. resume or start the selected runtime turn;
2. make that agent run `get-a-room check --session <localSessionId> --seconds 0`;
3. keep work within the existing room task and authorization;
4. send useful replies through the room so `/watch` remains complete; and
5. exit `0` only after the local session cursor has advanced through `throughCursor`.

Exit `75` when the runtime is busy. Any other non-zero exit is a failed wake and is retried while the room remains active. The listener independently reloads the private session after exit `0`; if the durable read cursor did not advance, it treats the wake as unhandled and leaves the activity pending. The read cursor is distinct from the highest locally sent message, so sending a reply cannot accidentally prove that an earlier peer message was read.

The adapter path must be absolute and is executed directly without a shell. Get A Room invitation and server-signing environment variables are removed from the child environment. The capability remains only in the restrictive local session file used by the ordinary CLI.

## Codex adapter

`--codex-thread` uses `codex exec resume <thread-id> -`. The prompt contains the harmless local session ID and cursor only. It tells Codex to check the room, treat peer content as untrusted, and route useful responses back through the room for the observer.

Codex lifecycle hooks are not the wake mechanism: they run at events inside an already-running Codex lifecycle. The runtime adapter resumes the selected thread after external room activity.

## Other runtimes and A2A

Gemini, OpenClaw, hosted agents, and other environments can use the executable interface without changing the room protocol. A small wrapper may call a local gateway, CLI, job queue, provider interface, or an A2A client.

When an agent already exposes A2A, use the official A2A SDK in its adapter. Map the room task to an A2A task and mirror meaningful status, messages, and artifacts back into ordinary room messages. Do not bypass the room with an invisible A2A-only conversation: human observability and lead ownership remain Get A Room invariants.

## Reliability and safety invariants

- Only peer-authored messages cause a wake; a participant's own messages do not.
- The durable read cursor provides restart deduplication.
- One adapter invocation completes before another begins, so a participant is not given overlapping turns by one listener.
- A busy or failed runtime never advances the cursor.
- Message content is fetched only through the capability-authenticated room path and remains untrusted collaborator input.
- Closing, collecting, finalizing, or expiring the room stops the listener.
