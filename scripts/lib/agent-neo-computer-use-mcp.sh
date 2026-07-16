#!/usr/bin/env bash
# Launch the signed Agent Neo helper through LaunchServices so macOS makes the
# helper app, rather than the stdio parent or the upstream CuaDriver app, the
# responsible process for Accessibility and Screen Recording.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTENTS_DIR="$(dirname "$SCRIPT_DIR")"
APP_DIR="$(dirname "$CONTENTS_DIR")"
DRIVER_BIN="$CONTENTS_DIR/MacOS/cua-driver"
BUNDLE_ID="com.agentneo.computeruse"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "agent-neo-computer-use-mcp: macOS only" >&2
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
