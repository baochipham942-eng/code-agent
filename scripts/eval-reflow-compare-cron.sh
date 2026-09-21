#!/bin/bash
# eval-reflow-compare-cron.sh —— 回流集周跑对比候选模型（N-EVAL-FAILURE-AUTOHARVEST · 交付③）。
# 形状逐项对照 scripts/eval-core-cron.sh（N-EVAL-CORESET-CRON），不新造调度框架。
#
#   scripts/eval-reflow-compare-cron.sh              跑一轮：eval-ci --real --compare <yaml> --tags postlaunch
#   scripts/eval-reflow-compare-cron.sh --dry-run    只打印这次会用哪棵树、哪个 head、哪条命令就退出
#                                                    （NEO_EVAL_REFLOW_DRY_RUN=1 同效），不跑评测
#   scripts/eval-reflow-compare-cron.sh --install    生成 plist 装进 ~/Library/LaunchAgents 并 bootstrap（每周六 20:30 本地时间）
#   scripts/eval-reflow-compare-cron.sh --uninstall  bootout 并删 plist
#   scripts/eval-reflow-compare-cron.sh --status     launchctl print 摘要
#
# 题集 = 回流硬化后带 postlaunch tag 的题（ADR-063 回流闸：expect 空、reviewStatus pending
# 的草稿不进正式套件，loader 天然只取硬化题）。题集为空时如实写摘要退出，不假跑。
# 🔴 这是付费评测（--real × 2 臂）：脚本默认不跑，--install 由人显式执行。
#
# 环境变量：
#   NEO_EVAL_REFLOW_CANDIDATE  候选臂 yaml 路径（必填；仓内不写死任何私有路径/模型名）
#   NEO_EVAL_REFLOW_MAX_CASES  默认 30（compare 是双臂，成本 = 2 × 题数）
#   NEO_EVAL_REFLOW_EXTRA_ARGS 透传给 eval-ci（如 --judge llm）
#   NEO_EVAL_REFLOW_REPO       被测仓，默认本脚本所在仓
set -uo pipefail

REPO="${NEO_EVAL_REFLOW_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LABEL="com.linchen.neo-eval-reflow-compare-weekly"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/.code-agent/eval-reflow-cron"
INBOX="$HOME/.ship/feedback-inbox/eval-reflow-compare"
# launchd 的 PATH 只有 /usr/bin:/bin，node/npx 在 homebrew 下。
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$PATH"

