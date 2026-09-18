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

# devUrl（tauri.conf.json）与下面的健康等待、vite proxy 都固定 8180——这是 cargo tauri dev
# 的旧契约（main.rs 注释同款）。webEnvInit 的槽位端口注入会把裸起的 dev webServer 挪去
# 8180+N，这里必须显式钉回 8180（webEnvInit 对显式端口照办不覆盖），否则健康等待空转
# 超时、Rust 侧再自起 8180 sidecar，两个 webServer 共写同一份 dev 数据目录。
(WEB_PORT=8180 node dist/web/webServer.cjs &)
for _ in $(seq 1 60); do
  if curl -sf http://localhost:8180/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
