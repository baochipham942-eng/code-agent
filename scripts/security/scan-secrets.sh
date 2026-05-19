#!/usr/bin/env bash
# =============================================================================
# scan-secrets.sh — 检测高置信度 API key / token 硬编码
#
# PoC for security-audit-process.md 规则 R-A1-secret-grep。
# 设计目标：零依赖（git + grep + bash），适配 pre-commit / CI / 本地手动。
#
# 用法：
#   bash scripts/security/scan-secrets.sh           # 扫 staged 文件（默认）
#   bash scripts/security/scan-secrets.sh --all     # 扫全树（跑全量审计时用）
#   bash scripts/security/scan-secrets.sh --diff HEAD~10..HEAD   # 扫 commit range
#   bash scripts/security/scan-secrets.sh --file path/to/x.ts   # 指定文件
#
# 退出码：
#   0 — 通过（未发现 secret）
#   1 — 发现疑似 secret
#   2 — 脚本参数错误
#
# 白名单：项目根 .security-allowlist（可选），格式 "相对路径 : 规则ID"
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

ALLOWLIST_FILE="$REPO_ROOT/.security-allowlist"

# -----------------------------------------------------------------------------
# Secret patterns (高置信度 prefix-based，误报率极低)
#
# 格式：规则ID|描述|ERE 正则
# 注意：用 grep -E 跑，所以是 ERE 语法。
# -----------------------------------------------------------------------------
PATTERNS=(
  "anthropic-key|Anthropic API key|sk-ant-[a-zA-Z0-9_-]{90,}"
  "openai-project-key|OpenAI project key|sk-proj-[a-zA-Z0-9_-]{40,}"
  "openai-key|OpenAI API key|sk-[a-zA-Z0-9]{40,}T3BlbkFJ[a-zA-Z0-9]{20,}"
  "github-pat|GitHub Personal Access Token|ghp_[a-zA-Z0-9]{36,}"
  "github-oauth|GitHub OAuth token|gho_[a-zA-Z0-9]{36,}"
  "github-user-token|GitHub user token|ghu_[a-zA-Z0-9]{36,}"
  "github-server-token|GitHub server token|ghs_[a-zA-Z0-9]{36,}"
  "github-refresh|GitHub refresh token|ghr_[a-zA-Z0-9]{36,}"
  "gitlab-pat|GitLab Personal Access Token|glpat-[a-zA-Z0-9_-]{20,}"
  "slack-token|Slack token|xox[baprs]-[a-zA-Z0-9-]{20,}"
  "aws-access-key|AWS Access Key|AKIA[0-9A-Z]{16}"
  "npm-token|npm token|npm_[a-zA-Z0-9]{36,}"
  "docker-pat|Docker Personal Access Token|dckr_pat_[a-zA-Z0-9_-]{20,}"
  "pypi-token|PyPI token|pypi-[a-zA-Z0-9_-]{50,}"
)

# -----------------------------------------------------------------------------
# 排除规则（路径前缀 / 后缀）
# -----------------------------------------------------------------------------
EXCLUDE_DIRS=(
  "node_modules"
  "dist"
  "target"
  ".git"
  "coverage"
  ".next"
)

# 测试 / 文档 / fixture 是允许出现"假 key"的，跳过检测
EXCLUDE_PATH_PATTERNS=(
  "/tests/fixtures/"
  "/test/fixtures/"
  "/__fixtures__/"
  "/fixtures/secrets"
  "/docs/audits/security-audit-process.md"   # 本审计文档自身
  "/scripts/security/scan-secrets.sh"        # 本脚本自身
  "/.security-allowlist"
)

# -----------------------------------------------------------------------------
# 参数解析
# -----------------------------------------------------------------------------
MODE="staged"
DIFF_RANGE=""
SINGLE_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)
      MODE="all"
      shift
      ;;
    --diff)
      MODE="diff"
      DIFF_RANGE="${2:-}"
      if [[ -z "$DIFF_RANGE" ]]; then
        echo -e "${RED}--diff requires a range, e.g. HEAD~10..HEAD${NC}" >&2
        exit 2
      fi
      shift 2
      ;;
    --file)
      MODE="file"
      SINGLE_FILE="${2:-}"
      if [[ -z "$SINGLE_FILE" ]]; then
        echo -e "${RED}--file requires a path${NC}" >&2
        exit 2
      fi
      shift 2
      ;;
    --help|-h)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown argument: $1${NC}" >&2
      exit 2
      ;;
  esac
done

# -----------------------------------------------------------------------------
# 收集待扫描文件
# -----------------------------------------------------------------------------
get_files() {
  case "$MODE" in
    staged)
      git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true
      ;;
    all)
      git ls-files 2>/dev/null || find . -type f -not -path "./.git/*"
      ;;
    diff)
      git diff --name-only --diff-filter=ACM "$DIFF_RANGE" 2>/dev/null || true
      ;;
    file)
      echo "$SINGLE_FILE"
      ;;
  esac
}

