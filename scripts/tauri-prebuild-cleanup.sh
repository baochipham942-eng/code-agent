#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "${SCRIPT_DIR}")"

bash "${SCRIPT_DIR}/tauri-clean-bundle-apps.sh"
bash "${SCRIPT_DIR}/stage-cua-driver-resource.sh"
bash "${SCRIPT_DIR}/build-audio-capture.sh"
bash "${SCRIPT_DIR}/build-vision-ocr.sh"
bash "${SCRIPT_DIR}/build-vision-tagger.sh"
node "${ROOT_DIR}/scripts/prepare-bundled-node.mjs"
