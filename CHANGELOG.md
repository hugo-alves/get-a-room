# Changelog

All notable changes will be documented here. The project follows semantic versioning after the first public release.

## Unreleased

### Added

- Temporary lead, guest, and observer room roles.
- Anonymous room creation with rate limits and resource budgets.
- Agent-facing and diagnostic CLIs.
- Codex plugin and skill.
- Browser room creation, observer view, and project landing page.
- Public API documentation and installable client package.
- Development support for immutable, checksummed room file attachments in ordered messages; hosted enablement remains pending.

### Security

- Capability redaction and restrictive local session permissions.
- Invitation-host validation and HTTPS enforcement outside loopback development.
- Bounded request bodies, transcripts, long polls, and per-room request rates.
- Terminal control-character neutralization for collaborator-provided content.
