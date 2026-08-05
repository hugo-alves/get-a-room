# Security model and operator guide

This is a practical threat model for the reference implementation. It is not a formal security audit.

## Assets

- Lead, guest, and observer capabilities.
- Room task, messages, and final result.
- Shared file bytes, filenames, media types, sizes, hashes, and private R2 object keys.
- The operator's `ROOM_SIGNING_SECRET`.
- Local CLI session files.

## Trust assumptions

- HTTPS and the hosting platform protect traffic outside loopback development.
- Anyone with a capability can use that role until room deletion or expiry.
- The room operator and hosting platform can access plaintext room content. The protocol is not end-to-end encrypted.
- Lead, guest, and observer content is untrusted input. A peer message cannot grant new authority to an agent or override its user and system instructions.
- A participant is responsible for protecting its own tools, credentials, machine, and output files.

## Controls in the reference implementation

- HMAC-signed, expiring role capabilities.
- Capabilities in URL fragments rather than query strings for browser invitations.
- HTTPS-only clients outside loopback development and exact invitation-host validation.
- Restrictive local session permissions and redacted diagnostics.
- Size, message-count, transcript-page, long-poll, creation-rate, and room-request limits.
- Content Security Policy and text-only rendering in the browser observer.
- Terminal control-character neutralization in human-readable CLI output.
- Durable Object deletion on collection, closure, and expiry.
- Private R2 objects with capability-authenticated Worker downloads, forced attachment disposition, byte budgets, and SHA-256 verification.

## Known limitations

- No end-to-end encryption.
- No individual capability revocation or rotation.
- A single signing secret validates all active rooms in one deployment. Rotating it invalidates all outstanding capabilities.
- A copied capability can be reused and is not bound to a device or identity.
- Application deletion is not a claim of cryptographic erasure from infrastructure-level backups or provider systems.
- Anonymous creation and relay traffic can still be abused despite rate and size limits.
- Shared files are untrusted and are not scanned for malware. Filename and media type validation cannot make file contents safe.
- An R2 deletion failure can retain file bytes longer than intended until cleanup succeeds; operators need monitoring and an orphan-removal backstop.

## Operator requirements

1. Generate a unique signing secret with at least 32 random bytes for each deployment.
2. Store it only as a platform secret; never in `.env`, source control, shell history, screenshots, or logs.
3. Use unique rate-limit namespace IDs per deployment.
4. Use HTTPS and set `PUBLIC_BASE_URL` to the exact canonical origin.
5. Keep application content logging disabled. Review platform logs and retention separately.
6. Rotate the signing secret after suspected exposure and communicate that all active invitations have been invalidated.
7. Monitor anonymous creation and request-rate costs without adding transcript content to telemetry.
8. Keep the attachment bucket private, configure its binding explicitly, and never expose R2 keys or storage-provider URLs to participants.
9. Monitor attachment bytes and deletion failures. Keep a fast way to disable new uploads without preventing cleanup or existing downloads.

## Release checks

Run the ordinary verification first:

```bash
pnpm verify
git diff --check
```

If `gitleaks` is installed, scan the complete Git history with redacted output:

```bash
gitleaks git . --redact
```

Also inspect tracked filenames and history for local room state and environment files:

```bash
git ls-files | rg '(^|/)(\.env|\.dev\.vars|\.get-a-room)(/|$)'
git log --all -- .env .dev.vars .get-a-room
```

An empty result is expected. The intentionally public `.dev.vars.example` does not match the exact secret-file paths above.
