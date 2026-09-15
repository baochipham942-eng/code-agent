#!/bin/bash
# eval-core-cron.sh —— core 集周跑发车器（N-EVAL-CORESET-CRON）。由 launchd 每周调用，也可手工跑。
#
#   scripts/eval-core-cron.sh              跑一轮：eval:core --real --scope full --max-cases 50，落 ~/.code-agent/eval-cron/<日期>.log
#   scripts/eval-core-cron.sh --dry-run    只打印这次会用哪棵树、哪个 head 就退出（NEO_EVAL_CORE_DRY_RUN=1 同效），不跑评测
#   （--scope full 才能绕过「无改动跳过」；🔴 不加 --force——eval-ci 的 --force 是「无视 --max-cases 全跑」，不是「强制跑」）
#   scripts/eval-core-cron.sh --install    生成 plist 装进 ~/Library/LaunchAgents 并 bootstrap（每周日 21:00 本地时间）
#   scripts/eval-core-cron.sh --uninstall  bootout 并删 plist
#   scripts/eval-core-cron.sh --status     launchctl print 摘要
#
# 周回归必须跑最新 main，不是主仓恰好停着的分支（FB-156：主仓停在 feat/* 上时脚本自己都不存在）。
# 主仓在 main 上就 pull --ff-only；停在别的分支不去切它（共享地面），改用专用树 code-agent-worktrees/eval-core-main。
# 环境变量：NEO_EVAL_CORE_MAX_CASES（默认 50）、NEO_EVAL_CORE_EXTRA_ARGS（透传给 eval-ci，如 --concurrency 2）、
#           NEO_EVAL_CORE_REPO（被测仓，默认本脚本所在仓；从 worktree 装 plist 时指向主仓）。
# 为什么是 launchd 不是 Neo cron：Neo 的调度器只在 Electron main / webServer 进程里起（neo CLI 不起），
# 周跑不该依赖 app 常驻；action 也只有 agent/http 两类，塞一个「跑 eval-ci 子进程」要新加 action type。
# launchd 是系统级、机器醒着就跑、错过触发窗在下次唤醒补跑，且 caffeinate -i 挡住跑一半睡着。
set -uo pipefail

REPO="${NEO_EVAL_CORE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LABEL="com.linchen.neo-eval-core-weekly"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/.code-agent/eval-cron"
INBOX="$HOME/.ship/feedback-inbox/eval-core"
# launchd 的 PATH 只有 /usr/bin:/bin，node/npx 在 homebrew 下。
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$PATH"

case "${1:-}" in
  --install)
    case "$REPO" in *[\&\<\>\"\']*) echo "REPO 含 XML 特殊字符，拒绝生成 plist: ${REPO}"; exit 1 ;; esac
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
		<string>$REPO/scripts/eval-core-cron.sh</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$REPO</string>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Weekday</key>
		<integer>0</integer>
		<key>Hour</key>
		<integer>21</integer>
		<key>Minute</key>
		<integer>0</integer>
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
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
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
  --dry-run) NEO_EVAL_CORE_DRY_RUN=1 ;;
  "") ;;
  *) echo "未知参数: $1"; exit 1 ;;
esac

DRY_RUN="${NEO_EVAL_CORE_DRY_RUN:-}"
DATE="$(date +%F)"
LOG="$LOG_DIR/$DATE.log"
mkdir -p "$LOG_DIR" "$INBOX"
[ -n "$DRY_RUN" ] || exec >>"$LOG" 2>&1
cd "$REPO" || exit 1

# 对准 origin/main：主仓在 main 上就自己快进；停在别的分支就不碰它（共享地面），改用专用树。
git fetch origin main || echo "!!! git fetch origin main 失败，用本地已有的 origin/main"
ON_MAIN=$([ "$(git branch --show-current)" = "main" ] && echo yes || echo no)
if [ "$ON_MAIN" = yes ]; then TREE="$REPO"; else TREE="$(dirname "$REPO")/code-agent-worktrees/eval-core-main"; fi

