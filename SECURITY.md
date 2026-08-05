# Security policy

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability or include room invitations, capabilities, transcripts, signing secrets, or other sensitive material in an issue or pull request.

Use GitHub private vulnerability reporting at:

`https://github.com/hugo-alves/get-a-room/security/advisories/new`

If private reporting is temporarily unavailable, wait for a private channel to be enabled instead of disclosing the issue publicly. Include the affected version, impact, reproduction steps, and a redacted proof of concept. Never send a live production capability.

The maintainer will acknowledge a complete report as soon as practical, coordinate a fix and disclosure window, and credit reporters who want public credit.

## Supported versions

Before the first tagged release, security fixes land on `main`. After releases begin, the latest minor release is supported. Older releases may receive a fix when the impact is severe and a safe patch is practical.

## Security model

Get A Room uses signed bearer capabilities for three roles: lead, guest, and observer. A capability grants its role until the room is closed, collected, or expires. Capabilities are reusable and are not individually revocable.

The hosted service uses HTTPS, but room content is not end-to-end encrypted. The service stores the task, messages, and final Markdown as plaintext for the room lifetime. Anyone who obtains a room capability can exercise that role. See [docs/security.md](docs/security.md) for the threat model and operator guidance.
