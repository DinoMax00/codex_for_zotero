# Security and privacy

Please report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/DinoMax00/codex_for_zotero/security/advisories/new) if enabled. If unavailable, open an issue requesting a private reporting channel without including exploit details or sensitive data.

Do not attach Zotero or Codex databases, PDFs, full chat transcripts, bearer tokens, authentication files, `connection.json`, `config.json`, `papers.json`, annotation metadata, or the skill discovery `bridge.json` to public issues. Redact absolute home paths, paper identifiers, email addresses, and unpublished research from diagnostics.

The current release line is 0.7.x. Security fixes are provided in new releases; earlier development builds should be updated.

## Trust boundaries

- Zotero plugins have privileged local filesystem and application access. Install only builds you trust.
- This plugin invokes a locally installed Node.js executable and Codex App Server without a shell. It inherits Codex's effective tools and permission policy; it does not isolate Codex from the rest of your computer.
- The chat bridge uses loopback binding, bearer authentication, origin/host checks, bounded request bodies, and private connection files. The skill endpoints additionally check the active Zotero instance and validate library targets and annotation payloads.
- Media upload/control operations require bearer authentication. Prepared local media uses random, file-scoped URLs that expire after 24 hours and disappear on bridge shutdown. Keep those URLs private. Media files are checked against resolved workspace paths and supported binary signatures; SVG/HTML are not embedded. Remote media waits for an explicit click. Native browser codecs determine video playback support.
- Markdown is sanitized. Formula rendering disables trusted commands, and local citation buttons accept PDF paths rather than executable schemes.
- Annotation writes are append-only and verify the source PDF digest. Collection imports preserve existing memberships and metadata. These limits do not replace backups or user authorization for the selected task.
- Local chat wiring is not offline model execution. Codex and Zotero may contact their configured services. Shared libraries and synchronization can distribute saved annotations.

Automated privacy and secret scans reduce publication risk; they cannot prove the absence of every possible sensitive datum. Review new files and release archives before publishing.
