#!/usr/bin/env bash
# One-off real-macOS probe for seatbelt subpath grants on a missing directory.
# Usage: scripts/sandbox-escalate-dir-seatbelt-probe.sh [--case NAME] [--without-grant]

set -u

SANDBOX_EXEC=/usr/bin/sandbox-exec
TMP_ROOT_INPUT=${TMPDIR:-/tmp}
if ! TMP_ROOT=$(cd "$TMP_ROOT_INPUT" 2>/dev/null && pwd -P); then
  printf 'cannot resolve TMPDIR: %s\n' "$TMP_ROOT_INPUT" >&2
  exit 2
fi

case_filter=all
without_grant=0
while (($# > 0)); do
  case "$1" in
    --case)
      if (($# < 2)); then
        printf '%s requires a case name\n' "$1" >&2
        exit 2
      fi
      case_filter=$2
      shift 2
      ;;
    --without-grant)
      without_grant=1
      shift
      ;;
    -h|--help)
      sed -n '1,6p' "$0"
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

if [[ ! -x "$SANDBOX_EXEC" ]]; then
  printf 'sandbox-exec not found or not executable: %s\n' "$SANDBOX_EXEC" >&2
  exit 2
fi

probe_root=$(mktemp -d "$TMP_ROOT/sandbox-escalate-dir-seatbelt.XXXXXX") || exit 2
T=$(cd "$probe_root" 2>/dev/null && pwd -P) || exit 2
trap 'rm -rf "$probe_root"' EXIT

# This is intentionally the same write-policy shape as seatbelt.ts: generateProfile.
build_profile() {
  local grant_line=${1:-}
  cat <<PROFILE
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev"))
${grant_line}
PROFILE
}

quote_path() {
  printf '%q' "$1"
}

case_enabled() {
  [[ "$case_filter" == all || "$case_filter" == "$1" ]]
}

run_case() {
  local label=$1
  local grant_path=$2
  local command_text=$3
  local grant_line=''
  local profile
  local stdout_file
  local stderr_file
  local exit_code

  if [[ -n "$grant_path" && "$without_grant" -eq 0 ]]; then
    grant_line="(allow file-write* (subpath \"$grant_path\"))"
  fi
  profile=$(build_profile "$grant_line")
  stdout_file=$(mktemp "$probe_root/stdout.XXXXXX")
  stderr_file=$(mktemp "$probe_root/stderr.XXXXXX")

  "$SANDBOX_EXEC" -p "$profile" /bin/sh -c "$command_text" >"$stdout_file" 2>"$stderr_file"
  exit_code=$?

  printf '\n=== %s ===\n' "$label"
  printf '%s\n' 'PROFILE:'
  printf '%s\n' "$profile"
  printf '%s\n' 'COMMAND:'
  printf '/bin/sh -c %s\n' "$command_text"
  printf 'EXIT_CODE: %s\n' "$exit_code"
  printf '%s\n' 'STDOUT (raw):'
  if [[ -s "$stdout_file" ]]; then
    cat "$stdout_file"
  else
    printf '(empty)\n'
  fi
  printf '%s\n' 'STDERR (raw):'
  if [[ -s "$stderr_file" ]]; then
    cat "$stderr_file"
  else
    printf '(empty)\n'
  fi
  printf '%s\n' "=== END $label ==="
}

# Resolve the freshly-created area through cd/pwd -P so every grant uses the real path.
mkdir -p "$T/treatment" "$T/control/old" "$T/negative" "$T/sibling" \
  "$T/symlink/real-spelling" "$T/symlink/real-target"
ln -s real-target "$T/symlink/link-spelling"

if case_enabled treatment; then
  treatment_new="$T/treatment/new"
  run_case 'TREATMENT missing directory (grant, create then write inside and below)' \
    "$treatment_new" \
    "set -e; mkdir $(quote_path "$treatment_new"); echo x > $(quote_path "$treatment_new/f"); mkdir -p $(quote_path "$treatment_new/a/b"); echo y > $(quote_path "$treatment_new/a/b/f")"
fi

if case_enabled control; then
  control_old="$T/control/old"
  run_case 'CONTROL existing directory (grant, write and mkdir below)' \
    "$control_old" \
    "set -e; echo x > $(quote_path "$control_old/f"); mkdir $(quote_path "$control_old/sub")"
fi

if case_enabled negative; then
  negative_none="$T/negative/none"
  run_case 'NEGATIVE no grant (mkdir must be denied)' \
    '' \
    "set -e; mkdir $(quote_path "$negative_none")"
fi

if case_enabled sibling; then
  sibling_new="$T/sibling/new"
  sibling_escape="$T/sibling/new/../escape"
  sibling_sibling="$T/sibling/sibling"
  run_case 'SIBLING mkdir outside granted subtree (must be denied)' \
    "$sibling_new" \
    "set -e; mkdir $(quote_path "$sibling_sibling")"
  run_case 'SIBLING parent traversal write (must be denied)' \
    "$sibling_new" \
    "set -e; mkdir $(quote_path "$sibling_new"); echo x > $(quote_path "$sibling_escape")"
fi

if case_enabled symlink; then
  symlink_base="$T/symlink"
  symlink_spelling="$symlink_base/link-spelling/new"
  real_spelling="$symlink_base/real-target/new"
  run_case 'SYMLINK grant in symlink spelling (parent symlink)' \
    "$symlink_spelling" \
    "set -e; mkdir $(quote_path "$symlink_spelling"); echo x > $(quote_path "$symlink_spelling/f")"
  run_case 'SYMLINK grant in realpath spelling (parent symlink)' \
    "$real_spelling" \
    "set -e; mkdir $(quote_path "$real_spelling"); echo x > $(quote_path "$real_spelling/f")"
fi
