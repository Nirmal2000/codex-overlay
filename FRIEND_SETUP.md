# Codex Overlay: complete clean setup for macOS

This is the canonical handoff document for a person or coding agent installing Codex Overlay from this repository. Read it completely before changing the machine. Do not declare success until every applicable acceptance check passes **and the post-setup user orientation has been completed**.

## Rules for the setup agent

1. Work from this repository and preserve user changes.
2. Ask the user which Pi provider they want before configuring optional credentials.
3. Ask for the absolute folder Pi should use as its workspace. Do not require any filename or layout. Separately interview the user for the compact direct context that Quick and Pi must receive in their prompts.
4. Never ask the user to paste API keys or OAuth tokens into chat. Ask them to enter secrets locally in `.env` or complete an interactive Pi login.
5. Never print, inspect, commit, upload, or summarize secret values.
6. Never copy another person's `.env`, `~/.pi/agent/auth.json`, application database, screenshots, transcripts, direct context, or private workspace.
7. Apple signing and notarization are optional. Their absence must not block a local build.
8. Explain each command that changes the machine, but continue autonomously through ordinary build and verification work.
9. Stop only when interactive OAuth, macOS privacy approval, or factual context from the user is required.
10. After technical setup, teach the user how to operate every mode and control in the README. Building and launching the app is not a completed handoff.

## What to ask the user

Ask these questions one at a time and retain the answers for setup:

1. What absolute directory should Pi use as its workspace for on-demand file traversal?
2. What compact facts, background, prepared answers, and response rules must Quick know immediately without reading files or using web search?
3. Which authoritative Pi provider should be enabled first?
   - ChatGPT subscription: `openai-codex`
   - xAI subscription: `xai`
   - OpenRouter API key: `openrouter`
   - Cursor API key: `cursor`
4. Do they want Overlay mode, the normal Web App window plus iPhone PWA, or both?
5. Will the iPhone and Mac be on the same trusted Wi-Fi network?

The Quick lane and transcription currently require `OPENAI_API_KEY` and `XAI_API_KEY`, respectively. At least one Pi provider must also be authenticated.

## Supported machine

- macOS 14.2 or newer. Apple introduced the Core Audio process-tap API used for system-audio capture in macOS 14.2.
- Apple Silicon and Intel builds should both compile locally, but the final app must be built on the target architecture.
- At least 12 GB of free disk space is recommended during compilation because Rust native dependency artifacts are large.
- The Mac and iPhone must be on the same Wi-Fi network for the phone PWA.

Check the OS and architecture:

```bash
sw_vers
uname -m
df -h .
```

## Install build prerequisites

### 1. Xcode Command Line Tools

Check first:

```bash
xcode-select -p
clang --version
```

If missing, ask the user to approve Apple's installer:

```bash
xcode-select --install
```

Do not continue until `xcode-select -p` succeeds.

### 2. Homebrew packages

If Homebrew is unavailable, install it using the current instructions at <https://brew.sh/>. Then install the native build tools and Node.js:

```bash
brew install node@22 meson ninja pkg-config abseil
```

Add the correct Node path for the current shell. Apple Silicon normally uses `/opt/homebrew`; Intel normally uses `/usr/local`:

```bash
export PATH="$(brew --prefix node@22)/bin:$PATH"
```

Verify Node.js is at least 22.19 because the bundled Pi SDK requires it:

```bash
node --version
npm --version
pkg-config --modversion absl_base
```

### 3. Rust

Check first:

```bash
rustc --version
cargo --version
```

