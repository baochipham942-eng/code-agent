// ============================================================================
// IM 出站 send-target 白名单（WP3-3，fail-closed）。
//
// 出站错发（把会话内容发到未授权 chat）是数据泄露，代价远高于漏发，故护栏自身
// fail-closed：配置形态异常 / 空 target 一律拒发。与入站白名单（telegram isAllowed
// 空数组=允许所有的 fail-open 语义）刻意不同——
//   - 未配置（undefined/null）= 功能关：保持存量部署行为不破坏
//   - 配置了（含空数组）= 显式启用：不在名单一律拒，空数组即全拒
// feishu / telegram 的 send 入口统一过本校验，拒发返回结构化失败不静默 drop。
// ============================================================================

export interface OutboundCheckResult {
  allowed: boolean;
  reason?: string;
}

export function checkOutboundTarget(
  allowlist: string[] | undefined | null,
  target: string,
): OutboundCheckResult {
  if (allowlist === undefined || allowlist === null) return { allowed: true };
  if (!Array.isArray(allowlist)) {
    return { allowed: false, reason: '出站白名单配置形态非法（须为字符串数组），已拒发' };
  }
  if (!target) {
    return { allowed: false, reason: '出站目标为空，已拒发' };
  }
  if (allowlist.map(String).includes(String(target))) return { allowed: true };
  return { allowed: false, reason: `出站目标 ${target} 不在白名单，已拒发` };
}
