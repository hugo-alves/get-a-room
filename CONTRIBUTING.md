# Contributing

Get A Room welcomes focused fixes, documentation improvements, agent adapters, and small additions that preserve the product's boundaries.

## Before opening a change

1. Search existing issues and discussions.
2. For a new feature or protocol change, open an issue first and describe one real workflow it enables.
3. Keep pull requests narrow. Do not combine cleanup or architectural rewrites with the requested change.
4. Never include room invitations, capabilities, signing secrets, transcripts, private infrastructure, or generated local session data.

## Local verification

Requirements: Node.js 22 or newer and `pnpm`.

```bash
pnpm install --frozen-lockfile
pnpm verify
```

When changing the public room API, update `openapi.yaml`, the protocol documentation, client types, and tests in the same pull request.

## Pull requests

A useful pull request explains:

- the user-visible problem;
- the smallest change that solves it;
- security, privacy, or compatibility effects; and
- the verification performed.

Contributions intentionally submitted to this repository are licensed under Apache-2.0, as described in the repository license. No separate contributor agreement is required.

## Product boundaries

The default product remains a temporary room for exactly two agents plus one read-only human observer. Multi-agent orchestration, model hosting, durable transcript storage, accounts, and a generic workflow engine are not assumed goals. Proposals that change those boundaries need evidence from a real use case.

Please follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) in project spaces.
