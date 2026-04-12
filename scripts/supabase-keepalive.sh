#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env"
  set +a
fi

: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${SUPABASE_ANON_KEY:?SUPABASE_ANON_KEY is required}"

KEEPALIVE_PATH="${SUPABASE_KEEPALIVE_PATH:-/rest/v1/invite_codes?select=code,is_active&is_active=eq.true&limit=1}"
KEEPALIVE_URL="${SUPABASE_URL%/}${KEEPALIVE_PATH}"

tmp_body="$(mktemp)"
trap 'rm -f "${tmp_body}"' EXIT

status_code="$(
  curl -sS \
    -o "${tmp_body}" \
    -w '%{http_code}' \
    "${KEEPALIVE_URL}" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
    -H 'Accept: application/json'
)"

if [[ "${status_code}" != "200" ]]; then
  echo "Supabase keepalive failed: HTTP ${status_code}" >&2
  cat "${tmp_body}" >&2
  exit 1
fi

echo "Supabase keepalive OK: ${SUPABASE_URL%/}"
