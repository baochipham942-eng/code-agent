#!/usr/bin/env bash
# ============================================================================
# worktree-bootstrap — 新 worktree 的构建输入引导（软链 + 拷贝）
# ============================================================================
#
# 背景（构建提速批3，2026-08-06）：新开的 git worktree 不能直接打 dev 包，
# 因为一堆构建输入是 gitignored 的（node_modules / sidecar 二进制 / swift
# helper / dist/native / dist/bundled-node），过去全靠手工补，而且漏了是
# 静默的——漏 node_modules 时 npx tsx 照跑（它自己去下载），但 vitest/tsc
# 会给一片假红。本脚本把这套补齐动作固化成一条命令。
#
# 软链 vs 拷贝是批 1 实测得出的硬约束，不是随便选的：
#   - 软链（构建期只读）：node_modules、scripts/rtk、scripts/uv、scripts/poppler
#   - 拷贝（构建期会被写，软链会写穿透污染主树）：dist/native、dist/bundled-node、
#     以及 4 个 swift helper（tauri-prebuild-cleanup 阶段会原地重编它们）
#
# 用法：
#   bash scripts/worktree-bootstrap.sh <目标worktree路径> [--source <主树路径>]
#   --source 缺省 = 本脚本所在仓库的根。
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_SOURCE="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat >&2 <<'EOF'
用法：bash scripts/worktree-bootstrap.sh <目标worktree路径> [--source <主树路径>]

把 gitignored 的构建输入从主树引导进一个**新开的** git worktree：
  - 软链（构建期只读）：node_modules、scripts/rtk、scripts/uv、scripts/poppler
  - 拷贝（构建期会被写）：dist/native、dist/bundled-node、4 个 swift helper
幂等，重复跑不报错；绝不写主树。
EOF
}

# ---- 参数解析 -------------------------------------------------------------
TARGET=""
SOURCE="${DEFAULT_SOURCE}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      [[ $# -ge 2 ]] || { echo "[worktree-bootstrap] ✗ --source 缺参数" >&2; usage; exit 2; }
      SOURCE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "[worktree-bootstrap] ✗ 未知参数：$1" >&2
      usage
      exit 2
      ;;
    *)
      if [[ -n "${TARGET}" ]]; then
        echo "[worktree-bootstrap] ✗ 多余的位置参数：$1（目标 worktree 只能给一个）" >&2
        usage
        exit 2
      fi
      TARGET="$1"
      shift
      ;;
  esac
done

if [[ -z "${TARGET}" ]]; then
  echo "[worktree-bootstrap] ✗ 缺目标 worktree 路径" >&2
  usage
  exit 2
fi

# ---- 路径归一化（物理路径，解开软链，避免「同一路径两种写法」骗过判等） ------
resolve_dir() {
  local dir="$1"
  [[ -d "${dir}" ]] || return 1
  (cd "${dir}" && pwd -P)
}

if [[ ! -d "${TARGET}" ]]; then
  echo "[worktree-bootstrap] ✗ 目标路径不存在或不是目录：${TARGET}" >&2
  exit 1
fi
TARGET_REAL="$(resolve_dir "${TARGET}")"

if [[ ! -d "${SOURCE}" ]]; then
  echo "[worktree-bootstrap] ✗ 源（主树）路径不存在或不是目录：${SOURCE}" >&2
  exit 1
fi
SOURCE_REAL="$(resolve_dir "${SOURCE}")"

# ---- 安全闸（fail-closed，先判后动） ----------------------------------------
# 1) 目标必须是「链接出来的 worktree」：linked worktree 的 .git 是一个指针文件，
#    主树的 .git 是目录。只认 .git 为**普通文件**，从机制上挡住「误把主树当目标」。
if [[ ! -f "${TARGET_REAL}/.git" ]]; then
  cat >&2 <<EOF
[worktree-bootstrap] ✗ 拒绝执行：${TARGET_REAL} 不是一个链接出来的 git worktree
  判定依据：linked worktree 的 .git 是指针文件（gitdir: ...），此处不存在或不是普通文件。
  如果这是主树（.git 是目录），绝对不允许对它跑引导——本脚本只往新 worktree 里写。
EOF
  exit 1
fi

# 2) 目标 == 源：自我引导没有意义，且软链/拷贝判等逻辑可能自毁。
if [[ "${TARGET_REAL}" == "${SOURCE_REAL}" ]]; then
  echo "[worktree-bootstrap] ✗ 拒绝执行：目标与源是同一路径（${TARGET_REAL}），自我引导没有意义" >&2
  exit 1
fi

# ---- 引导清单与补救命令 -----------------------------------------------------
# 主树缺件时绝不自动去跑 fetch/build（要网络、要 homebrew、要几分钟），
# 无人值守场景下静默启动一个长任务比直接报错更难排查——指名道姓报出来，非零退出。
remedy_for() {
  case "$1" in
    node_modules)                  echo "npm ci" ;;
    scripts/rtk)                   echo "bash scripts/fetch-rtk.sh" ;;
    scripts/uv)                    echo "bash scripts/fetch-uv.sh" ;;
    scripts/poppler)               echo "bash scripts/fetch-poppler.sh" ;;
    dist/native)                   echo "npm run rebuild-native:system" ;;
    dist/bundled-node)             echo "node scripts/prepare-bundled-node.mjs" ;;
    scripts/system-audio-capture)  echo "bash scripts/build-audio-capture.sh" ;;
    scripts/voice-aec-io)          echo "bash scripts/build-audio-capture.sh" ;;
    scripts/vision-ocr)            echo "bash scripts/build-vision-ocr.sh" ;;
    scripts/vision-tagger)         echo "bash scripts/build-vision-tagger.sh" ;;
    *)                             echo "" ;;
  esac
}

