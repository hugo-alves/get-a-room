# Ephemeral File Sharing Plan

> Active implementation plan for branch `codex/file-sharing`. File sharing is not available on the hosted service until the release gates below pass and a separate deployment is authorized.

## Outcome

Let the lead and guest exchange immutable files across machines:

- at the beginning, by attaching one file during `get-a-room create`; and
- midway, with `get-a-room share`.

Files belong to ordered room messages. They expire and are deleted with the room. Get A Room remains a disposable collaboration relay, not a shared drive or permanent file store.

## Smallest useful design

1. Store file bytes in a private Cloudflare R2 bucket.
2. Store attachment metadata and message association in the existing room Durable Object.
3. Upload first, then attach the returned attachment ID to an ordinary message.
4. Keep an unattached upload invisible to readers.
5. Use the same flow after room creation for initial context; the CLI prints the guest invitation only after the initial file is attached.
6. Authenticate every upload and download with the existing room capability.
7. Verify SHA-256 on upload and before saving a download.
8. Delete R2 objects before deleting the room's Durable Object state.

This first implementation deliberately does not add prepared-room states, resumable or multipart uploads, previews, mutable folders, content scanning, URL imports, deduplication, or a separate storage service.

## User workflow

Initial context:

```bash
get-a-room create --task task.md --attach brief.pdf
```

Mid-room sharing:

```bash
get-a-room share --file analysis.csv --text "Updated totals"
```

Receiving:

```bash
get-a-room check
get-a-room download --attachment a_... --out ./analysis.csv
```

Collection preserves the final Markdown and committed attachments locally before the server deletes them.

## Protocol changes

Add:

```text
POST /v1/rooms/{roomId}/attachments
GET  /v1/rooms/{roomId}/attachments
GET  /v1/rooms/{roomId}/attachments/{attachmentId}
```

The upload request carries raw bytes plus:

- `Content-Type`
- `X-Get-A-Room-Filename` as base64url UTF-8
- `X-Get-A-Room-Size`
- `X-Get-A-Room-Sha256`

Extend `POST /messages` with optional `attachment_ids`. A message requires text, at least one attachment, or both. Extend returned messages additively with `attachments`.

Stable attachment metadata:

```json
{
  "id": "a_...",
  "filename": "analysis.csv",
  "media_type": "text/csv",
  "size": 18422,
  "sha256": "...",
  "created_at": "..."
}
```

No response exposes an R2 key or storage-provider URL.

Initial limits:

- 10 MiB per file
- 10 files per room
- 25 MiB total file bytes per room
- 5 attachments per message

## Security and lifecycle

- Lead and guest may upload while the room is open.
- Observer may list and download committed attachments, but never upload or attach.
- A participant may attach only its own unattached upload.
- Filenames are display metadata, never object keys.
- Reject path separators, control characters, empty names, `.` and `..`.
- Serve downloads with `Content-Disposition: attachment`, `nosniff`, and `no-store`.
- Never open, execute, extract, or render a collaborator file automatically.
- Treat filename, extension, and media type as untrusted labels.
- Close, verified collection, route-time expiry, and alarm expiry delete all known R2 objects before deleting room metadata.
- A bucket lifecycle rule should eventually provide orphan cleanup, but it is not the primary deletion mechanism.

The public anonymous service needs a storage kill switch, upload-rate control, byte monitoring, and an abuse-response process before production enablement. Those operational controls should remain separate from the core exchange path rather than complicating the first local implementation.

## Implementation sequence

### 1. Local vertical slice

- R2 binding and attachment table.
- Upload, list, download, message association, and room cleanup.
- Client and high-level CLI support.
- Initial and midway file tests using isolated sessions.

### 2. Contract and agent behavior

- OpenAPI and protocol documentation.
- README and usage examples.
- Plugin instructions for explicit sharing, downloading, distrust, and integration.
- Security, privacy, acceptable-use, architecture, and self-hosting updates.

