#!/usr/bin/env bash
# Launch the signed Agent Neo helper through LaunchServices so macOS makes the
# helper app, rather than the stdio parent or the upstream CuaDriver app, the
# responsible process for Accessibility and Screen Recording.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTENTS_DIR="$(dirname "$SCRIPT_DIR")"
APP_DIR="$(dirname "$CONTENTS_DIR")"
DRIVER_BIN="$CONTENTS_DIR/MacOS/cua-driver"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "agent-neo-computer-use-mcp: macOS only" >&2
  exit 1
fi

# 身份取自「本 helper 自己是谁」，不写死常量：macOS TCC 按 bundle 记账，生产包与
# dev 包各带一份重签拷贝，写死同一个 id 会让两份抢同一个 socket、并让系统设置里
# 只出现一行无法分辨的授权条目（2026-07-31 实测）。读不到就 fail closed——静默
# 回退到写死值正是本修复要消灭的故障模式。
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$CONTENTS_DIR/Info.plist" 2>/dev/null)" || BUNDLE_ID=""
if [[ -z "$BUNDLE_ID" ]]; then
  echo "agent-neo-computer-use-mcp: 读不到自身 CFBundleIdentifier: $CONTENTS_DIR/Info.plist" >&2
  exit 1
fi

if [[ ! -x "$DRIVER_BIN" ]]; then
  echo "agent-neo-computer-use-mcp: missing signed driver: $DRIVER_BIN" >&2
  exit 1
fi

# Keep Neo's daemon isolated from the upstream default socket. A private,
# stable per-user socket lets provider reconnects reuse the LaunchServices app
# without ever discovering or relaunching /Applications/CuaDriver.app.
USER_TEMP_DIR="${TMPDIR:-$(getconf DARWIN_USER_TEMP_DIR)}"
SOCKET_DIR="${USER_TEMP_DIR%/}/$BUNDLE_ID"
SOCKET_PATH="$SOCKET_DIR/cua-driver.sock"
umask 077
mkdir -p "$SOCKET_DIR"
chmod 700 "$SOCKET_DIR"

daemon_ready() {
  "$DRIVER_BIN" status --socket "$SOCKET_PATH" >/dev/null 2>&1
}

if ! daemon_ready; then
  # Pass the concrete bundle URL. Name-based app lookup would let LaunchServices
  # resolve the upstream/Yansu brand and recreate the bug.
  /usr/bin/open -n -g "$APP_DIR" --args serve \
    --socket "$SOCKET_PATH" \
    --host-bundle-id "$BUNDLE_ID"

  # First launch can pause on both macOS permission sheets. Give the user a
  # bounded window to approve them, then fail closed so MCP never falls back.
  _attempt=0
  while (( _attempt < 300 )); do
    _attempt=$((_attempt + 1))
    if daemon_ready; then
      break
    fi
    sleep 0.1
  done
fi

if ! daemon_ready; then
  echo "agent-neo-computer-use-mcp: signed helper daemon did not become ready" >&2
  exit 1
fi

# Force the stdio process to proxy through the branded daemon. If the daemon
# disappears, fail closed instead of executing TCC-sensitive calls in the
# shell-spawned process or falling back to the upstream default daemon.
export CUA_DRIVER_RS_MCP_FORCE_PROXY=1
exec "$DRIVER_BIN" mcp --socket "$SOCKET_PATH"
