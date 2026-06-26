#!/usr/bin/env bash
# ============================================================================
# Swarm-JSONL Dogfood Smoke
# ----------------------------------------------------------------------------
# 一键验证 CODE_AGENT_SWARM_STORAGE=file 全链路:
#   webServer 启动 → POST /api/run 触发多 agent → SSE 完成
#   → ~/.code-agent/swarm-runs/*.jsonl 落地 → IPC list/detail 字段一致
#
# 用法:
#   bash scripts/smoke-swarm-jsonl.sh
#
# 环境变量(可覆盖):
#   PROVIDER (default: deepseek)
#   MODEL    (default: deepseek-chat)
#   STORAGE_DIR (default: ~/.code-agent/swarm-runs)
#
# 退出码: 0=全过 / 非 0=具体 check 失败,日志贴 RAW 输出
# ============================================================================

set -euo pipefail

PROVIDER="${PROVIDER:-deepseek}"
MODEL="${MODEL:-deepseek-chat}"
STORAGE_DIR="${STORAGE_DIR:-$HOME/.code-agent/swarm-runs}"
SESSION_ID="smoke-$(date +%Y%m%d-%H%M%S)"

# 严格 prompt(audit B 实证过的模板,强制走 AgentSpawn)
read -r -d '' SMOKE_PROMPT <<'EOF' || true
Smoke test for swarm trace JSONL backend. Follow these tool requirements exactly:
(1) Your first tool call must be ToolSearch with query 'select:AgentSpawn' and maxResults 1.
(2) After ToolSearch returns, your next tool call must be AgentSpawn (NOT TaskManager, NOT Bash, NOT Write).
(3) AgentSpawn arguments: parallel=true, agents=[
    {role:'explore', task:'Count files under src/host/agent and reply with just the count.'},
    {role:'coder', task:'Write the string smoke-ok to /tmp/swarm-jsonl-smoke.txt.'}
   ].
(4) Wait for both agents to complete, then reply with a one-line summary.
EOF

step() {
  printf '\n\033[1;36m── %s ──\033[0m\n' "$1"
}
fail() {
  printf '\n\033[1;31mFAIL: %s\033[0m\n' "$1" >&2
  exit 1
}
ok() {
  printf '\033[1;32mOK\033[0m  %s\n' "$1"
}

# ----------------------------------------------------------------------------
step "1. 启动 file 模式 webServer"
# ----------------------------------------------------------------------------
SERVER_LOG=/tmp/swarm-jsonl-smoke-server.log
rm -f "$SERVER_LOG"
CODE_AGENT_SWARM_STORAGE=file npm run dev:web:server >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

# 等 token 出现(最多 60s)
for _ in $(seq 1 60); do
  if grep -q '"token":"' "$SERVER_LOG"; then break; fi
  sleep 1
done
TOKEN=$(grep -oE '"token":"[^"]+"' "$SERVER_LOG" | head -1 | sed 's/"token":"//;s/"//')
PORT=$(grep -oE '"port":[0-9]+' "$SERVER_LOG" | head -1 | sed 's/"port"://')
[ -z "$TOKEN" ] && fail "webServer 未在 60s 内吐出 token,看 $SERVER_LOG"
ok "webServer @${PORT}, token=${TOKEN:0:8}..."

# ----------------------------------------------------------------------------
step "2. 记录触发前的 swarm-runs 文件清单"
# ----------------------------------------------------------------------------
mkdir -p "$STORAGE_DIR"
BEFORE_LIST=$(ls -1 "$STORAGE_DIR" 2>/dev/null | wc -l | tr -d ' ')
ok "触发前 ${BEFORE_LIST} 个 jsonl 文件"

