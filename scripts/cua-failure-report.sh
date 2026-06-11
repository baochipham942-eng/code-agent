#!/usr/bin/env bash
# ============================================================================
# CUA 失败分类报告 — 灰度期决策数据聚合
# ============================================================================
# 数据源: ~/.code-agent/logs/cua-failures.jsonl（mcpClient CUA 分支采集）
# 用法:   scripts/cua-failure-report.sh [天数，默认 7]
#
# 读法（对应三个灰度决策）:
#   no_ax_tree 占比高 → 视觉兜底（轨迹内截图+坐标点击）值得做
#   budget     占比高 → CODE_AGENT_CUA_BUDGET 上限值需要校准
#   任务失败但这里无记录 → silent-drop 在作祟，F2（代码级快照 diff）提优先级
# ============================================================================
set -euo pipefail

DAYS="${1:-7}"
STATS_FILE="${CODE_AGENT_CUA_STATS_PATH:-$HOME/.code-agent/logs/cua-failures.jsonl}"

if [[ ! -f "$STATS_FILE" ]]; then
  echo "无数据：$STATS_FILE 不存在（CUA 失败事件尚未发生，或灰度未开启）"
  exit 0
fi

python3 - "$STATS_FILE" "$DAYS" << 'EOF'
import json, sys, time
from collections import Counter, defaultdict

path, days = sys.argv[1], float(sys.argv[2])
cutoff = (time.time() - days * 86400) * 1000

records = []
with open(path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
            if r.get("ts", 0) >= cutoff:
                records.append(r)
        except json.JSONDecodeError:
            continue

if not records:
    print(f"近 {days:g} 天无 CUA 失败记录")
    sys.exit(0)

by_cat = Counter(r["category"] for r in records)
by_tool = defaultdict(Counter)
sessions = {r["sessionId"] for r in records}
for r in records:
    by_tool[r["category"]][r["tool"]] += 1

total = len(records)
print(f"CUA 失败分类报告 — 近 {days:g} 天，共 {total} 条，涉及 {len(sessions)} 个会话\n")
print(f"{'类别':<12}{'次数':>6}{'占比':>8}  高频工具")
print("-" * 56)
for cat, n in by_cat.most_common():
    tools = ", ".join(f"{t}×{c}" for t, c in by_tool[cat].most_common(3))
    print(f"{cat:<12}{n:>6}{n/total:>7.0%}  {tools}")

print("\n最近 5 条样例：")
for r in records[-5:]:
    ts = time.strftime("%m-%d %H:%M", time.localtime(r["ts"] / 1000))
    print(f"  [{ts}] {r['category']:<10} {r['tool']:<16} {r['error'][:60]}")
EOF
