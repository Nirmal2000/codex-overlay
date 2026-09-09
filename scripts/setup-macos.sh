#!/bin/zsh
set -euo pipefail

PROJECT_ROOT=${0:A:h:h}
cd "$PROJECT_ROOT"

# Finder-launched shells and automation agents often omit Homebrew from PATH.
for brew_bin in /opt/homebrew/opt/node@22/bin /usr/local/opt/node@22/bin /opt/homebrew/bin /usr/local/bin; do
  [[ -d "$brew_bin" ]] && PATH="$brew_bin:$PATH"
done
export PATH

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "Codex Overlay's complete audio path currently requires macOS."
  exit 1
fi

missing=()
for command_name in xcode-select node npm rustc cargo meson ninja pkg-config; do
  command -v "$command_name" >/dev/null 2>&1 || missing+=("$command_name")
done
if (( ${#missing[@]} )); then
  print -u2 "Missing prerequisites: ${missing[*]}"
  print -u2 "Read FRIEND_SETUP.md before installing dependencies."
  exit 1
fi

if ! pkg-config --exists absl_base; then
  print -u2 "Abseil is missing. Install it with: brew install abseil"
  exit 1
fi

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 19)) process.exit(1)' || {
  print -u2 "Node.js 22.19 or newer is required. Found $(node --version)."
  exit 1
}

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  print "Created .env with empty placeholders. Fill required values before starting the app."
fi

if [[ $# -ge 1 ]]; then
  workspace_root=$1
  if [[ ! -e "$workspace_root" ]]; then
    mkdir -p "$workspace_root"
    print "Created the Pi workspace folder at $workspace_root"
  fi
fi

npm ci
npm run build
npm run test:pi-bridge
npm run test:remote
cargo test --manifest-path src-tauri/Cargo.toml --lib

print "Local setup checks passed."
print "Build the unsigned application with: npm run tauri -- build --bundles app"