# ----------------------------------------------------------------------------
step "3. POST /api/run 触发多 agent"
# ----------------------------------------------------------------------------
SSE_OUT=/tmp/swarm-jsonl-smoke.sse
BODY=$(jq -nc \
  --arg prompt "$SMOKE_PROMPT" \
  --arg session "$SESSION_ID" \
  --arg provider "$PROVIDER" \
  --arg model "$MODEL" \
  '{prompt:$prompt, project:"/tmp/swarm-smoke", sessionId:$session, provider:$provider, model:$model}')

timeout 600 curl -sS -N -X POST "http://localhost:${PORT}/api/run" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  -o "$SSE_OUT" \
  -w 'http=%{http_code} bytes=%{size_download} time=%{time_total}s\n' \
  || fail "POST /api/run 失败,看 $SSE_OUT"

# 验证 SSE 结束 + AgentSpawn 被调
grep -q '^event: agent_complete' "$SSE_OUT" || fail "SSE 没收到 agent_complete,看 $SSE_OUT"
grep -q '"name":"AgentSpawn"' "$SSE_OUT" || fail "SSE 没看到 AgentSpawn 工具调用 — 模型没遵守 prompt 要求"
ok "SSE 收完,AgentSpawn 被调"

# ----------------------------------------------------------------------------
step "4. 验 jsonl 文件落地"
# ----------------------------------------------------------------------------
AFTER_LIST=$(ls -1 "$STORAGE_DIR" 2>/dev/null | wc -l | tr -d ' ')
NEW_COUNT=$((AFTER_LIST - BEFORE_LIST))
[ "$NEW_COUNT" -lt 1 ] && fail "${STORAGE_DIR} 没新 jsonl 文件出现"

LATEST=$(ls -1t "$STORAGE_DIR"/*.jsonl 2>/dev/null | head -1)
ok "新文件: $(basename "$LATEST") ($(wc -c <"$LATEST" | tr -d ' ') bytes)"

# ----------------------------------------------------------------------------
step "5. 验 4 种 entry 类型齐全"
# ----------------------------------------------------------------------------
TYPES=$(jq -r .type "$LATEST" | sort -u | tr '\n' ' ')
echo "  entry types: $TYPES"
for need in run_started agent_upserted event run_closed; do
  echo "$TYPES" | grep -q "$need" || fail "缺 entry 类型: $need"
done
ok "4 种 entry 类型齐全"

# ----------------------------------------------------------------------------
step "6. 验 IPC list-trace-runs 能拉到这次 run"
# ----------------------------------------------------------------------------
RUN_ID=$(jq -r 'select(.type=="run_started") | .runId' "$LATEST" | head -1)
[ -z "$RUN_ID" ] && fail "从 jsonl 解析 runId 失败"
echo "  runId: $RUN_ID"

LIST_OUT=$(curl -sS -X POST "http://localhost:${PORT}/api/domain/swarm/list-trace-runs" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"payload":{"limit":5}}')
echo "$LIST_OUT" | jq -e --arg id "$RUN_ID" '.[] | select(.id == $id)' >/dev/null \
  || fail "IPC list-trace-runs 没拉到该 runId,返回: $LIST_OUT"
ok "IPC list 拉到 $RUN_ID"

# ----------------------------------------------------------------------------
step "7. 验 IPC get-trace-run-detail 字段完整"
# ----------------------------------------------------------------------------
DETAIL=$(curl -sS -X POST "http://localhost:${PORT}/api/domain/swarm/get-trace-run-detail" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$(jq -nc --arg runId "$RUN_ID" '{payload:{runId:$runId}}')")
echo "  detail summary:"
echo "$DETAIL" | jq -c '{status:.run.status, agents:(.agents|length), events:(.events|length)}'
echo "$DETAIL" | jq -e '.run.id and .agents and .events' >/dev/null \
  || fail "detail 缺关键字段"
ok "IPC detail 字段完整"

# ----------------------------------------------------------------------------
printf '\n\033[1;32m✓ Swarm-JSONL smoke 全过\033[0m\n'
echo "  jsonl: $LATEST"
echo "  log:   docs/dogfood/swarm-jsonl-log.md"
