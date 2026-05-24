#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "${SCRIPT_DIR}")"

cd "${ROOT_DIR}"

npm run rebuild-native:system

BUNDLED_NODE_PATH="${BUNDLED_NODE_PATH:-$(command -v node)}" \
  node scripts/prepare-bundled-node.mjs

bash scripts/build-audio-capture.sh
bash scripts/build-vision-ocr.sh
bash scripts/build-vision-tagger.sh

npm run build:renderer
npm run build:web

(node dist/web/webServer.cjs &)
for _ in $(seq 1 60); do
  if curl -sf http://localhost:8180/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
