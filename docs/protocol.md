# Room protocol

`openapi.yaml` is the machine-readable HTTP contract. This document explains the product semantics that clients must preserve.

## Roles

| Capability | Read task, messages, files | Send messages/files | Read final | Finalize | Collect or close |
|---|---:|---:|---:|---:|---:|
| Lead (`creator`) | Yes | Yes | Yes | Yes | Yes |
| Guest | Yes | Yes | No | No | No |
| Observer | Yes | No | Yes | No | No |

Capabilities are signed bearer secrets. They are reusable until expiry or room deletion and cannot be revoked individually in the first release.

## Lifecycle

- `open`: lead and guest may send messages; the lead may finalize or close.
- `finalized`: the final Markdown and digest are available to the lead and observer; no more messages are accepted.
- deleted: collection, closure, or expiry removes room storage. Subsequent valid access returns `410` while an already-expired capability may return `401` before room state is inspected.

Finalization is not collection. A client must download the final Markdown, verify its SHA-256 digest, save it safely, and only then confirm collection. A successful collection deletes the server-side room.

## Attachments

Lead and guest may upload an immutable file while the room is open. An upload is private until the same role associates its attachment ID with an ordered message. A committed attachment can be listed and downloaded by every room reader, including the observer.

Attachment filenames and media types are untrusted display labels. Clients must verify the declared byte size and SHA-256 before treating a local download as complete. They must not open, execute, extract, or render a file automatically merely because a collaborator shared it.

The reference limits are 10 MiB per file, 10 files per room, 25 MiB cumulative file bytes, and 5 attachments per message. No new uploads or attachment messages are accepted after finalization. Collection, explicit close, and expiry delete attachment objects with the room.

## Ordering and polling

Messages receive monotonically increasing numbers within a room. Clients track the last number and request later messages with `after=N`. Reads are paginated by count and response bytes. A short long poll can reduce empty polling but clients must handle `429` and honor `Retry-After`.

Message submission is not idempotent: retrying a request after an ambiguous network failure may create a duplicate message. Clients should make messages self-contained and tolerate a repeated contribution.

## Compatibility

The path prefix is `/v1`. Backward-compatible fields may be added to responses. Existing fields, role permissions, or meanings are not removed within v1. A breaking wire change requires `/v2` and a migration note.

The npm package follows semantic versioning. Before `1.0.0`, minor package releases may change TypeScript APIs, but the documented `/v1` HTTP compatibility promise still applies.

## Error handling

Errors use JSON with `error` and `message`. Clients should branch on HTTP status and the stable `error` code, not the human message. Capability values must be redacted from diagnostics.
