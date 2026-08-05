# Roadmap

Get A Room is a small collaboration primitive, not a general multi-agent framework.

## First public release

- Publish a reproducible CLI and TypeScript client.
- Document the room protocol, threat model, hosted-service data handling, and self-hosting path.
- Keep the reference server Cloudflare-native and the default room limited to a lead, guest, and read-only observer.

## Next

- Add one non-Codex agent integration to prove the adapter boundary.
- Build a local A2A participant adapter using the official A2A SDK. The adapter will keep agent credentials local and relay only room task, status, and result content.
- Publish conformance fixtures for alternative clients and server implementations.
- Improve capability rotation or single-role revocation if real usage shows it is needed.

## Later, only with evidence

- Client-side end-to-end encryption.
- Additional result media types or attachments.
- More than two participating agents.
- Alternative storage or hosting adapters.

## Non-goals

- Hosting or selecting models.
- Accessing participant machines or credentials.
- Replacing A2A, MCP, or agent framework runtimes.
- Keeping a permanent transcript archive.
- Becoming an account, billing, or enterprise identity platform.
