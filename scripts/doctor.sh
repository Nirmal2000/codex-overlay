#!/bin/zsh
set -u

PROJECT_ROOT=${0:A:h:h}
cd "$PROJECT_ROOT"

for brew_bin in /opt/homebrew/opt/node@22/bin /usr/local/opt/node@22/bin /opt/homebrew/bin /usr/local/bin; do
  [[ -d "$brew_bin" ]] && PATH="$brew_bin:$PATH"
done
export PATH
failed=0

check_command() {
  if command -v "$1" >/dev/null 2>&1; then
    print "OK   $1: $($1 --version 2>/dev/null | head -1)"
  else
    print "FAIL $1 is missing"
    failed=1
  fi
}

for command_name in node npm rustc cargo meson ninja pkg-config; do
  check_command "$command_name"
done

if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists absl_base; then
  print "OK   abseil: $(pkg-config --modversion absl_base)"
else
  print "FAIL abseil development libraries are missing (brew install abseil)"
  failed=1
fi

if [[ -f .env ]]; then
  print "OK   .env exists"
  for key_name in OPENAI_API_KEY XAI_API_KEY; do
    configured_source=""
    if [[ -n "$(printenv "$key_name" 2>/dev/null)" ]]; then
      configured_source="process environment"
    else
      for env_candidate in .env src-tauri/.env "$HOME/Library/Application Support/local.codex.overlay/.env"; do
        if [[ -f "$env_candidate" ]] && grep -Eq "^${key_name}=.+" "$env_candidate"; then
          configured_source="$env_candidate"
          break
        fi
      done
    fi
    if [[ -n "$configured_source" ]]; then
      print "OK   $key_name is configured via $configured_source"
      continue
    fi
    print "FAIL $key_name is missing or empty"
    failed=1
  done
else
  print "FAIL .env is missing"
  failed=1
fi

context_root=${1:-}
if [[ -n "$context_root" ]]; then
  if [[ ! -d "$context_root" ]]; then
    print "FAIL context folder does not exist: $context_root"
    failed=1
  else
    context_count=$(find "$context_root" -type f \( -iname '*.md' -o -iname '*.markdown' -o -iname '*.txt' -o -iname '*.json' -o -iname '*.yaml' -o -iname '*.yml' -o -iname '*.toml' -o -iname '*.rst' -o -iname '*.csv' \) ! -path '*/.*/*' | wc -l | tr -d ' ')
    if (( context_count > 0 )); then
      print "OK   context folder contains $context_count supported document(s)"
    else
      print "FAIL context folder contains no supported UTF-8 documents"
      failed=1
    fi
  fi
else
  print "INFO Pass the context root as the first argument to validate it."
fi

if [[ -d "src-tauri/target/release/bundle/macos/Codex Overlay.app" ]]; then
  print "OK   release application exists"
else
  print "INFO release application has not been built yet"
fi

print "INFO macOS privacy permissions must be verified in System Settings and by a live smoke test."
exit "$failed"
