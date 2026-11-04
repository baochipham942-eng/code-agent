// ============================================================================
// Outbound Tool Guard（N-OUTBOUND-SENSITIVE-GUARD）
// ----------------------------------------------------------------------------
// mail_send 的 subject/content 在**进权限管道之前**替换成掩码文本：审批卡
// （buildPermissionRequest 读 params）、短路匹配（shadowAdapter isSameTopLevelInput
// 比对顶层批准参数）与真实发送（connector.execute 收到的 args）三方拿到的都是
// 同一份掩码后文本——掩码若放在工具体内，第二次 canUseTool 的参数就对不上顶层
// 批准参数，会平白弹第二张审批卡。原文不落第二份：掩码替换发生在 params 上，
// 本地会话记录里的工具调用参数即为掩码后文本。
// ============================================================================

import { guardOutboundText } from '../security/sensitiveDataGuard';

const MAIL_SEND_TOOL_NAME = 'mail_send';
const MASKED_PARAM_KEYS = ['subject', 'content'] as const;

/** 掩码命中时追加进审批 reason 的注明行（任务书逐字口径）。 */
export const OUTBOUND_MASK_REASON_LINE = 'sensitive information removed';

export interface OutboundMaskResult {
  params: Record<string, unknown>;
  /** 是否真的掩掉了东西；false 时 params 保持原对象（引用不变）。 */
  redacted: boolean;
}

/** mail_send 专用：subject/content 过 shape-only 出站掩码，其余参数原样保留。 */
export function maskMailSendOutboundParams(
  toolName: string,
  params: Record<string, unknown>,
): OutboundMaskResult {
  if (toolName !== MAIL_SEND_TOOL_NAME) return { params, redacted: false };
  let redacted = false;
  const next: Record<string, unknown> = { ...params };
  for (const key of MASKED_PARAM_KEYS) {
    const value = params[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    const guarded = guardOutboundText(value);
    if (guarded.redacted) {
      next[key] = guarded.text;
      redacted = true;
    }
  }
  return redacted ? { params: next, redacted } : { params, redacted: false };
}
