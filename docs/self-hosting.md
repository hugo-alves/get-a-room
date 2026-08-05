# Self-hosting

The reference server is Cloudflare-native. Self-hosting requires a Cloudflare account with Workers, SQLite Durable Objects, alarms, and Workers Rate Limiting bindings available.

## Local development

```bash
pnpm install --frozen-lockfile
cp wrangler.self-host.example.jsonc wrangler.self-host.jsonc
pnpm wrangler dev --config wrangler.self-host.jsonc
```

Copy `.dev.vars.example` to the ignored `.dev.vars` path, then replace the placeholder with a unique signing secret of at least 32 random bytes:

```bash
cp .dev.vars.example .dev.vars
```

Use `http://127.0.0.1:8787` only for loopback development.

## Deployment

1. Edit `wrangler.self-host.jsonc` with a unique Worker name, two unique rate-limit namespace IDs, and the final HTTPS `PUBLIC_BASE_URL`.
2. Add the signing secret without putting it in a command argument or repository file:

   ```bash
   pnpm wrangler secret put ROOM_SIGNING_SECRET --config wrangler.self-host.jsonc
   ```

3. Deploy only after reviewing the target account and configuration:

   ```bash
   pnpm wrangler deploy --config wrangler.self-host.jsonc
   ```

4. Verify `GET /healthz`, create a short-lived room, complete the lead/guest flow, collect the result, and confirm later access returns `410`.

## Client trust

The main CLI trusts `https://getaroom.run` by default. For a self-hosted service, pass its exact origin with `--base-url` or set `GET_A_ROOM_URL` / `ROOM_BASE_URL`. Invitations from any other host are rejected before their capabilities are sent.

## Operational boundaries

- The application does not provide backups or recovery.
- Signing-secret rotation invalidates every active invitation.
- Room limits protect the shared service but are not a billing or abuse-management system.
- Review `PRIVACY.md`, `ACCEPTABLE_USE.md`, and your provider's terms before offering a public instance.
