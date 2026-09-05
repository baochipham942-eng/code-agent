#!/usr/bin/env bash
# =============================================================================
# check-prompt-version-bump.sh — 改了系统提示词就必须 bump PROMPT_VERSION
#
# 背景：telemetry 用 PROMPT_VERSION 给每条 trace 打"第几版提示词"标签，从而能按
# promptVersion × errorType 聚合失败率。如果改了 prompt 却忘了 bump，归因就会把
# 两版提示词混成一版，诊断失真。本钩子在 pre-commit 拦下这种遗漏。
#
# 规则：本次 staged 改动里若动了「模型每轮实际读到的文本」，则 agent.ts 里的
# PROMPT_VERSION 常量值也必须在本次提交中变更，否则 fail。两个来源：
#
#   ① src/host/prompts/ 下的文件（系统提示词本体）
#   ② 工具 schema（*.schema.ts）的 description / inputSchema
#      —— 2026-08-14 L8 N-L8-PVGATE 补。工具 schema 每轮随请求全额下发，实测占模型
#      单轮输入的 40%+，改它和改系统提示词对 telemetry 归因是同一件事。此前本门只扫 ①，
#      于是 TaskManager 的 description 被整段重写、Grep/Read/Write/Glob 的参数说明被
#      改写，都一次没触发过 bump 要求。
#
# ②覆盖 tools/modules 与 plugins/builtin；只有排除注释/import/纯格式行之后仍有实质改动
# 才算。改一行注释、调整 import 顺序不该逼人 bump——那会把门变成噪音，而噪音门的
# 下场是被 --no-verify 绕过。
#
# 门的盲区自陈：
#   1) 只认 *.schema.ts。dynamicDescription 的运行时拼接逻辑住在同目录的 .ts 里
#      （如 shell/dynamicDescription.ts），改它同样改变下发文本，本门看不见。
#   2) 只管「改了要 bump」，不管「bump 的值对不对」（没人拦你从 v9 跳到 v3）。
#   已修历史盲区：旧版按 diff 行首把所有 `*` / `//` / `import` 行都当成非实质内容，
#   会误吞多行模板字符串中的 Markdown 标题、代码示例等模型可见文本。现在先按 TS 字符串/
#   块注释状态过滤完整的 HEAD 与 staged 源码，再比较模型可见内容。
#
# 用法：
#   bash scripts/check-prompt-version-bump.sh   # 检查 staged 文件（pre-commit）
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/prompt-change-paths.sh
source "$SCRIPT_DIR/lib/prompt-change-paths.sh"

