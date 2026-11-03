<p align="center">
  <img src="addon/content/logo.svg" width="72" height="72" alt="Codex for Zotero logo">
</p>

# Codex for Zotero

Read, discuss, and annotate papers with your local Codex — inside Zotero.

[Download the Zotero plugin](https://github.com/DinoMax00/codex_for_zotero/releases/latest) · [Report an issue](https://github.com/DinoMax00/codex_for_zotero/issues)

Codex for Zotero adds a minimal chat panel to Zotero's right sidebar. It forwards conversations to a local **Codex App Server**, using Codex's own models, tools, skills, authentication, permissions, and session storage. It does not implement a separate agent harness or require a separate model API key.

## Features

- **Paper-aware chat.** The first message includes a reference to a local copy of the current PDF. Follow-up messages reuse the same native Codex chat.
- **Model selection.** Choose from the models exposed by your installed Codex.
- **Native sessions.** Keep paper chats under a configurable `paper reading` working directory; switch history per paper and open the chat in Codex.
- **Focused interface.** `Enter` sends; `Shift + Enter` adds a line. IME composition is respected. The title can be renamed with a double-click or `F2`.
- **Clear progress.** Distinct running, complete, stopped, and failed states. Codex-provided reasoning summaries and progress appear during execution; completed replies show the answer. Raw reasoning is not displayed.
- **Readable output.** Markdown, tables, KaTeX-to-MathML formulas, and compact PDF citation buttons that open the original attachment in Zotero.
- **One-click annotation.** The **批注** button, next to the model selector, invokes the included annotation skill to create native highlights and Chinese comments in the background.
- **Library organization.** The included library skill imports papers, checks duplicates, adds collection membership, and creates nested collections.

The current sidebar labels and the two skill instructions are in Chinese. The README and development documentation are in English.

## Requirements

| Component               | Supported / verified                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Operating system        | macOS; verified on Apple Silicon. Windows and Linux are not currently supported.                                                                                                     |
| Zotero                  | 10.0.x; verified with 10.0.7. The manifest intentionally limits compatibility to 10.0.x.                                                                                             |
| Node.js                 | 22 or newer; verified with Node.js 25.                                                                                                                                               |
| Codex                   | An authenticated installation with App Server support. Integration was verified with desktop-bundled Codex `0.166.0-alpha.5.1`. Older App Server versions may lack required methods. |
| Python                  | Python 3.10+ for the optional skills; Python 3 is also used to build ZIP/XPI artifacts.                                                                                              |
| Annotation dependencies | [uv](https://docs.astral.sh/uv/) to run the annotation script and install its declared PyMuPDF/Pillow dependencies. Optional Tesseract for scanned-page OCR.                         |

This plugin uses experimental Codex App Server APIs. Compatibility with every Codex release is not guaranteed.

## Installation

1. Download `codex-for-zotero-<version>.xpi` from [Releases](https://github.com/DinoMax00/codex_for_zotero/releases/latest). **Use the `.xpi`, not GitHub's source-code ZIP.**
2. In Zotero, open **Tools → Plugins**, open the gear menu, and choose **Install Plugin From File…** Select the `.xpi`.
3. Install Node.js and install/sign in to Codex if needed. Open a PDF in Zotero, then click the book/terminal icon in the right sidebar.
4. If automatic discovery fails, use the sidebar's **⋯ → 连接设置** menu to set the absolute Node.js path, Codex executable path, and paper-reading working directory. Reconnect afterward.
5. Install the skills below to enable annotation and library management. Basic chat works without them.

The bridge starts automatically; no separate terminal process is needed. It looks for the desktop-bundled Codex before common standalone CLI locations. Node.js discovery checks common Homebrew/system locations; version-manager installations may need an explicit path.

Release assets also include `updates.json` and `SHA256SUMS`. Zotero checks the GitHub-hosted update manifest for subsequent releases when plugin updates are enabled. Existing development installations that used a placeholder update URL need one manual installation of this public release.

### Install the optional Codex skills

Download and extract `codex-for-zotero-skills-<version>.zip` from the same Release. It contains a `skills/` directory with:

- `zotero-paper-annotator` — reads the full paper, highlights important original passages, and writes Chinese comments; the title receives a whole-paper summary.
- `zotero-library-manager` — resolves DOI/arXiv/RIS/BibTeX metadata, reuses matching items, adds them to specified collections, and creates missing collection paths when requested.

Copy either or both directories to `${CODEX_HOME:-$HOME/.codex}/skills/`. From the extracted archive directory:

```sh
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R skills/zotero-paper-annotator "${CODEX_HOME:-$HOME/.codex}/skills/"
cp -R skills/zotero-library-manager "${CODEX_HOME:-$HOME/.codex}/skills/"
```

If a skill with the same name already exists, back it up before copying an update. Reconnect the plugin or restart Codex if the skills are not discovered. Keep Zotero running with this plugin enabled; the skills use its authenticated background endpoints, without a Run JavaScript window.

Example requests:

```text
Use $zotero-paper-annotator to read and annotate the attached paper in Chinese.

Use $zotero-library-manager to add this DOI to robotics/whole body.
Create the collection path if it does not exist.
```

Existing collection memberships and metadata are preserved. Local PDFs are copied into Zotero rather than moved. If an attachment download fails after a record is saved, the skill reports that partial result instead of claiming the entire import succeeded.

## Sessions and privacy

**Local integration does not mean offline inference.** Codex runs locally, but paper content, prompts, and tool output may be sent to the model provider according to your Codex configuration. Normal Codex permissions, network access, and data policies still apply. DOI resolution and PDF downloads can contact publisher services through Zotero.

The plugin adds no telemetry or developer-operated chat service. It does not bundle credentials, papers, library databases, screenshots, or chat transcripts.

| Data                       | Location / behavior                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native chat history        | Managed by Codex itself through App Server; the plugin does not edit Codex's database or session files.                                                                        |
| Default working directory  | `~/Documents/ChatGPT/paper reading`; configurable. Using this directory groups native chats by working directory; the plugin does not create or modify Codex sidebar projects. |
| Paper copies               | `<working-directory>/zotero-papers/<libraryID-attachmentKey>/<threadID>/`; includes a `paper.json` mapping. The original Zotero PDF is unchanged.                              |
| Plugin state               | `<Zotero-profile>/codex-for-zotero/`; contains connection settings, private credentials, paper-to-chat associations, and invisible annotation deduplication metadata.          |
| Skill connection discovery | `~/.local/state/codex/zotero-paper-annotator/bridge.json`; private credentials with mode `0600`. Never publish this file.                                                      |
| Highlights and comments    | Native Zotero annotations. Group-library or sync settings can make them visible to collaborators. Author and automation tags are left blank.                                   |

The chat sidecar listens on a random `127.0.0.1` port and requires a random bearer token; it rejects browser origins and unexpected hosts. The annotation/library endpoints run on Zotero's local server, require a separate private token and matching Zotero instance ID, and accept only defined operations. They do not evaluate caller-supplied JavaScript. Unsupported native approval requests are not automatically accepted.

Native Codex sessions still retain their normal tool/progress history even when the sidebar hides transient progress. Uninstalling the plugin does not delete chats, PDF copies, Zotero annotations, or skill directories. Review [SECURITY.md](SECURITY.md) before sharing logs or state files.

## Development

```sh
git clone https://github.com/DinoMax00/codex_for_zotero.git
cd codex_for_zotero
npm ci
npm test
npm run format:check
npm run build
npm run release:check
```

The build produces these release assets in `dist/`:

```text
codex-for-zotero-<version>.xpi
codex-for-zotero-skills-<version>.zip
updates.json
SHA256SUMS
```

The XPI includes the runtime bridge and third-party license notices. It excludes skills, development tools, tests, and local verification artifacts. Install the separate skill archive when needed. Source maps are not shipped. ZIP entry order, permissions, and timestamps are normalized for repeatable packaging with the same toolchain.

`npm test` runs offline JavaScript tests with simulated Codex RPC. Annotation geometry and idempotence tests generate their own PDF fixture:

```sh
uv run --with 'pymupdf>=1.26,<2' --with 'pillow>=10' \
  python skills/zotero-paper-annotator/scripts/test_paper.py
```

A read-only App Server probe is available as `npm run probe -- --codex /absolute/path/to/codex`. The optional `scripts/native-smoke.mjs` requires `--paper /absolute/test.pdf --allow-model-call`; it creates a two-turn native chat and **uses model quota**. It archives the chat on success and retains temporary files for inspection. CI never runs model calls or modifies a live Zotero library.

See [CONTRIBUTING.md](CONTRIBUTING.md) for layout and release maintenance. Integration references: [Codex App Server](https://developers.openai.com/codex/app-server/) and [Zotero plugin development](https://www.zotero.org/support/dev/zotero_7_for_developers).

## License

[MIT](LICENSE). Bundled DOMPurify, marked, and KaTeX retain their respective license notices inside the XPI. Codex and Zotero are separate products; this community project is not affiliated with or endorsed by OpenAI or the Zotero project.