LINK_ITEMS=(
  "node_modules"
  "scripts/rtk"
  "scripts/uv"
  "scripts/poppler"
)
COPY_ITEMS=(
  "dist/native"
  "dist/bundled-node"
  "scripts/system-audio-capture"
  "scripts/voice-aec-io"
  "scripts/vision-ocr"
  "scripts/vision-tagger"
)

MISSING=0
for REL in "${LINK_ITEMS[@]}" "${COPY_ITEMS[@]}"; do
  if [[ ! -e "${SOURCE_REAL}/${REL}" ]]; then
    REMEDY="$(remedy_for "${REL}")"
    echo "[worktree-bootstrap] ✗ 主树缺 ${REL}，请先在主树（${SOURCE_REAL}）跑：${REMEDY}" >&2
    MISSING=$((MISSING + 1))
  fi
done
if [[ "${MISSING}" -gt 0 ]]; then
  echo "[worktree-bootstrap] ✗ 主树共缺 ${MISSING} 项构建输入，补齐后重跑本脚本（不会自动 fetch/build，那些要网络/homebrew/几分钟）" >&2
  exit 1
fi

# ---- 逐项引导 ---------------------------------------------------------------
LINKED=0
COPIED=0
SKIPPED=0

link_item() {
  local rel="$1"
  local src="${SOURCE_REAL}/${rel}"
  local dst="${TARGET_REAL}/${rel}"
  if [[ -L "${dst}" ]]; then
    local current
    current="$(readlink "${dst}")"
    if [[ "${current}" == "${src}" ]]; then
      echo "[skip] ${rel}（已是指向主树的软链）"
      SKIPPED=$((SKIPPED + 1))
      return 0
    fi
    rm "${dst}"
    ln -s "${src}" "${dst}"
    echo "[link] ${rel} -> ${src}（替换指向别处的旧软链）"
    LINKED=$((LINKED + 1))
    return 0
  fi
  if [[ -e "${dst}" ]]; then
    echo "[skip] ${rel}（目标已是实体文件/目录，不动）"
    SKIPPED=$((SKIPPED + 1))
    return 0
  fi
  mkdir -p "$(dirname "${dst}")"
  ln -s "${src}" "${dst}"
  echo "[link] ${rel} -> ${src}"
  LINKED=$((LINKED + 1))
}

copy_item() {
  local rel="$1"
  local src="${SOURCE_REAL}/${rel}"
  local dst="${TARGET_REAL}/${rel}"
  if [[ -L "${dst}" ]]; then
    # 拷贝项上挂软链 = 写穿透污染主树的活雷（构建期会写这些路径），必须拆掉换实体。
    rm "${dst}"
    mkdir -p "$(dirname "${dst}")"
    cp -R "${src}" "${dst}"
    echo "[copy] ${rel}（拆除软链改实体拷贝：构建期会写这里，软链会写穿透污染主树）"
    COPIED=$((COPIED + 1))
    return 0
  fi
  if [[ -e "${dst}" ]]; then
    echo "[skip] ${rel}（实体已就位）"
    SKIPPED=$((SKIPPED + 1))
    return 0
  fi
  mkdir -p "$(dirname "${dst}")"
  cp -R "${src}" "${dst}"
  echo "[copy] ${rel}"
  COPIED=$((COPIED + 1))
}

echo "[worktree-bootstrap] source=${SOURCE_REAL}"
echo "[worktree-bootstrap] target=${TARGET_REAL}"
for REL in "${LINK_ITEMS[@]}"; do
  link_item "${REL}"
done
for REL in "${COPY_ITEMS[@]}"; do
  copy_item "${REL}"
done

# ---- cua helper：只打 dev 包才需要，失败不致命但必须明着 warn -----------------
CUA_STAGE="${TARGET_REAL}/scripts/stage-cua-driver-resource.sh"
if [[ -f "${CUA_STAGE}" ]]; then
  if bash "${CUA_STAGE}"; then
    echo "[cua] stage-cua-driver-resource.sh OK"
  else
    echo "[worktree-bootstrap] WARN: cua helper 就位失败（exit $?）——纯跑测试的 worktree 不需要它；要打 dev 包时再跑：bash scripts/stage-cua-driver-resource.sh" >&2
  fi
else
  echo "[worktree-bootstrap] WARN: 目标 worktree 缺 scripts/stage-cua-driver-resource.sh，跳过 cua helper（打 dev 包前请确认该脚本存在）" >&2
fi

echo "[worktree-bootstrap] done: link=${LINKED} copy=${COPIED} skip=${SKIPPED}"
