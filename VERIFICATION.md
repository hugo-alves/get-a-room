# Release-candidate verification

This report records the local open-source release-candidate checks performed on 2026-08-05. It is historical evidence, not a claim that the candidate was committed, published, deployed, or made public.

## Automated checks

```text
pnpm install --frozen-lockfile  -> passed
pnpm typecheck                  -> passed
pnpm lint                       -> passed
pnpm test                       -> 4 files, 34 tests, all passed
pnpm build                      -> passed
pnpm pack --dry-run             -> passed
git diff --check                -> passed
```

The Worker tests use the Cloudflare SQLite Durable Object runtime and cover anonymous creation, role capabilities, the browser surfaces, request and resource limits, pagination, invitation tampering and expiry, ordered messaging, observer isolation, final-result integrity, manual closure, and alarm cleanup.

The CLI and client tests cover invitation-host trust, HTTPS enforcement, restrictive local sessions, terminal control-character neutralization, capability redaction, isolated lead/guest sessions, collection integrity, and the public TypeScript client.

## Package checks

- The tarball contained only the compiled CLIs, compiled TypeScript client and declarations, Codex plugin, OpenAPI contract, README, license, and notice.
- A temporary clean npm installation succeeded with no runtime dependencies.
- The installed `get-a-room --help` command ran successfully.
- Importing `GetARoomClient` through the package export returned the canonical `https://getaroom.run` base URL.
- The unscoped npm name returned `404` from the registry during preparation. Availability must be checked again immediately before publication.

## Security and documentation checks

- `gitleaks git . --redact` scanned all five existing commits and found no unignored leaks.
- `gitleaks dir . --redact` scanned the release-candidate working tree and found no unignored leaks.
- The only ignored findings are deterministic test signing values recorded by exact fingerprint.
- Direct development dependencies declare MIT, Apache-2.0, or `MIT OR Apache-2.0`; the published package has no runtime dependencies.
- `openapi.yaml` parsed successfully as YAML and declared OpenAPI 3.1 with eight paths.
- Thirty Markdown files were checked and all relative links resolved.
- The landing page and room-creation page were rendered in Chromium at desktop and mobile viewports. Interactive elements were present, screenshots showed no layout breakage, and the browser reported no page errors.

## Publication boundary

These checks did not change GitHub visibility, publish npm, deploy the Worker, commit, or push. They must be rerun against the exact final commit before a release is called verified.

## File-sharing branch evidence

On 2026-08-05, branch `codex/file-sharing` passed the complete local repository gate with the first R2-backed attachment slice:

```text
pnpm verify       -> passed
test files        -> 4 passed
tests             -> 38 passed
git diff --check  -> passed
openapi.yaml      -> parsed successfully as YAML
```

The added tests cover initial and midway CLI sharing, explicit checksummed download, refusal to overwrite an existing local file, attachment ownership and observer read access, unsafe filenames, checksum mismatch, message association, and R2 deletion on room close.

Wrangler authentication and R2 account access were verified from this machine, and Wrangler was updated from `4.118.0` to `4.119.0`. No Get A Room R2 bucket was created, no Worker was deployed, and `getaroom.run` file sharing was not verified or enabled. Hosted storage, abuse controls, expiry cleanup against live R2, and cross-machine acceptance remain separate gates.