case "${1:-}" in
  --install)
    case "$REPO" in *[\&\<\>\"\']*) echo "REPO 含 XML 特殊字符，拒绝生成 plist: ${REPO}"; exit 1 ;; esac
    # ai-review PR#2024 R2 Important 1：候选臂是必填项，launchd 拿不到交互 shell 的
    # 环境变量——安装时解析成绝对路径、验证存在，并写进 plist 的 EnvironmentVariables，
    # 否则装完每周任务都在候选检查处空退。
    INSTALL_CANDIDATE="${NEO_EVAL_REFLOW_CANDIDATE:-}"
    if [ -z "$INSTALL_CANDIDATE" ]; then
      echo "--install 需要先 export NEO_EVAL_REFLOW_CANDIDATE=<候选臂 yaml 路径>（会写进 plist）"; exit 1
    fi
    if [ ! -f "$INSTALL_CANDIDATE" ]; then
      echo "候选臂 yaml 不存在: $INSTALL_CANDIDATE"; exit 1
    fi
    # ai-review PR#2024 R3：写 plist 前一律规范成绝对路径——launchd 以 REPO 为工作目录
    # 起跑，相对路径在仓外安装时会解析不到（先验存在再绝对化，顺序不能反）。
    case "$INSTALL_CANDIDATE" in
      /*) ;;
      *) INSTALL_CANDIDATE="$(cd "$(dirname "$INSTALL_CANDIDATE")" && pwd -P)/$(basename "$INSTALL_CANDIDATE")" ;;
    esac
    case "$INSTALL_CANDIDATE" in *[\&\<\>\"\']*) echo "候选路径含 XML 特殊字符，拒绝生成 plist: ${INSTALL_CANDIDATE}"; exit 1 ;; esac
    mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/caffeinate</string>
		<string>-i</string>
		<string>/bin/bash</string>
		<string>$REPO/scripts/eval-reflow-compare-cron.sh</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>NEO_EVAL_REFLOW_CANDIDATE</key>
		<string>$INSTALL_CANDIDATE</string>
	</dict>
	<key>WorkingDirectory</key>
	<string>$REPO</string>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Weekday</key>
		<integer>6</integer>
		<key>Hour</key>
		<integer>20</integer>
		<key>Minute</key>
		<integer>30</integer>
	</dict>
	<key>RunAtLoad</key>
	<false/>
	<key>StandardOutPath</key>
	<string>$LOG_DIR/launchd.log</string>
	<key>StandardErrorPath</key>
	<string>$LOG_DIR/launchd.log</string>
</dict>
</plist>
PLIST
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    # ai-review PR#2024 R3：bootstrap 失败必须非零退出——否则 plist 没装上还打印 installed。
    if ! launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
      echo "launchctl bootstrap 失败，plist 未装载: $PLIST"
      exit 1
    fi
    echo "installed $PLIST (repo=$REPO)"
    exec "$0" --status
    ;;
  --uninstall)
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $LABEL"
    exit 0
    ;;
  --status)
    launchctl print "gui/$(id -u)/$LABEL" | grep -E 'state =|program =|last exit|run interval|runs =|Weekday|Hour|Minute' || echo "$LABEL 未装载"
    exit 0
    ;;
  --dry-run) NEO_EVAL_REFLOW_DRY_RUN=1 ;;
  "") ;;
  *) echo "未知参数: $1"; exit 1 ;;
esac

DRY_RUN="${NEO_EVAL_REFLOW_DRY_RUN:-}"
DATE="$(date +%F)"
LOG="$LOG_DIR/$DATE.log"
cd "$REPO" || exit 1

CANDIDATE="${NEO_EVAL_REFLOW_CANDIDATE:-}"
if [ -z "$CANDIDATE" ]; then
  echo "NEO_EVAL_REFLOW_CANDIDATE 未配置（候选臂 yaml 路径），本单不内置默认候选——不配就不跑。"
  exit 1
fi
if [ ! -f "$CANDIDATE" ]; then
  echo "候选臂 yaml 不存在: $CANDIDATE"
  exit 1
fi
# ai-review PR#2024 R4 Important 2：校验通过后立刻规范成绝对路径——非 main 时随后
# cd 进专用树，相对路径只对原 REPO 可解析（--install 入口同款，两处行为一致）。
case "$CANDIDATE" in
  /*) ;;
  *) CANDIDATE="$(cd "$(dirname "$CANDIDATE")" && pwd -P)/$(basename "$CANDIDATE")" ;;
esac

# 对准 origin/main：主仓在 main 上就自己快进；停在别的分支就不碰它（共享地面），改用专用树。
# dry-run 是纯预览：不 fetch、不动 refs、不落盘（ai-review PR#2024 R6 Nit）——head 打印的是
# 本地已有的 origin/main，可能陈旧，真实跑之前才会 fetch。
ON_MAIN=$([ "$(git branch --show-current)" = "main" ] && echo yes || echo no)
if [ "$ON_MAIN" = yes ]; then TREE="$REPO"; else TREE="$(dirname "$REPO")/code-agent-worktrees/eval-reflow-main"; fi

if [ -n "$DRY_RUN" ]; then
  echo "=== $(date '+%FT%T%z') 回流集对比 dry-run repo=$REPO on_main=$ON_MAIN max_cases=${NEO_EVAL_REFLOW_MAX_CASES:-30}"
  echo "=== tree=$TREE"
  echo "=== head=$(git rev-parse --short origin/main) (本地已有的 origin/main，可能陈旧)"
  echo "=== command: eval-ci --real --compare $CANDIDATE --tags postlaunch --max-cases ${NEO_EVAL_REFLOW_MAX_CASES:-30} ${NEO_EVAL_REFLOW_EXTRA_ARGS:-}"
  exit 0
fi

git fetch origin main || echo "!!! git fetch origin main 失败，用本地已有的 origin/main"

mkdir -p "$LOG_DIR" "$INBOX"
exec >>"$LOG" 2>&1

if [ "$ON_MAIN" = yes ]; then
  git pull --ff-only origin main || echo "!!! pull --ff-only 失败，用主仓当前 HEAD 跑"
else
  # ai-review PR#2024 R4 Important 1：专用树要认 ownership 标记 + 工作区干净才 reset --hard——
  # 固定路径若被别人的 checkout 占用，无脑 reset 会删掉人家的未提交改动（私档纪律同款事故）。
  if [ -e "$TREE/.git" ]; then
    if [ ! -f "$TREE/.eval-reflow-cron-owned" ]; then
      echo "!!! $TREE 已存在但不是本脚本建的专用树（缺 .eval-reflow-cron-owned 标记），拒绝 reset --hard，退出"
      exit 1
    fi
    # 标记与三条依赖软链是脚本自己建的未跟踪文件，porcelain 检查要排除它们
    # （否则第二周跑必被自己的产物判脏退出，ai-review PR#2024 R5 Important 1；
    #  dangling 软链连 gitignore 的 node_modules/ 尾斜杠都盖不住——真仓主树缺依赖时同款）。
    if [ -n "$(git -C "$TREE" status --porcelain | grep -v -E '^\?\? (\.eval-reflow-cron-owned|node_modules|vercel-api/node_modules|admin-console/node_modules)$')" ]; then
      echo "!!! 专用树 $TREE 有未提交改动，拒绝 reset --hard，退出"
      exit 1
    fi
    git -C "$TREE" fetch origin main && git -C "$TREE" reset --hard origin/main
  else
    git worktree add --detach "$TREE" origin/main && touch "$TREE/.eval-reflow-cron-owned"
  fi || { echo "!!! 专用树准备失败：$TREE"; exit 1; }
  for M in node_modules vercel-api/node_modules admin-console/node_modules; do
    [ -e "$TREE/$M" ] || [ -L "$TREE/$M" ] || ln -s "$REPO/$M" "$TREE/$M"
  done
  mkdir -p "$TREE/src-tauri/target"
fi
TREE="$(cd "$TREE" && pwd)"
cd "$TREE" || exit 1
[ -n "$(git branch --show-current)" ] || TREE_DETACHED="detached@origin/main"

RUN_START_LINE=$(wc -l < "$LOG")
echo "=== $(date '+%FT%T%z') 回流集对比开始 repo=$REPO head=$(git rev-parse --short HEAD) branch=$(git branch --show-current || true)${TREE_DETACHED:-} max_cases=${NEO_EVAL_REFLOW_MAX_CASES:-30}"
echo "=== tree=$TREE candidate=$CANDIDATE"

# 候选 yaml 可能是仓外绝对路径；compare 的 loadCompareConfig 支持绝对路径（workingDirectory 仅解析相对路径）。
# shellcheck disable=SC2086
npx tsx --tsconfig tsconfig.json packages/internal/evaluation-center/scripts/eval-ci.ts \
  --real --compare "$CANDIDATE" --tags postlaunch \
  --max-cases "${NEO_EVAL_REFLOW_MAX_CASES:-30}" ${NEO_EVAL_REFLOW_EXTRA_ARGS:-}
EXIT=$?
echo "=== exit=$EXIT"

REPORT_MD="$(tail -n +"$((RUN_START_LINE + 1))" "$LOG" | grep -a 'Comparison report saved to:' | tail -1 | sed -e 's/\x1b\[[0-9;]*m//g' -e 's/.*Comparison report saved to: //' -e 's/[[:space:]]*$//')"
if [ -z "$REPORT_MD" ] || [ ! -f "$REPORT_MD" ]; then
  echo "=== 本轮没有对比报告（exit=${EXIT}）；题集为空（尚无硬化的 postlaunch 题）也会走到这里"
  printf '# 回流集候选模型对比 %s\n\n⚠ exit %s：没有产出报告（题集为空或运行失败），见 %s\n' "$DATE" "$EXIT" "$LOG" > "$INBOX/$DATE.md"
  exit "$EXIT"
fi
echo "=== report=$REPORT_MD"
cp "$REPORT_MD" "$LOG_DIR/$DATE.compare.md"
{
  printf '# 回流集候选模型对比 %s\n\n' "$DATE"
  printf -- '- head=%s candidate=%s\n' "$(git rev-parse --short HEAD)" "$CANDIDATE"
  printf -- '- exit=%s 报告=%s\n\n' "$EXIT" "$LOG_DIR/$DATE.compare.md"
  # 对比 md 的结论段原样带进摘要，全文在报告里。
  sed -n '1,40p' "$LOG_DIR/$DATE.compare.md"
} > "$INBOX/$DATE.md"
echo "=== 摘要已落 $INBOX/$DATE.md"
exit "$EXIT"