# -----------------------------------------------------------------------------
# 检查路径是否需要跳过
# -----------------------------------------------------------------------------
should_skip() {
  local file="$1"
  for dir in "${EXCLUDE_DIRS[@]}"; do
    if [[ "$file" == *"/$dir/"* ]] || [[ "$file" == "$dir/"* ]]; then
      return 0
    fi
  done
  for pat in "${EXCLUDE_PATH_PATTERNS[@]}"; do
    if [[ "$file" == *"$pat"* ]]; then
      return 0
    fi
  done
  # 跳过二进制（粗略：检查 NUL 字符）
  if [[ -f "$file" ]] && grep -Iq . "$file" 2>/dev/null; then
    return 1  # 不跳过
  fi
  if [[ -f "$file" ]]; then
    return 0  # 是二进制，跳过
  fi
  return 0  # 不存在的文件跳过
}

# -----------------------------------------------------------------------------
# 检查白名单
# -----------------------------------------------------------------------------
is_allowlisted() {
  local file="$1"
  local rule="$2"
  if [[ ! -f "$ALLOWLIST_FILE" ]]; then
    return 1
  fi
  # 格式：file : rule_id
  if grep -qE "^\s*${file}\s*:\s*${rule}\s*$" "$ALLOWLIST_FILE" 2>/dev/null; then
    return 0
  fi
  return 1
}

# -----------------------------------------------------------------------------
# 脱敏展示匹配项
# -----------------------------------------------------------------------------
mask_secret() {
  local secret="$1"
  local len=${#secret}
  if (( len <= 10 )); then
    echo "${secret:0:3}***"
  else
    echo "${secret:0:6}***${secret:$((len-3)):3}"
  fi
}

# -----------------------------------------------------------------------------
# 扫描单个文件
# -----------------------------------------------------------------------------
SCANNED=0
FINDINGS=0
declare -a FINDING_LOG

scan_file() {
  local file="$1"
  if should_skip "$file"; then
    return 0
  fi
  if [[ ! -f "$file" ]]; then
    return 0
  fi
  SCANNED=$((SCANNED + 1))

  for entry in "${PATTERNS[@]}"; do
    local rule_id desc pattern
    rule_id="${entry%%|*}"
    local rest="${entry#*|}"
    desc="${rest%%|*}"
    pattern="${rest#*|}"

    if is_allowlisted "$file" "$rule_id"; then
      continue
    fi

    # grep -n -E 拿到 line:matched，但只取第一个匹配；如有多个我们循环
    while IFS=: read -r line_num matched; do
      [[ -z "$line_num" ]] && continue
      local masked
      masked=$(mask_secret "$matched")
      FINDINGS=$((FINDINGS + 1))
      FINDING_LOG+=("${rule_id}|${file}:${line_num}|${desc}|${masked}")
    done < <(grep -n -E -o "$pattern" "$file" 2>/dev/null || true)
  done
}

# -----------------------------------------------------------------------------
# 主流程
# -----------------------------------------------------------------------------
echo -e "${BLUE}[scan-secrets]${NC} mode=$MODE"

FILES=$(get_files)
if [[ -z "$FILES" ]]; then
  echo -e "${GREEN}[scan-secrets]${NC} no files to scan (mode=$MODE)"
  exit 0
fi

while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  scan_file "$f"
done <<< "$FILES"

# -----------------------------------------------------------------------------
# 输出
# -----------------------------------------------------------------------------
if (( FINDINGS == 0 )); then
  echo -e "${GREEN}[scan-secrets]${NC} ✅ pass — scanned $SCANNED file(s), 0 findings"
  exit 0
fi

echo -e "${RED}[scan-secrets]${NC} ❌ FAIL — found $FINDINGS suspected secret(s) in $SCANNED file(s):"
echo ""
printf "%-20s %-50s %-30s %s\n" "RULE" "LOCATION" "TYPE" "MATCH (masked)"
printf "%-20s %-50s %-30s %s\n" "----" "--------" "----" "--------------"
for finding in "${FINDING_LOG[@]}"; do
  IFS='|' read -r rule loc desc masked <<< "$finding"
  printf "%-20s %-50s %-30s %s\n" "$rule" "$loc" "$desc" "$masked"
done

echo ""
echo -e "${YELLOW}If this is a false positive (test fixture / placeholder / docs):${NC}"
echo "  1. Move it under tests/fixtures/ or /__fixtures__/, OR"
echo "  2. Add to .security-allowlist with format: <file_path> : <rule_id>"
echo ""
echo -e "${YELLOW}If this is a real key — ROTATE IT IMMEDIATELY:${NC}"
echo "  1. Revoke on provider dashboard"
echo "  2. Remove from working tree + git history (git filter-repo)"
echo "  3. Issue a new key, store in ~/.code-agent/.env (NOT in source)"

exit 1
