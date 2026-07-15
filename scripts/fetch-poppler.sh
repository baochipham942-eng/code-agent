#!/usr/bin/env bash
# ============================================================================
# 构建自包含的 poppler (pdftoppm) sidecar bundle
# ============================================================================
# 上游: https://poppler.freedesktop.org/ (GPL-2.0)
# 用途: PPT/PDF → 每页截图（src/host/tools/media/ppt/visualReview.ts）。
#       没有它时整份 deck 只能退到 qlmanage 的单页缩略图，用户第 2 页起选不了。
# 触发时机: 仅限 Poppler promotion workflow 或本地候选制品构建。
# 正式 release 必须运行 fetch-poppler-sidecar.mjs 下载已经 promotion 的不可变制品。
#
# 为什么这个脚本和 fetch-rtk.sh / fetch-uv.sh 形态不同：
#   rtk 和 uv 的上游发布**自包含**二进制（实测只依赖 /usr/lib + 系统 framework），
#   curl 下来就能跑。poppler 上游不发 macOS 预编译产物，homebrew 的 pdftoppm 又把
#   24 个 dylib 的路径硬编码成 /opt/homebrew/...（用户机上没有 homebrew，直接拷进
#   app 会 dyld 崩）。所以这里多两步：捞传递闭包 + install_name_tool 重定位。
#
# 设计原则:
#   - 不 commit binary 进 git（跟 fetch-rtk / fetch-uv 同模式）
#   - 产物必须零 /opt/homebrew 引用，且真跑一遍多页 PDF 才算成功（见文末自检）
#   - 增量: 已存在且版本匹配则跳过
#   - arch 感知: 产物跟随当前 brew 的 arch，CI 的 arm64 / x64 runner 各自跑一次
# ============================================================================

set -euo pipefail

# homebrew 的 Cellar 目录名带 revision 后缀（26.02.0_1 = 上游 26.02.0 的第 1 次 brew 修订）。
# 钉全名保证产物可复现；pdftoppm -v 只打印上游版本，故下面比对时把 _N 去掉。
LOCK_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/config/poppler-sidecar.lock.json"
POPPLER_BREW_VERSION="$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).popplerBrewVersion" "$LOCK_FILE")"
POPPLER_VERSION="${POPPLER_BREW_VERSION%%_*}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$SCRIPT_DIR/poppler"
OUT_BIN="$OUT_DIR/bin/pdftoppm"
OUT_PROVENANCE="$OUT_DIR/compliance/binary-provenance.json"

if [[ "$(uname)" != "Darwin" ]]; then
  # Windows/Linux 侧不打包 poppler：visualReview 的截图链路目前只在 macOS 上
  # 有 LibreOffice 前置（PPTX→PDF），非 mac 平台直接跳过，运行时走既有降级链。
  echo "→ 非 macOS 平台，跳过 poppler sidecar"
  exit 0
fi

# 增量检查
if [[ -x "$OUT_BIN" ]]; then
  EXISTING="$("$OUT_BIN" -v 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)"
  if [[ "$EXISTING" == "$POPPLER_VERSION" && -s "$OUT_PROVENANCE" && "${POPPLER_FORCE_PINNED_BUILD:-0}" != "1" ]]; then
    echo "✓ poppler $POPPLER_VERSION 已是目标版本(跳过)"
    exit 0
  fi
  echo "→ 检测到旧版本 ${EXISTING:-未知}，重建到 $POPPLER_VERSION"
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "❌ 找不到 brew — poppler 上游无 macOS 预编译产物，本脚本依赖 homebrew 提供二进制" >&2
  echo "   （GitHub 的 macOS runner 自带 brew；本机开发请先装 homebrew）" >&2
  exit 1
fi

if [[ "${POPPLER_FORCE_PINNED_BUILD:-0}" == "1" ]]; then
  [[ "${POPPLER_ALLOW_PINNED_INSTALL:-0}" == "1" ]] || {
    echo "❌ POPPLER_FORCE_PINNED_BUILD requires POPPLER_ALLOW_PINNED_INSTALL=1" >&2
    exit 1
  }
  if brew list --versions poppler >/dev/null 2>&1; then
    brew uninstall --ignore-dependencies poppler
  fi
fi