# 默认保持 pre-commit staged 语义；快门只读复核完整 PR 范围。
diff_args=(--cached)
before_ref=HEAD
after_ref=""
if [[ $# -ne 0 ]]; then
  if [[ $# -ne 4 || "$1" != --base || "$3" != --head ]]; then
    echo "FAIL: expected --base <sha> --head <sha>" >&2
    exit 1
  fi
  before_ref=$(git rev-parse --verify "${2}^{commit}")
  after_ref=$(git rev-parse --verify "${4}^{commit}")
  diff_args=("$before_ref" "$after_ref")
fi
# --no-renames exposes both sides of a rename to the path checks.
staged=$(git diff "${diff_args[@]}" --no-renames --name-only --diff-filter=ACMRD)

# ── ① 是否动了 prompt 目录 ──
prompt_changed=false
while IFS= read -r f; do
  case "$f" in
    "$PROMPTS_DIR"*) prompt_changed=true; break ;;
  esac
done <<< "$staged"

# ── ② 是否动了工具 schema 的实质内容 ──
# 判据：staged 的 *.schema.ts diff 里，剔掉 diff 头、注释行、import 行之后仍有增删。
# 剔注释是为了让「只加一段说明」这类改动不必 bump——本门今天就是被一次纯注释改动触发的，
# 那次真正该 bump 的原因其实在 tools/modules 下，而它当时根本不在扫描面里。
schema_files=$(echo "$staged" | grep -E "^(${TOOL_MODULES_DIR}|${BUILTIN_PLUGINS_DIR}).*\.schema\.ts$" || true)
schema_changed=false
schema_hits=""

# 输出 schema 中可能进入模型请求的源码行。这里只排除整行注释、import 和空行；关键是
# 必须跟踪多行模板字符串与块注释状态，不能把模板正文里以 `*` / `//` / `import` 开头的
# 文本误当成源码注释或 import。awk 写成 POSIX 子集，兼容 macOS 自带 awk。
filter_schema_model_visible_source() {
  awk '
    BEGIN { state = "code" }

    function scan_line(line, i, ch, next_ch, escaped) {
      escaped = 0
      for (i = 1; i <= length(line); i++) {
        ch = substr(line, i, 1)
        next_ch = substr(line, i + 1, 1)

        if (state == "block_comment") {
          if (ch == "*" && next_ch == "/") {
            state = "code"
            i++
          }
          continue
        }

        if (state == "template") {
          if (escaped) {
            escaped = 0
          } else if (ch == "\\") {
            escaped = 1
          } else if (ch == "`") {
            state = "code"
          }
          continue
        }

        if (state == "single_quote" || state == "double_quote") {
          if (escaped) {
            escaped = 0
          } else if (ch == "\\") {
            escaped = 1
          } else if ((state == "single_quote" && ch == "\047") ||
                     (state == "double_quote" && ch == "\042")) {
            state = "code"
          }
          continue
        }

        if (ch == "/" && next_ch == "*") {
          state = "block_comment"
          i++
        } else if (ch == "/" && next_ch == "/") {
          break
        } else if (ch == "`") {
          state = "template"
        } else if (ch == "\047") {
          state = "single_quote"
        } else if (ch == "\042") {
          state = "double_quote"
        }
      }

      # JS/TS 普通引号不能裸跨行；模板字符串和块注释可以。
      if (state == "single_quote" || state == "double_quote") state = "code"
    }

    {
      line = $0
      start_state = state
      trimmed = line
      sub(/^[[:space:]]*/, "", trimmed)

      keep = 1
      if (trimmed == "") keep = 0
      else if (start_state == "block_comment") keep = 0
      else if (start_state == "code" && trimmed ~ /^\/\*/) keep = 0
      else if (start_state == "code" && trimmed ~ /^\/\//) keep = 0
      else if (start_state == "code" && trimmed ~ /^import[[:space:]]/) keep = 0

      if (keep) print line
      scan_line(line)
    }
  '
}

schema_blob() {
  git show "$1" 2>/dev/null || true
}

if [ -n "$schema_files" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if ! cmp -s \
      <(schema_blob "${before_ref}:${f}" | filter_schema_model_visible_source) \
      <(schema_blob "${after_ref}:${f}" | filter_schema_model_visible_source); then
      schema_changed=true
      schema_hits="${schema_hits}${f}"$'\n'
    fi
  done <<< "$schema_files"
fi

if [ "$prompt_changed" = false ] && [ "$schema_changed" = false ]; then
  exit 0
fi

# 动了 prompt：检查 PROMPT_VERSION 是否在本次 staged 改动里变更
# 条件：agent.ts 的 staged diff 里出现新增的 PROMPT_VERSION 行
version_bumped=false
if echo "$staged" | grep -q "^${VERSION_FILE}$"; then
  if git diff "${diff_args[@]}" -- "$VERSION_FILE" | grep -qE '^\+export const PROMPT_VERSION'; then
    version_bumped=true
  fi
fi

if [ "$version_bumped" = true ]; then
  new_version=$(git diff "${diff_args[@]}" -- "$VERSION_FILE" | grep -E '^\+export const PROMPT_VERSION' | grep -oE "'[^']+'" | head -1)
  echo -e "${GREEN}✓ 检测到 prompt 改动，PROMPT_VERSION 已 bump 到 ${new_version}${NC}"
  exit 0
fi

echo -e "${RED}✗ 提交被拦下：改了模型每轮读到的文本，但没有 bump PROMPT_VERSION${NC}"
echo ""
if [ "$prompt_changed" = true ]; then
  echo -e "${YELLOW}系统提示词文件：${NC}"
  echo "$staged" | grep "^${PROMPTS_DIR}" | sed 's/^/  /'
fi
if [ "$schema_changed" = true ]; then
  echo -e "${YELLOW}工具 schema（每轮随请求全额下发，实测占模型单轮输入 40%+）：${NC}"
  printf '%s' "$schema_hits" | sed '/^$/d; s/^/  /'
fi
echo ""
echo -e "${YELLOW}请编辑 ${VERSION_FILE}，把 PROMPT_VERSION 递增（如 sys-v1 → sys-v2）后再提交。${NC}"
echo -e "${YELLOW}原因：telemetry 靠它按版本归因失败率，漏 bump 会让两版提示词混成一版、诊断失真。${NC}"
echo ""
echo -e "${YELLOW}注意：纯注释 / 纯 import 调整本门已自动放行，不需要跳过。${NC}"
echo -e "如果确认这次改动模型看不到（例如只动了 category / permissionLevel 这类不进 schema 的元数据），"
echo -e "再考虑 ${YELLOW}git commit --no-verify${NC}——但先想清楚它到底进不进请求体。"
exit 1
