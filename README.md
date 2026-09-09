# Codex Overlay

Codex Overlay is a local macOS assistant with two answer lanes, live microphone and system-audio transcription, screenshot input, and an optional same-Wi-Fi iPhone PWA. The Pi lane supports subscription OAuth and API-key providers; the Quick lane uses OpenAI Realtime.

This repository is intended to be built locally. An Apple Developer account, distribution certificate, and notarization are **not required**.

## Start here

For a clean installation—especially when handing the repository to another person or an AI coding agent—read [FRIEND_SETUP.md](./FRIEND_SETUP.md) completely and follow its acceptance checklist.

The short path after prerequisites are installed is:

```bash
cp .env.example .env
# Fill OPENAI_API_KEY and XAI_API_KEY without committing the file.
./scripts/setup-macos.sh "$HOME/codex-overlay-workspace"
npm run tauri -- build --bundles app
ditto "src-tauri/target/release/bundle/macos/Codex Overlay.app" "/Applications/Codex Overlay.app"
open -a "/Applications/Codex Overlay.app"
```

> [!IMPORTANT]
> **The setup agent is not finished when the app merely builds or opens.** After setup and acceptance testing, the agent must walk the user through the operating modes, permissions, keyboard capture, screenshots, sending and stopping turns, phone display, controller mode, scrolling, service recovery, and session shutdown described below. The agent must demonstrate the controls with the user and answer questions until the user can operate the app without reading the source code.

## How the application is organized

Every session uses a selected Pi workspace plus a compact direct-context prompt and produces two answer lanes:

- **Quick** uses OpenAI Realtime and is intended to begin streaming quickly.
- **Pi** uses the selected authoritative model and can use the workspace and configured Pi provider.

Microphone transcript is labelled **You** and captured system audio is labelled **Speaker**. Unsent transcript, manual text, and queued screenshots are combined into the next turn. Session history is stored locally.

### Workspace files versus direct context

These are deliberately separate:

- **Pi workspace folder:** provide only an absolute folder location. Pi starts in that directory and discovers relevant files with listing, finding, grep, and read tools when a question requires them. There are no required filenames, manifests, or directory structures, and workspace files are not dumped wholesale into model context.
- **Direct context for Quick and Pi:** paste a compact block into the setup screen containing the facts, background, prepared answers, and response rules that must be available immediately. It is inserted directly into both model prompts and saved only in local app storage. Quick has no filesystem or web-search tools, so anything Quick must know must be included here.

The setup agent should help the user produce the direct-context block from their private material, but must not commit it to this repository. Keep it concise enough for model context. Pi can fall back to workspace traversal when direct context is insufficient; web search is reserved for information absent from both or for current public facts.

## Available session modes

Choose the Pi model, Pi workspace directory, and direct context before starting.

| Mode | Mac window | Phone behavior | Best use |
|---|---|---|---|
| **Start Overlay** | Borderless, always-on-top, non-activating overlay that follows all macOS spaces. | The phone bridge may be reachable, but phone session controls are intended for Web App sessions. | Keeping the answer surface compact while working in another Mac application. |
| **Start Web App** | Normal decorated, resizable and minimizable **Codex Session** window. | Enables the full same-Wi-Fi display and control experience. | Using an iPhone as the primary answer display or keeping a conventional Mac window. |

The overlay is a real rendered macOS window. Do not assume that it is excluded from screenshots, recordings, or screen sharing. Use Web App mode and minimize the normal Mac window when the phone should be the only visible answer surface.

## Using the Overlay or normal Mac window

1. Enter the absolute Pi workspace folder, fill the direct-context prompt, and select the Pi model.
2. Select **Start Overlay** or **Start Web App**.
3. Wait until Microphone, Speaker, Quick, and Pi all report ready. **Send** remains disabled while any required service is starting.
4. Speak, type a manual instruction, queue screenshots, and press **Send**.
5. Read Quick while Pi continues streaming. If one lane fails, use its retry button. If a required service fails, retry that service before sending again.
6. Select **End Session** when finished so audio capture and model sessions are released and history is finalized.

### Keyboard input and global controls

Typing directly into the visible text box works normally. Passive keyboard capture is separate: select **Capture keyboard**, or press **Shift + Backquote** (the tilde key), to toggle it. Input Monitoring permission must be enabled for the installed `/Applications/Codex Overlay.app`.

While passive capture is enabled:

| Input | Action |
|---|---|
| Letter, number, punctuation, space or Tab | Append the US-keyboard-mapped character to the app's manual input. |
| Backspace | Remove the last captured character. |
| Return or numeric-keypad Enter | Send the pending turn. |
| **Option + S** | Capture a screenshot on the Mac and queue it for the next turn. |

The event tap observes rather than consumes keystrokes, so the foreground application may also receive what is typed. Passive capture currently uses a US keyboard map; non-US layouts and IME composition may not reproduce perfectly. Toggle capture off when it is not needed.

Controls that remain available without passive text capture:

| Input | Action |
|---|---|
| **Option + Escape** | Stop the current Pi response. |
| **Option + Command + O** | Show and focus the Mac window. |
| **Option + Up/Down** | Scroll connected phone display clients by a precise 28-pixel step. |
| **Option + Shift + Up/Down** | Scroll connected phone display clients by about one page. |
| **Option + Command + Down** | Jump connected phone display clients to the latest answer. |
| **Option + Space** | Toggle follow-latest mode on connected phone display clients. |

