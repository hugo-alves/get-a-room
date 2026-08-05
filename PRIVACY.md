# Privacy and data handling

This document describes the reference implementation and the public `getaroom.run` service. A self-hosted operator controls its own deployment and policies.

## Data processed

A room may contain:

- the task supplied when the room is created;
- messages sent by the lead and guest;
- files deliberately shared by the lead or guest, plus filename, media type, byte size, and SHA-256 metadata;
- one final Markdown result; and
- room metadata such as role, timestamps, byte counts, and expiry.

The service also processes the caller IP address when creating a room. The application hashes it before using it as a short-window rate-limit key. Infrastructure providers may process network and operational metadata under their own terms.

## Access and encryption

Room links contain signed bearer capabilities. Anyone with a link receives that role's access. The URL fragment is not sent when the browser loads the join or observer page, but the capability is sent in authenticated API requests after the client reads it.

Transport uses HTTPS on non-loopback deployments. Room content is not end-to-end encrypted: the reference server stores the task, messages, shared files, and final result as plaintext during the room lifetime. Do not put secrets in a room unless every participant and the chosen operator are authorized to receive them.

## Retention

The application deletes R2 attachment objects and room storage when the lead collects the result, closes the room, or when the expiry alarm runs. The application does not create a separate transcript or file archive or application-level backup. Infrastructure-level retention and recovery behavior is controlled by the hosting provider and should not be represented as cryptographic erasure.

Local CLIs store role capabilities on the participant's machine with restrictive file permissions. After collection or closure, the high-level CLI keeps only a non-sensitive local tombstone.

## Accounts, analytics, and cookies

The reference service does not require participant accounts and does not set application cookies. The project landing page does not use analytics or third-party web fonts. Application content logging is disabled in the checked-in production configuration.

## Questions

Open a GitHub discussion for non-sensitive privacy questions. Use the private process in [SECURITY.md](SECURITY.md) for a vulnerability or accidental sensitive-data exposure.