CELLAR="$(brew --cellar poppler)/$POPPLER_BREW_VERSION"
if [[ ! -x "$CELLAR/bin/pdftoppm" ]]; then
  if [[ "${POPPLER_ALLOW_PINNED_INSTALL:-0}" != "1" ]]; then
    ACTUAL="$(ls "$(brew --cellar poppler)" 2>/dev/null | head -1 || true)"
    echo "❌ 缺少固定 Poppler ${POPPLER_BREW_VERSION}（当前 ${ACTUAL:-无}）" >&2
    echo "   正式 release 不允许从 floating Homebrew 安装；promotion workflow 才能设置 POPPLER_ALLOW_PINNED_INSTALL=1" >&2
    exit 1
  fi
  FORMULA_COMMIT="$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).formula.commit" "$LOCK_FILE")"
  FORMULA_PATH="$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).formula.path" "$LOCK_FILE")"
  FORMULA_SHA="$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).formula.sha256" "$LOCK_FILE")"
  TAP_ROOT="$(brew --repository)/Library/Taps/agent-neo/homebrew-poppler-build"
  brew tap-new agent-neo/poppler-build >/dev/null
  mkdir -p "$TAP_ROOT/Formula"
  curl --fail --location --proto '=https' --tlsv1.2 \
    "https://raw.githubusercontent.com/Homebrew/homebrew-core/${FORMULA_COMMIT}/${FORMULA_PATH}" \
    --output "$TAP_ROOT/Formula/poppler.rb"
  echo "${FORMULA_SHA}  $TAP_ROOT/Formula/poppler.rb" | shasum -a 256 -c -
  brew install --build-from-source agent-neo/poppler-build/poppler
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/bin" "$OUT_DIR/lib"
cp "$CELLAR/bin/pdftoppm" "$OUT_DIR/bin/"
chmod +w "$OUT_DIR/bin/pdftoppm"

echo "→ 捞传递 dylib 闭包"
python3 - "$OUT_DIR" "$CELLAR/bin/pdftoppm" <<'PY'
import json, subprocess, os, shutil, sys

out_dir, origin = sys.argv[1], sys.argv[2]

def otool_L(b):
    out = subprocess.run(['otool', '-L', b], capture_output=True, text=True).stdout
    return [l.split()[0] for l in out.splitlines()[1:] if l.strip()]

def rpaths(b):
    """读 LC_RPATH。必须按每个二进制自己的 rpath 解析 @rpath——libwebp 通过 @rpath
    引用的 libsharpyuv 不在 poppler 的 lib 下，只看 otool -L 会漏掉它，装出来的
    bundle 一跑就 dyld 崩（2026-07-14 实测踩过）。"""
    lines = subprocess.run(['otool', '-l', b], capture_output=True, text=True).stdout.splitlines()
    found = []
    for i, l in enumerate(lines):
        if 'LC_RPATH' in l:
            for j in range(i, min(i + 4, len(lines))):
                if 'path ' in lines[j]:
                    found.append(lines[j].split('path ')[1].split(' (')[0])
                    break
    return found

def resolve(dep, owner):
    if dep.startswith('/usr/lib') or dep.startswith('/System'):
        return None
    if dep.startswith('@rpath/'):
        for rp in rpaths(owner):
            rp = rp.replace('@loader_path', os.path.dirname(owner)).replace('@executable_path', os.path.dirname(owner))
            cand = os.path.join(rp, dep[len('@rpath/'):])
            if os.path.exists(cand):
                return os.path.realpath(cand)
        return None
    if dep.startswith('@loader_path/'):
        cand = dep.replace('@loader_path', os.path.dirname(owner))
        return os.path.realpath(cand) if os.path.exists(cand) else None
    return os.path.realpath(dep) if os.path.exists(dep) else None

seen, queue, copied, unresolved = set(), [origin], {}, []
while queue:
    b = queue.pop()
    if b in seen:
        continue
    seen.add(b)
    for d in otool_L(b):
        if d.startswith('/usr/lib') or d.startswith('/System'):
            continue
        r = resolve(d, b)
        if r is None:
            unresolved.append((d, os.path.basename(b)))
            continue
        base = os.path.basename(r)
        if base not in copied:
            dest = os.path.join(out_dir, 'lib', base)
            shutil.copy2(r, dest)
            os.chmod(dest, 0o755)
            copied[base] = r
        if r not in seen:
            queue.append(r)

if unresolved:
    print(f"❌ 有依赖没解析出来，bundle 会不自包含: {unresolved}", file=sys.stderr)
    sys.exit(1)
print(f"  拷入 {len(copied)} 个 dylib")

def provenance(source):
    parts = os.path.realpath(source).split(os.sep)
    try:
        index = parts.index('Cellar')
        return {'component': parts[index + 1], 'componentVersion': parts[index + 2]}
    except (ValueError, IndexError):
        raise RuntimeError(f'无法从 Homebrew Cellar 路径识别来源组件: {os.path.basename(source)}')

files = {'bin/pdftoppm': provenance(origin)}
for base, source in sorted(copied.items()):
    files[f'lib/{base}'] = provenance(source)
os.makedirs(os.path.join(out_dir, 'compliance'), exist_ok=True)
with open(os.path.join(out_dir, 'compliance', 'binary-provenance.json'), 'w') as handle:
    json.dump({'schemaVersion': 1, 'publisher': 'Agent Neo project', 'files': files}, handle, indent=2, sort_keys=True)
    handle.write('\n')
PY

