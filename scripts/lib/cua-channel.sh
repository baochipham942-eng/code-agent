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