If unavailable, install Rust through the official rustup installer:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup default stable
```

Open a new terminal if `cargo` is still not found.

## Install repository dependencies

From the repository root:

```bash
npm ci
```

Do not use `npm update` during setup. `npm ci` installs the versions locked in `package-lock.json`.

Confirm the Pi CLI is present:

```bash
./node_modules/.bin/pi --version
```

## Configure credentials

Create the local environment file:

```bash
cp .env.example .env
chmod 600 .env
```

The user must edit `.env` locally. Required and optional entries are:

```dotenv
OPENAI_API_KEY=        # Required for Quick
XAI_API_KEY=           # Required for microphone and speaker transcription
OPENROUTER_API_KEY=    # Only for OpenRouter Pi models
CURSOR_API_KEY=        # Only for Cursor Pi models
PI_NODE_BIN=           # Optional Node executable override
PI_BRIDGE_PATH=        # Optional development bridge override
```

The app searches credentials in this order:

1. Process environment variables.
2. The app configuration/data `.env` under `~/Library/Application Support/local.codex.overlay/`.
3. `src-tauri/.env`.
4. Repository-root `.env`.

The repository `.gitignore` excludes `.env`, `.env.local`, and `src-tauri/.env`. Verify before any commit:

```bash
git check-ignore -v .env
```

The command must report that `.env` is ignored.

## Authenticate the Pi provider

API keys in `.env` are sufficient for OpenRouter and Cursor. Subscription providers use Pi's interactive login and store credentials in `~/.pi/agent/auth.json`.

Start Pi:

```bash
./node_modules/.bin/pi
```

Then use the matching command inside Pi:

```text
/login openai-codex
/login xai
/login openrouter
```

- For `openai-codex`, complete the ChatGPT OAuth flow in the browser.
- For `xai`, choose the subscription option and complete its flow.
- For `openrouter`, either complete its login flow or use `OPENROUTER_API_KEY`.
- Exit Pi only after it confirms authentication.

Never commit or copy `~/.pi/agent/auth.json`. Each user authenticates their own account.

## Configure the Pi workspace and direct context

The workspace and model context are different inputs.

For the **Pi workspace**, ask only for an absolute folder location. It can be an existing work folder containing any filenames and hierarchy. Pi starts with this directory as its working directory and traverses files on demand using listing, finding, grep, and read tools. Nothing in the workspace is automatically packed into the prompt, and there are no required context documents.

For **Direct context for Quick and Pi**, interview the user for the compact information the models must know immediately: personal facts, background, introductions, project summaries, prepared answers, constraints, and answer-style preferences. Distinguish verified facts from technical explanation and never invent employers, titles, dates, ownership, customers, metrics, education, or production claims.

Paste the resulting compact block into the app's **Direct context for Quick and Pi** field before starting the session. The app stores it locally and injects it directly into both prompts. Quick cannot traverse files or search the web, so every fact Quick must answer instantly belongs in this field. Pi uses the same direct context first, then traverses the workspace only when more evidence is necessary. It searches the web only when neither source is sufficient or when a current public fact is required.

Do not save the user's direct context, private workspace content, or exported profile in this repository. If the user starts sessions from the phone, configure and save the workspace and direct context once on the Mac first.

Validate the workspace folder:

```bash
WORKSPACE_ROOT="$HOME/codex-overlay-workspace"
mkdir -p "$WORKSPACE_ROOT"
./scripts/doctor.sh "$WORKSPACE_ROOT"
```

## Run all local checks

Run the automated setup workflow with the chosen Pi workspace:

```bash
./scripts/setup-macos.sh "$WORKSPACE_ROOT"
```

This performs a locked dependency install, frontend build, JavaScript tests, remote-client tests, and Rust library tests. It does not read or print secret values.

If the native WebRTC build has a stale generated cache, clean only that package and rerun:

```bash
cargo clean --manifest-path src-tauri/Cargo.toml -p webrtc-audio-processing-sys
./scripts/setup-macos.sh "$WORKSPACE_ROOT"
```

## Development run

For a first smoke test from source:

```bash
npm run tauri -- dev
```

Enter the absolute Pi workspace in the setup screen and paste the compact **Direct context for Quick and Pi**. The app saves both choices locally for future launches. Choose a Pi model whose provider was configured, then start a session.

## Build without Apple signing

The repository intentionally does not contain a signing identity. Build only the `.app` bundle:

```bash
npm run tauri -- build --bundles app
```

Do not build `targets=all` for a local handoff; that also attempts DMG packaging and adds an unnecessary failure point. A local `.app` build does not require:

- Apple Developer membership
- Developer ID Application certificate
- notarization credentials
- an App Store profile

The output is:

```text
src-tauri/target/release/bundle/macos/Codex Overlay.app
```

## Install the locally built app

Quit an older copy, then install the new bundle:

```bash
osascript -e 'tell application "Codex Overlay" to quit' 2>/dev/null || true
ditto "src-tauri/target/release/bundle/macos/Codex Overlay.app" "/Applications/Codex Overlay.app"
open -a "/Applications/Codex Overlay.app"
```

If macOS displays an unidentified-developer warning, Control-click the app in Finder, choose **Open**, and confirm once. Signing is not needed for a locally built personal app.

## Grant macOS privacy permissions

The user must grant permissions to the installed `/Applications/Codex Overlay.app`, not to an old build in another directory.

Open **System Settings → Privacy & Security** and enable Codex Overlay under:

1. **Microphone** — microphone transcription.
2. **Screen & System Audio Recording** (or the equivalent Screen Recording section on that macOS version) — screenshots and system-audio capture.
3. **Input Monitoring** — passive keyboard capture and global hotkeys.

Trigger each feature once if Codex Overlay is not yet listed. After changing permissions, completely quit and reopen the app.

If permission state is visibly stale after replacing the app:

```bash
osascript -e 'tell application "Codex Overlay" to quit' 2>/dev/null || true
tccutil reset Microphone local.codex.overlay
tccutil reset ScreenCapture local.codex.overlay
tccutil reset ListenEvent local.codex.overlay
open -a "/Applications/Codex Overlay.app"
```

Then grant the three permissions again. Use this reset only for a confirmed stale TCC state; it intentionally clears prior approval for this bundle identifier.

## Verify the Mac application

Start with a short session and confirm:

1. Pi starts in the selected workspace, and the saved direct context is injected into both Quick and Pi.
2. Quick reports ready.
3. Pi reports ready for the selected model.
4. The microphone meter moves and the user's speech appears in the live transcript.
5. Playing ordinary audio makes the speaker meter move and produces speaker transcript text.
6. A screenshot can be captured and its count appears without another permission prompt.
7. A text-only question produces streamed Quick and Pi answers.
8. A screenshot question produces answers that reflect visible image content.
9. A second turn after an image turn also completes.
10. Scrolling upward remains stable during streaming; only the true bottom follows new tokens.
11. Ending the session releases audio capture and leaves the app responsive.

Do not accept a test that merely reaches the final answer. Confirm incremental streaming is visible.

## Mandatory post-setup user orientation

After the Mac acceptance test passes, open the README with the user and demonstrate its **Available session modes** through **Phone Controller mode** sections. Do not merely send the user a link.

The installer must clearly explain:

1. **Overlay mode:** borderless, always on top, non-activating, and still an ordinary rendered window that may appear in screen capture.
2. **Web App mode:** a conventional resizable/minimizable Mac window plus the local iPhone interface. Starting a session from the phone does not intentionally activate the Mac window.
3. **Readiness:** Send stays disabled until Microphone, Speaker, Quick, and Pi are ready. Demonstrate individual recovery on the Mac and the combined Retry failed control on the phone.
4. **Manual input:** typing in the visible text area versus passive global capture toggled by **Capture keyboard** or **Shift + Backquote** (the tilde key).
5. **Passive keys:** normal US-layout characters append to the pending manual input, Backspace removes a character, Return sends, and Option + S queues a Mac screenshot. Observed keys are not swallowed from the foreground app.
6. **Always-available keys:** Option + Escape stops Pi; Option + Command + O reveals the Mac window; the Option-arrow/Space shortcuts control connected phone display scrolling.
7. **Screenshots:** capture occurs on the Mac, requires Screen & System Audio Recording permission, is queued rather than auto-sent, and multiple captures attach to one turn.
8. **Turn controls:** Send combines unsent transcript, manual input, and screenshots; Stop ends the current Pi response; Stop + Send replaces it with a new pending turn; Quick and Pi can be retried independently.
9. **Phone Display mode:** the phone renders live transcript and both streaming answer lanes and provides Start, Screenshot, Send/Stop + Send, Retry failed, and End Session controls.
10. **Phone Controller mode:** a separate minimal gesture surface; tap sends, vertical drag precisely scrolls connected Display clients, Jump latest resumes following, and Exit controller restores Display mode. Explain that a second Display client is needed if the controller phone must remain control-only.
11. **Scroll ownership:** streaming follows only from the true bottom; scrolling upward must remain stable until the reader returns to the bottom or jumps latest.
12. **Local-network limitation:** the prototype bridge has no authentication, so it must be used only on trusted Wi-Fi.

Have the user personally complete one direct-text turn, one passive-keyboard turn, one screenshot turn, one follow-up after an image, one phone-started session, one manual phone scroll during streaming, one controller gesture with another Display client, and one clean End Session. Answer their questions before declaring the setup complete.

## Set up the iPhone PWA

1. Put the Mac and iPhone on the same Wi-Fi network. Disable VPN isolation or guest-network client isolation if the phone cannot connect.
2. In Codex Overlay choose **Start Web App**.
3. Open the displayed LAN URL or scan its QR code using the iPhone.
4. Open the URL in Safari.
5. Use **Share → Add to Home Screen**.
6. Launch the installed PWA and keep the phone awake.

The same URL supports two roles:

- **Display** is the default. It renders the live transcript and both answer lanes, and exposes lifecycle/action buttons for Web App sessions.
- **Controller** is selected from the idle Display controls. It hides conversation content and becomes a gesture pad for connected Display clients. Tap sends, vertical dragging scrolls precisely, and Jump latest returns displays to the newest content.

Controller mode does not scroll the normal Mac window; it sends scroll commands to phone/tablet clients that remain in Display mode. With only one phone, exit Controller mode to see answers again.

Verify from the phone:

1. Start and end a session.
2. Select the intended Pi model before starting.
3. Capture a screenshot and send a turn.
4. See Quick and Pi stream incrementally.
5. Scroll precisely and by page.
6. Scroll upward during generation and confirm the view is not forced down.
7. Return to the true bottom and confirm following resumes.
8. Disconnect Wi-Fi briefly and confirm the PWA reconnects.

If Safari serves an older interface, close the PWA, reopen Safari at the LAN URL, reload once, and reopen the PWA. The service worker uses versioned caches.

## Troubleshooting

### Pi says authentication is missing

- Run `./node_modules/.bin/pi` and repeat the matching `/login` flow.
- For OpenRouter or Cursor, confirm the relevant `.env` line is nonempty without printing it.
- Quit and reopen Codex Overlay after changing credentials.

### Quick is unavailable

- Confirm `OPENAI_API_KEY` is configured.
- Confirm the account can access the configured Realtime model.
- Restart the session after correcting the key.

### Transcription is unavailable

- Confirm `XAI_API_KEY` is configured.
- Verify both Microphone and Screen & System Audio Recording permissions.
- Test ordinary media playback before debugging a meeting application's output routing.

### Input Monitoring remains red

- Confirm permission is enabled for the exact app under `/Applications`.
- Quit the process completely, toggle permission off and on, then reopen.
- If still stale, use the targeted `tccutil reset ListenEvent local.codex.overlay` procedure above.

### Rust cannot build WebRTC audio processing

- Confirm `meson`, `ninja`, `pkg-config`, and Xcode Command Line Tools exist.
- Clean only `webrtc-audio-processing-sys` and retry.
- Do not delete the repository or reset unrelated source changes.

### The phone cannot connect

- Confirm both devices are on the same non-guest Wi-Fi.
- Confirm the LAN URL shown by the app is reachable in iPhone Safari.
- Check macOS Firewall permission for Codex Overlay.
- Restart Web App mode to recreate the local bridge.

## Updating an existing installation

From a clean repository checkout:

```bash
git pull --ff-only
export PATH="$(brew --prefix node@22)/bin:$PATH"
npm ci
./scripts/setup-macos.sh "$WORKSPACE_ROOT"
npm run tauri -- build --bundles app
osascript -e 'tell application "Codex Overlay" to quit' 2>/dev/null || true
ditto "src-tauri/target/release/bundle/macos/Codex Overlay.app" "/Applications/Codex Overlay.app"
open -a "/Applications/Codex Overlay.app"
```

The user's `.env`, Pi authentication, private workspace, locally saved direct context, and session database are outside Git and should survive an update.

## Final acceptance checklist

The setup is complete only when all of the following are true:

- [ ] macOS is 14.2 or newer.
- [ ] Node.js is 22.19 or newer.
- [ ] Rust, Xcode Command Line Tools, Meson, Ninja, and pkg-config work.
- [ ] `.env` exists, is permission-restricted, and is ignored by Git.
- [ ] `OPENAI_API_KEY` and `XAI_API_KEY` are configured.
- [ ] The selected Pi provider is authenticated.
- [ ] The Pi workspace is selected and the direct-context field contains the facts and response rules Quick must know immediately.
- [ ] Frontend, bridge, remote, and Rust tests pass.
- [ ] The unsigned `.app` builds without requiring Apple credentials.
- [ ] The installed app launches from `/Applications`.
- [ ] Microphone, Screen & System Audio Recording, and Input Monitoring permissions work.
- [ ] Text and screenshot turns both stream in Quick and Pi.
- [ ] A subsequent turn after image input completes.
- [ ] System audio transcribes while the user can still hear it.
- [ ] The iPhone PWA connects and streams when requested.
- [ ] Scroll position remains under the reader's control.
- [ ] The installer has explained and demonstrated every operating mode, keyboard control, screenshot/send behavior, phone Display control, Controller gesture, retry path, and shutdown step in the README.
- [ ] The user has personally completed the required post-setup practice workflow.
- [ ] No secret, OAuth file, transcript, screenshot, session database, or unintended personal context is staged for Git.

## References

- Tauri prerequisites: <https://v2.tauri.app/start/prerequisites/>
- Official Rust installation: <https://rust-lang.org/tools/install/>
- Node.js downloads: <https://nodejs.org/en/download/>
- Apple Core Audio process taps: <https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps>
