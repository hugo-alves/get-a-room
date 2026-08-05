# Releasing

This is the maintainer checklist for a public release.

## Prepare

1. Start from a clean checkout of the intended commit.
2. Run `pnpm install --frozen-lockfile` and `pnpm verify`.
3. Run the Git-history secret scan documented in [`docs/security.md`](../security.md).
4. Run `pnpm pack --dry-run` and inspect every packaged path.
5. Exercise create, join, observe, finish, collect, and post-collection `410` behavior using isolated local session homes.
6. If attachments are enabled, exchange and verify a harmless file across isolated environments, then confirm collection and expiry remove its R2 object.
7. Confirm `README.md`, `CHANGELOG.md`, `openapi.yaml`, and package versions agree.

## Publish

Repository visibility, Git push, GitHub release creation, npm publication, and production deployment are separate explicit actions. Perform only the actions authorized for that release.

For an npm release:

```bash
pnpm publish --access public
```

For the first GitHub publication, verify repository topics, homepage, issue settings, private vulnerability reporting, branch protection, and the Apache-2.0 license indicator after visibility changes.

## Verify

1. Install the exact published npm version in a temporary directory.
2. Run `get-a-room --help` and import `GetARoomClient` from the package.
3. Confirm the GitHub release and npm package point to the same commit and version.
4. Record evidence in the release notes. Do not put live capabilities or private transcripts in release evidence.
