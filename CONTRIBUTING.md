# Contributing

Use Node.js 22+ and Python 3.10+. Run `npm ci`, then `npm test` and `npm run format:check`. Format JavaScript, JSON, CSS, Markdown, SVG, and YAML with `npm run format`.

## Layout

- `addon/`: Zotero bootstrap, manifest, locale resources, and original SVG assets.
- `src/`: sidebar UI, sanitized presentation, and native Zotero background operations.
- `bridge/`: loopback HTTP transport, Codex JSON-RPC client, session associations, and PDF snapshots.
- `skills/`: optional Codex skill instructions and Python helpers.
- `test/`: offline JavaScript behavior tests; annotation Python tests live beside their helper.
- `scripts/`: packaging, release validation, and explicitly invoked integration probes.

Keep model execution in Codex's native App Server. Do not introduce a second agent loop, automatically accept permission requests, evaluate caller-supplied JavaScript, write directly to Zotero/Codex databases, or add visible automation tags to annotations.

Use synthetic fixtures. Do not commit papers, screenshots of personal libraries, local state, logs, user-specific paths, or credentials. Real integration checks should use a separate Zotero profile and disposable library. Never run quota-consuming smoke tests from CI.

## Release process

1. Update `package.json`, the lockfile, `addon/manifest.json`, the App Server client version in `bridge/rpc.mjs`, and the fallback bridge version in `bridge/server.mjs`. Keep the add-on ID stable so existing users can upgrade.
2. Update `CHANGELOG.md`. Verify compatibility before expanding the Zotero version bounds.
3. Run the offline tests, Python annotation tests, formatter check, dependency audit, build, and `npm run release:check`. Inspect a secret scan and the exact publication file list.
4. Commit the source, push `main`, and tag the reviewed commit as `v<version>`.
5. Create a GitHub Release for that tag. Upload only the versioned XPI, versioned skills ZIP, `updates.json`, and `SHA256SUMS` from the validated build. Old `dist/` previews or receipts are not release assets.
6. Verify the downloaded assets against `SHA256SUMS`. `updates.json` must point to the exact tag and XPI digest. The add-on's update URL uses the latest Release asset; retain a valid manifest on every stable Release.

The CI workflow checks pull requests and pushes. It builds artifacts for inspection but intentionally does not publish a Release automatically.