echo "→ 重定位 install name"
python3 - "$OUT_DIR" <<'PY'
import subprocess, os, sys

out_dir = sys.argv[1]
lib_dir = os.path.join(out_dir, 'lib')
names = set(os.listdir(lib_dir))

def otool_L(b):
    out = subprocess.run(['otool', '-L', b], capture_output=True, text=True).stdout
    return [l.split()[0] for l in out.splitlines()[1:] if l.strip()]

def match_name(dep_base):
    """install name 里的名字（libjpeg.8.dylib）常是真实文件（libjpeg.8.3.2.dylib）
    的 symlink 名，拷进来的是 realpath 的全名，这里映射回去。"""
    if dep_base in names:
        return dep_base
    stem = dep_base.split('.dylib')[0].split('.')[0]
    return next((n for n in names if n.startswith(stem + '.')), None)

targets = [os.path.join(lib_dir, f) for f in names] + [os.path.join(out_dir, 'bin', 'pdftoppm')]
for t in targets:
    is_bin = t.endswith('pdftoppm')
    if not is_bin:
        subprocess.run(['install_name_tool', '-id', f'@loader_path/{os.path.basename(t)}', t], capture_output=True)
    for d in otool_L(t):
        if d.startswith('/usr/lib') or d.startswith('/System'):
            continue
        m = match_name(os.path.basename(d))
        if not m:
            continue
        new = f'@executable_path/../lib/{m}' if is_bin else f'@loader_path/{m}'
        subprocess.run(['install_name_tool', '-change', d, new, t], capture_output=True)
PY

# 改过 Mach-O header 后原签名失效，必须重签（ad-hoc 即可；正式发版时 CI 的
# Developer ID 签名会连同 Resources 一起再签一遍）
codesign --force -s - "$OUT_DIR"/lib/*.dylib "$OUT_BIN" 2>/dev/null || true

# ── 自检：不通过就不算成功，别把一个跑不起来的 bundle 留在树里 ──
echo "→ 自检"

LEFTOVER="$(for f in "$OUT_BIN" "$OUT_DIR"/lib/*.dylib; do otool -L "$f" | tail -n +2; done | grep -c '/opt/homebrew' || true)"
if [[ "$LEFTOVER" != "0" ]]; then
  echo "❌ 仍有 $LEFTOVER 处 /opt/homebrew 引用，用户机上会 dyld 崩" >&2
  exit 1
fi
echo "  ✓ 零 /opt/homebrew 引用"

# 真跑一遍多页 PDF——只验 `-v` 能打印版本是不够的，dylib 是懒加载的，
# 真正渲染时才会把 freetype/lcms 那条链拉起来
SELFTEST="$(mktemp -d)"
trap 'rm -rf "$SELFTEST"' EXIT
python3 - "$SELFTEST/probe.pdf" <<'PY'
import sys, zlib
# 手写一个 3 页 PDF，不依赖 magick/gs 等外部工具
pages, objs = 3, []
kids = " ".join(f"{4+i} 0 R" for i in range(pages))
objs.append(f"<< /Type /Catalog /Pages 2 0 R >>")
objs.append(f"<< /Type /Pages /Count {pages} /Kids [{kids}] >>")
objs.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
for i in range(pages):
    objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents {4+pages+i} 0 R >>")
for i in range(pages):
    s = f"BT /F1 24 Tf 20 100 Td (Page {i+1}) Tj ET"
    objs.append(f"<< /Length {len(s)} >>\nstream\n{s}\nendstream")
out, offs = b"%PDF-1.4\n", []
for n, body in enumerate(objs, 1):
    offs.append(len(out))
    out += f"{n} 0 obj\n{body}\nendobj\n".encode()
xref = len(out)
out += f"xref\n0 {len(objs)+1}\n0000000000 65535 f \n".encode()
for o in offs:
    out += f"{o:010d} 00000 n \n".encode()
out += f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
open(sys.argv[1], 'wb').write(out)
PY

mkdir -p "$SELFTEST/out"
if ! "$OUT_BIN" -jpeg -r 72 "$SELFTEST/probe.pdf" "$SELFTEST/out/p" 2>"$SELFTEST/err"; then
  echo "❌ pdftoppm 跑不起来：" >&2
  cat "$SELFTEST/err" >&2
  exit 1
fi
PAGES="$(ls "$SELFTEST/out" | wc -l | tr -d ' ')"
if [[ "$PAGES" != "3" ]]; then
  echo "❌ 自检 PDF 有 3 页，pdftoppm 只出了 $PAGES 页" >&2
  exit 1
fi
echo "  ✓ 真跑 3 页 PDF → 输出 3 页"

SIZE="$(du -sh "$OUT_DIR" | cut -f1 | tr -d ' ')"
echo "✓ poppler $POPPLER_BREW_VERSION ($(uname -m), $SIZE) → $OUT_DIR"
