// ============================================================================
// service_tier（OpenAI Responses 请求档位）
//
// N-MODELCAT-SERVICE-TIER-WIRE：无人值守 run 走半价档的机制接线。真机调用、
// 价格倍率 UI、provider smoke 都留在父单（N-MODELCAT-SERVICE-TIER）。
// ============================================================================

/**
 * 无人值守 run 默认下发的半价档。
 *
 * UNVERIFIED：档位值 'flex' 来自 OpenAI Responses 协议的 service_tier 语义
 * （flex = 半价慢档），本仓未做付费真调用核对；owner 确认后只改这一处。
 */
export const UNATTENDED_SERVICE_TIER = 'flex';

/** JSON error.param 指向 service_tier 且状态码命中 → 判为档位拒绝。 */
const PARAM_STATUSES: readonly number[] = [400, 422];

/** error.param 匹配这个参数名才算档位拒绝（其他参数的 400/422 原样抛）。 */
const PARAM = 'service_tier';

/** error.code 命中这些值且状态码命中 → 判为档位拒绝。 */
const CODES: readonly string[] = ['unsupported_value', 'invalid_value'];

/** error.code 类信号适用的状态码（与 param 类同族）。 */
const CODE_STATUSES: readonly number[] = [400, 422];

/** 半价档当前不可用（429 + resource_unavailable）→ 摘档重试，不算失败。 */
const UNAVAILABLE: { status: number; code: string } = { status: 429, code: 'resource_unavailable' };

/**
 * 档位拒绝信号全集（结构化判据，绝不按报错文本枚举——上游自由文案换版就漏）。
 *
 * UNVERIFIED：这些 status/param/code 组合来自协议阅读，未真机核对；真机核对
 * 留给父单，届时只改本文件。
 */
export const SERVICE_TIER_REJECTION = {
  paramStatuses: PARAM_STATUSES,
  param: PARAM,
  codes: CODES,
  codeStatuses: CODE_STATUSES,
  unavailable: UNAVAILABLE,
} as const;
