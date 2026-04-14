#!/bin/bash
# ============================================================================
# swarm-streak.sh — 按需从 GitHub Actions API 派生 swarm CI 通过率
# ============================================================================
#
# ADR-010 #1: 不再用 ci/swarm-health.json + [skip ci] 写回（避免 1-commit
# lag），改成按需查 API。GitHub 保留 90 天 workflow run history，足够推算
# consecutivePasses / longestStreak。
#
# 用法:
#   bash scripts/ci/swarm-streak.sh                # 默认查最近 20 个 main run
#   bash scripts/ci/swarm-streak.sh 50             # 查最近 50 个
#
# 依赖: gh CLI（已认证）+ jq
# ============================================================================

set -e

LIMIT="${1:-20}"
WORKFLOW="swarm-ci.yml"

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh CLI not found. Install: https://cli.github.com" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq not found." >&2
  exit 1
fi

# 拉最近 N 个 main 分支 push 触发的 run（排除 PR/手动）
RUNS_JSON=$(gh api "repos/{owner}/{repo}/actions/workflows/${WORKFLOW}/runs?per_page=${LIMIT}&branch=main&event=push" \
  --jq '[.workflow_runs[] | select(.status=="completed") | {sha: .head_sha[0:8], conclusion, created_at, run_id: .id}]')

TOTAL=$(echo "$RUNS_JSON" | jq 'length')
if [ "$TOTAL" -eq 0 ]; then
  echo "No completed runs found"
  exit 0
fi

# 派生 consecutivePasses（最新连续 pass）和 longestStreak
STATS=$(echo "$RUNS_JSON" | jq -r '
  reduce .[] as $r (
    {current: 0, longest: 0, broken: false};
    if $r.conclusion == "success" then
      .current += (if .broken then 0 else 1 end) |
      .longest = ([.longest, .current] | max)
    else
      .broken = true
    end
  ) | "current=\(.current) longest=\(.longest)"
')

CURRENT=$(echo "$STATS" | grep -oE 'current=[0-9]+' | cut -d= -f2)
LONGEST=$(echo "$STATS" | grep -oE 'longest=[0-9]+' | cut -d= -f2)
LAST_STATUS=$(echo "$RUNS_JSON" | jq -r '.[0].conclusion')
LAST_SHA=$(echo "$RUNS_JSON" | jq -r '.[0].sha')
LAST_TIME=$(echo "$RUNS_JSON" | jq -r '.[0].created_at')

cat <<EOF
swarm-ci.yml streak (last $TOTAL runs on main):
  consecutivePasses: $CURRENT
  longestStreak:     $LONGEST
  lastStatus:        $LAST_STATUS
  lastSha:           $LAST_SHA
  lastRun:           $LAST_TIME

Recent history (newest first):
EOF

echo "$RUNS_JSON" | jq -r '.[] | "  \(if .conclusion == "success" then "✓" else "✗" end)  \(.sha)  \(.created_at)  \(.conclusion)"'
