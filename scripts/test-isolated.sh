#!/bin/sh
set -eu

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/home"
printf '#!/bin/sh\nexit 44\n' > "$tmp/bin/security"
chmod +x "$tmp/bin/security"

HOME="$tmp/home" CLAUDE_CONFIG_DIR="$tmp/home/.claude" \
  XDG_CONFIG_HOME="$tmp/home/.config" XDG_DATA_HOME="$tmp/home/.local/share" \
  OPENCODE_CLAUDE_AUTH_TOKENS_FILE="$tmp/tokens.json" \
  OPENCODE_CLAUDE_AUTH_ROTATION_FILE="$tmp/rotation.json" \
  OPENCODE_CLAUDE_AUTH_WAIT_DIR="$tmp/waits" \
  OPENCODE_CLAUDE_AUTH_TOKENS= CLAUDE_CODE_OAUTH_TOKEN= CLAUDE_AUTH_DEBUG= \
  PATH="$tmp/bin:$PATH" node --test --experimental-strip-types 'src/**/*.test.ts' 'scripts/**/*.test.ts'
