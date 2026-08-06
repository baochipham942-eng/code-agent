#!/usr/bin/env bash
# ============================================================================
# CUA helper 的渠道身份（生产 / dev）— 供 fetch / stage 脚本 source
# ============================================================================
# macOS TCC 按 bundle id 记账，系统设置按 bundle 只渲染一行。生产包与 dev 包各带
# 一份重签拷贝时，若共用同一个 bundle id：用户授权其中一份后启动另一份仍会重弹，
# 且设置页里两者同名同图标同一行、无法分别辨认或关闭（2026-07-31 实测）。
#
# 生产 bundle id 永远不变——改了会让所有存量用户的授权失效、被迫重新授权。
# dev 用户重新授权一次是可接受的一次性成本（弹窗显示 "…… Dev"，可分辨）。
#
# TS 侧同源实现在 src/shared/cuaHelperChannel.ts，两边必须一起改。
# ============================================================================

# 锁定的上游 cua-driver 版本。放这里而不是只留在 fetch 脚本里，是因为 stage 脚本要拿它
# 判断「手上这份 .app 还算不算数」——只验 bundle id + 签名的话，一份旧版本的 .app 会被
# 当成就绪直接用掉（跨 worktree 缓存后这条会从"理论上"变成"经常"）。
CUA_DRIVER_VERSION="0.14.2"

case "${NEO_CHANNEL:-production}" in
  production)
    CUA_BUNDLE_ID="com.agentneo.computeruse"
    CUA_APP_NAME="Agent Neo Computer Use"
    ;;
  dev)
    CUA_BUNDLE_ID="com.agentneo.computeruse.dev"
    CUA_APP_NAME="Agent Neo Computer Use Dev"
    ;;
  *)
    echo "cua-channel: 未知 NEO_CHANNEL=${NEO_CHANNEL}（只接受 production / dev）" >&2
    exit 1
    ;;
esac

# ── 机器级 staged helper 缓存 ────────────────────────────────────────────────
# 重签好的 .app 落在 repo 根的 .tauri-resources.noindex/（gitignore），所以**每个
# worktree 各要一份**：新开一个 worktree 打 dev 包就会卡在 "missing staged app"，
# 只能手动从别的树拷，或重跑一遍 fetch（下载上游 + Developer ID 重签 + Apple 时间戳，
# 时间戳服务还会间歇失败）。缓存放在 worktree 之外，让第一次构建自动补齐、零网络零签名。
#
# 缓存是**加速**不是真源：命中后仍走 app_ready()（bundle id + codesign --verify --strict），
# 校验不过就当没有，继续报错让操作者去 fetch。
#
# ⚠️ 路径**不能**放 `~/Library/Caches`（2026-08-06 实测踩坑）：那是 macOS 明确允许在磁盘
# 压力下清理的目录，而触发条件恰好是「大量构建」——也就是这份缓存最该起作用的时候。
# 当天 `~/Library/Caches/agent-neo` 与 `~/Library/Caches/Mozilla.sccache` 被同时清空。
# 这份缓存的价值 = 省掉一次上游下载 + Developer ID 重签 + Apple 时间戳往返，不是可丢数据。
CUA_CACHE_DIR="${NEO_CUA_CACHE_DIR:-${HOME}/.cache/agent-neo/cua}"
CUA_CACHED_APP="${CUA_CACHE_DIR}/${CUA_APP_NAME}.app"