# dry-run 只报「会用哪棵树、会跑哪个 head」，不 pull 也不建树：它是检查用的，不该改地面。
if [ -n "$DRY_RUN" ]; then
  echo "=== $(date '+%FT%T%z') core 周跑 dry-run repo=$REPO on_main=$ON_MAIN max_cases=${NEO_EVAL_CORE_MAX_CASES:-50}"
  echo "=== tree=$TREE"
  echo "=== head=$(git rev-parse --short origin/main) (origin/main)"
  exit 0
fi

if [ "$ON_MAIN" = yes ]; then
  git pull --ff-only origin main || echo "!!! pull --ff-only 失败，用主仓当前 HEAD 跑"
else
  if [ -e "$TREE/.git" ]; then
    git -C "$TREE" fetch origin main && git -C "$TREE" reset --hard origin/main
  else
    git worktree add --detach "$TREE" origin/main
  fi || { echo "!!! 专用树准备失败：$TREE"; exit 1; }
  # -e 对悬空软链是假：主仓那三处还没装依赖时会每次重建，得连 -L 一起判。
  for M in node_modules vercel-api/node_modules admin-console/node_modules; do
    [ -e "$TREE/$M" ] || [ -L "$TREE/$M" ] || ln -s "$REPO/$M" "$TREE/$M"
  done
  mkdir -p "$TREE/src-tauri/target"
fi
TREE="$(cd "$TREE" && pwd)"
cd "$TREE" || exit 1
# 专用树是 detached，branch 为空；补一句说明，免得日志里 branch= 看着像出错。
[ -n "$(git branch --show-current)" ] || TREE_DETACHED="detached@origin/main"

# 同日重跑追加进同一份日志：报告路径只在本次起点之后找，别把上一次的报告当本次的。
RUN_START_LINE=$(wc -l < "$LOG")
echo "=== $(date '+%FT%T%z') core 周跑开始 repo=$REPO head=$(git rev-parse --short HEAD) branch=$(git branch --show-current || true)${TREE_DETACHED:-} max_cases=${NEO_EVAL_CORE_MAX_CASES:-50}"
echo "=== tree=$TREE"

# key 来源：本机探针槽（~/.ship/scripts/eval-real-run.mts 从 ~/.code-agent-chatprobe 解密后只进子进程 env）。
# 没有这个脚本的机器退回 npm run eval:core，靠调用方给 AUTO_TEST_* / provider 环境变量。
RUNNER="$HOME/.ship/scripts/eval-real-run.mts"
# shellcheck disable=SC2086
if [ -f "$RUNNER" ]; then
  npx tsx --tsconfig tsconfig.json "$RUNNER" --split core --max-cases "${NEO_EVAL_CORE_MAX_CASES:-50}" ${NEO_EVAL_CORE_EXTRA_ARGS:-}
else
  npm run eval:core -- --real --scope full --max-cases "${NEO_EVAL_CORE_MAX_CASES:-50}" ${NEO_EVAL_CORE_EXTRA_ARGS:-}
fi
EXIT=$?
echo "=== exit=$EXIT"

REPORT_MD="$(tail -n +"$((RUN_START_LINE + 1))" "$LOG" | grep -a 'Reports saved to:' | tail -1 | sed -e 's/\x1b\[[0-9;]*m//g' -e 's/.*Reports saved to: //' -e 's/[[:space:]]*$//')"
REPORT_JSON="${REPORT_MD%.md}.json"
if [ -z "$REPORT_MD" ] || [ ! -f "$REPORT_JSON" ]; then
  echo "=== 本轮没有报告（exit=${EXIT}），无法比对；见上方 eval-ci 输出"
  printf '# core 集周跑 %s\n\n⚠ exit %s：没有产出报告，见 %s\n' "$DATE" "$EXIT" "$LOG" > "$INBOX/$DATE.md"
  exit "$EXIT"
fi
echo "=== report=$REPORT_JSON"
cp "$REPORT_JSON" "$LOG_DIR/$DATE.report.json"
PREV="$(ls -t "$LOG_DIR"/*.report.json 2>/dev/null | grep -v "/$DATE.report.json" | head -1)"
node scripts/eval-core-summary.mjs --report "$LOG_DIR/$DATE.report.json" ${PREV:+--prev "$PREV"} --exit "$EXIT" --out "$INBOX/$DATE.md"
echo "=== 摘要已落 $INBOX/$DATE.md"
exit "$EXIT"