### 3. Hosted readiness

- Create a dedicated private R2 bucket only after infrastructure approval.
- Add the production binding, lifecycle safety rule, alerts, rate controls, and kill switch.
- Run a real cross-machine canary.
- Verify R2 deletion after close, collection, and expiry.
- Make an explicit abandon, iterate, or promote decision.

Production bucket creation, deployment, npm publication, and GitHub release remain separate authorized actions.

## Verification

Tests must cover:

- valid upload, checksum failure, oversize rejection, unsafe filename rejection;
- attachment invisibility before message association;
- sender ownership and observer read-only behavior;
- ordered messages containing text, attachments, or both;
- safe CLI initial share, midway share, explicit download, and collection;
- no silent local overwrite and no trusted file after checksum failure;
- close, collection, and expiry removing R2 objects;
- existing text-only rooms and clients continuing to work;
- capabilities and R2 keys absent from errors and output.

Run `pnpm verify`, `git diff --check`, package inspection, and a local R2-backed end-to-end flow. Hosted availability requires a separate cross-machine and live-storage check.

## Communication and repository updates

Update these alongside the implementation:

| Surface | Change |
|---|---|
| `README.md` | Explain temporary files, show beginning/midway commands, state limits and safety boundaries. |
| `docs/usage-guide.md` | Add lead, guest, observer, download, and collection examples. |
| `openapi.yaml` | Document attachment endpoints, message fields, status counters, errors, and schemas. |
| `docs/protocol.md` | Define immutability, ordering, visibility, finalization, and deletion. |
| `docs/architecture.md` | Add private R2 and Durable Object metadata/cleanup flow. |
| `docs/security.md` | Cover malicious files, traversal, active content, quotas, and incomplete cleanup. |
| `PRIVACY.md` | Add file bytes/metadata, plaintext R2 storage, and deletion timing. |
| `ACCEPTABLE_USE.md` | Cover prohibited file content and abuse reporting. |
| `docs/self-hosting.md` | Document bucket binding, lifecycle rule, limits, and teardown. |
| `docs/adapters.md` | Define safe adapter upload/download behavior. |
| `ROADMAP.md` | Move attachments out of `Later` only after the implementation is promoted. |
| `CHANGELOG.md` | Add the feature under `Unreleased` when the user-visible slice is ready. |
| `docs/operations/verification.md` | Record local, cross-machine, cleanup, and hosted evidence. |
| `docs/operations/releasing.md` | Add R2 and post-release cleanup gates. |
| Plugin skill | Teach agents when and how to share and distrust files. |
| Landing page | Advertise only after hosted availability is verified. |

The README message should be: agents keep their own tools and machines; the room temporarily carries the task, ordered messages, and files deliberately shared for that task. Avoid framing it as Dropbox, persistent memory, or a secure file vault.

## GitHub structure

After the local slice proves the workflow, create one tracking issue with the workflow, security boundaries, documentation checklist, and acceptance gates. Keep implementation pull requests narrow:

1. attachment protocol and R2 storage;
2. client, CLI, and plugin behavior;
3. observer and documentation updates; and
4. hosted canary/operations.

Every PR states compatibility, privacy/security effects, cleanup behavior, exact verification, and what remains unavailable. Do not put capabilities, private filenames/content, bucket credentials, or internal object keys in GitHub artifacts.

## Acceptance gates

1. Initial and midway files move between isolated agent environments without a shared filesystem or public object URL.
2. Attachments appear in ordinary message order.
3. Downloads are capability-authorized and SHA-256 verified before trusted persistence.
4. Observer access remains read-only.
5. Existing text-only behavior remains compatible.
6. Collection preserves committed files before deletion.
7. Close, collection, and expiry delete metadata and R2 objects.
8. Canonical docs and agent instructions match actual behavior.
9. Hosted quotas, monitoring, abuse response, and kill switch work before production enablement.
10. A real cross-machine canary passes before the feature is advertised.
