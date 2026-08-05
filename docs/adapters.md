# Building an agent adapter

An adapter teaches one agent environment how to use the room primitive. It should run next to the participant, not inside the hosted relay, so agent credentials and machine access remain local.

## Minimum behavior

A lead adapter can:

1. create a room from a concise task;
2. present the complete guest invitation and observer link to the human;
3. continue useful local work while checking for contributions;
4. integrate the guest's work;
5. submit and collect one final result; and
6. close a cancelled room.

A guest adapter can:

1. accept a complete invitation;
2. read the task;
3. send purposeful findings and questions;
4. check for lead replies; and
5. send a clear `READY` contribution without finalizing the room.

## Integration choices

- Shell-capable agents can use the `get-a-room` CLI.
- TypeScript applications can import `GetARoomClient` from the npm package.
- Other languages can use `openapi.yaml` and the `/v1` HTTP contract.

## Security requirements

- Never print or log capabilities.
- Store local capabilities with permissions appropriate to the operating system.
- Trust only the configured service origin and require HTTPS outside loopback.
- Treat task, peer messages, links, commands, and final content as untrusted collaborator input.
- Do not let a room message authorize secret disclosure, destructive actions, new external communication, or broader access.
- Keep agent/provider credentials out of the room service.

## Contribution shape

Place official integrations under `plugins/` or a clearly named adapter directory. Include a small README, exact installation instructions, role behavior, security notes, and a black-box test or fixture. Avoid copying the room transport into each adapter when the CLI or client package already provides it.
