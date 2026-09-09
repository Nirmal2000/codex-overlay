# Codex Overlay

Codex Overlay is a local macOS assistant with two answer lanes, live microphone and system-audio transcription, screenshot input, and an optional same-Wi-Fi iPhone PWA. The Pi lane supports subscription OAuth and API-key providers; the Quick lane uses OpenAI Realtime.

This repository is intended to be built locally. An Apple Developer account, distribution certificate, and notarization are **not required**.

## Start here

For a clean installation—especially when handing the repository to another person or an AI coding agent—read [FRIEND_SETUP.md](./FRIEND_SETUP.md) completely and follow its acceptance checklist.

The short path after prerequisites are installed is:

```bash
cp .env.example .env
# Fill OPENAI_API_KEY and XAI_API_KEY without committing the file.
./scripts/setup-macos.sh "$HOME/codex-overlay-context"
npm run tauri -- build --bundles app
ditto "src-tauri/target/release/bundle/macos/Codex Overlay.app" "/Applications/Codex Overlay.app"
open -a "/Applications/Codex Overlay.app"
```

## Runtime credentials

| Capability | Credential |
|---|---|
| Quick answer lane | `OPENAI_API_KEY` |
| Microphone and system-audio transcription | `XAI_API_KEY` |
| OpenRouter Pi models | `OPENROUTER_API_KEY` or Pi `/login openrouter` |
| Cursor Pi models | `CURSOR_API_KEY` or compatible Pi authentication |
| ChatGPT-backed Pi models | Pi `/login openai-codex` |
| xAI subscription Pi models | Pi `/login xai` |

Secrets may be supplied through process environment variables, the repository `.env`, `src-tauri/.env`, or an app-local `.env`. Repository `.env` files are ignored by Git.

## Development

```bash
npm ci
npm run tauri -- dev
```

Useful checks:

```bash
./scripts/doctor.sh /absolute/path/to/context
npm run build
npm run test:pi-bridge
npm run test:remote
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

## Platform requirement

The complete system-audio path uses Core Audio process taps and therefore requires macOS 14.2 or newer. Node.js 22.19 or newer, Rust stable, Xcode Command Line Tools, Meson, Ninja, pkg-config, and Abseil are required to build from source.

## Data

Session history and screenshots are stored locally in the application's data directory. Do not commit `.env`, OAuth credentials, screenshots, session databases, interview transcripts, or personal context unless sharing them is deliberate.

## License and lineage

Codex Overlay is GPL-3.0 software derived from the open-source Pluely project. The original license and copyright notices are retained in this repository.
