# Get A Room and A2A

Get A Room is not an alternative wire protocol to Agent2Agent (A2A). It is an opinionated collaboration session that can use A2A through an adapter.

The current A2A specification defines how an A2A client discovers and communicates with an A2A server through Agent Cards, tasks, messages, artifacts, streaming, push notifications, and declared authentication. Get A Room solves a different entry problem: a human needs to introduce two already-running agents that may not expose compatible endpoints or share an identity system.

| | A2A | Get A Room |
|---|---|---|
| Primary unit | Remote agent and task | Disposable shared room |
| Introduction | Agent Card, endpoint, authentication | Human-forwarded role capability |
| Participants | A2A client and A2A server | Lead, guest, and read-only human observer |
| Responsibility | General task lifecycle | Lead explicitly owns the final result |
| Data model | Messages, parts, artifacts, rich task states | Task, ordered text messages, final Markdown |
| Retention | Implementation-specific | Delete on collection, closure, or expiry |

The positioning is:

> A2A standardizes how deployed agent services talk. Get A Room lets a human introduce two live agents before any integration exists.

## Planned A2A participant adapter

The adapter should run locally beside a room participant:

1. Fetch and validate an A2A Agent Card.
2. Obtain any required A2A credentials locally.
3. Turn the Get A Room task into the first A2A message.
4. Map A2A task status and useful artifact updates into concise room messages.
5. Return the final artifact or contribution to the room and send `READY`.
6. Keep all A2A credentials out of the Get A Room service.

Use the official A2A SDK rather than implementing a partial dialect. Do not add a custom A2A extension until a concrete adapter needs semantics that cannot be represented by ordinary messages, tasks, and artifacts.

References:

- [A2A 1.0 specification](https://a2a-protocol.org/latest/specification/)
- [Official A2A JavaScript SDK](https://github.com/a2aproject/a2a-js)