### Screenshots

Use the Mac **Screenshot** button, **Option + S** while passive capture is enabled, or **Screenshot** on the phone display. The command always captures on the Mac—not on the phone—using the macOS full-screen capture service. The image is stored under the app's local `session-media` directory and is resized only when an edge exceeds 1920 pixels.

A screenshot is queued; it is not sent immediately. The screenshot count appears in the Mac composer. Add manual text or transcript if useful, then press **Send**. Multiple screenshots become separate image inputs in the same turn. Screen & System Audio Recording permission is required, and the app normally must be fully quit and reopened after granting it for the first time.

### Sending, stopping and retrying

- **Send** submits all unsent microphone/speaker transcript, manual input, and queued screenshots as one turn to Quick and Pi.
- During generation, **Stop** or **Option + Escape** stops Pi without creating another turn.
- If new input exists while a response is active, **Stop + Send** stops the current Pi response and submits the pending material as a new turn.
- **Send** is disabled until every required service is ready. If services fail, the phone shows one **Retry failed** button; the Mac also exposes individual Mic, Speaker, Quick, and Pi recovery buttons.
- Each answer lane has its own retry control when only that lane fails.

## iPhone Web App display

The Mac runs a small HTTP/WebSocket server on the local network. Nothing is executed by the phone model-side: the Mac captures audio/screenshots, owns the session, calls the models, persists history, and streams state to the browser.

1. Keep Codex Overlay running on the Mac and put the Mac and iPhone on the same trusted, non-guest Wi-Fi.
2. Choose **Start Web App** on the Mac, or open the displayed LAN URL while the Mac is still on the setup screen.
3. Scan the QR code or open the shown `http://<mac-ip>:<port>/` URL in iPhone Safari.
4. Optionally use **Share → Add to Home Screen** for a full-screen PWA.
5. Keep the phone awake. Mobile browsers suspend WebSockets when locked.

In **Display** mode the phone shows the live transcript, Quick stream, and Pi stream. It can select a model and start a Web App session while idle; during a session it can capture a Mac screenshot, Send, Stop + Send, Retry failed, and End Session. Starting from the phone keeps the normal Mac window from being deliberately brought to the foreground.

The display follows new tokens only while it is already at the true bottom. Scrolling upward disables follow mode so streaming cannot force the reader back down. Scroll to the true bottom or use **Jump latest**/the Mac shortcut to resume following.

The bridge has no user authentication in this prototype. Use it only on a trusted Wi-Fi network; another device able to reach the LAN URL could otherwise connect as a display or controller.

## Phone Controller mode

Select **Controller** on the phone display to replace the answer UI with a large gesture pad. Controller clients receive status and controls, not the conversation body. Controller mode is designed to operate a separate phone/tablet browser that remains in **Display** mode:

- **Tap the pad** to Send, or Stop + Send while a response is active.
- **Drag vertically** for precise remote scrolling; the distance is forwarded continuously and release can continue with momentum.
- **Jump latest** moves all connected display clients to the newest answer and resumes following.
- The status shows how many display and controller clients are connected.
- **Exit controller** returns that device to Display mode.

If the only phone switches to Controller mode, it no longer shows answers and there is no separate phone display to scroll. Use Controller mode with another display client, or exit Controller mode to read on the same phone.

## Required post-setup handoff

After installation, the setup agent must explain and demonstrate all of the following to the user:

1. The difference between Overlay and Web App mode, including that the overlay is an ordinary rendered window.
2. How to start and end a session and how to confirm all four services are ready.
3. Direct text entry versus passive keyboard capture, including every shortcut listed above and the fact that observed keystrokes still reach the foreground app.
4. How screenshots are captured on the Mac, queued, attached to the next Send, and retried after permission changes.
5. What Send, Stop, Stop + Send, lane retry, service retry, and Retry failed do.
6. How to open/install the iPhone PWA, keep it connected, and distinguish Display from Controller mode.
7. How precise/page scrolling and follow-latest behavior work.
8. Where local session data and screenshots live and what must never be committed.

Setup is incomplete until the user has successfully performed one text turn, one screenshot turn, one second turn after an image, one phone-controlled turn, one manual scroll while streaming, and a clean End Session.

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

## Log in to Pi providers

From the repository root, start Pi once:

```bash
./node_modules/.bin/pi
```

At the Pi prompt, run the login matching the models the user wants:

```text
/login openai-codex
/login xai
/login openrouter
```

- **ChatGPT subscription models:** use `/login openai-codex` and complete the browser OAuth flow.
- **Grok through an xAI subscription:** use `/login xai` and complete the xAI login flow.
- **OpenRouter models:** use `/login openrouter` or set `OPENROUTER_API_KEY` locally.
- **Cursor models:** configure `CURSOR_API_KEY` or compatible Pi authentication.

Exit Pi only after it confirms authentication, then start or restart Codex Overlay. Pi stores subscription credentials in `~/.pi/agent/auth.json`; never commit or send that file to another user. Every person must authenticate their own accounts.

## Development

```bash
npm ci
npm run tauri -- dev
```

Useful checks:

```bash
./scripts/doctor.sh /absolute/path/to/pi-workspace
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
