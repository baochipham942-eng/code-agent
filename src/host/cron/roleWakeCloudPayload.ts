// ============================================================================
// Role-wake cloud payload — draft 协议钉子（N-CLOUD-ROLE-WAKE-PROTO）
// ============================================================================
// 云端调度层尚未落地。这里先把「云端 role-wake 声明必须长什么样」钉成一个纯校验器，
// 云端一落地即可直接接线。payload kind 与字段名是 Neo 侧 DRAFT，落地时与云端对齐
// （owner 决策已记录在案）。

import { ROLE_PROACTIVITY } from '../../shared/constants/memory';

/** 云端 role-wake payload 的 draft kind：先钉住形状，对齐云端时可整体改。 */
const ROLE_WAKE_CLOUD_PAYLOAD_KIND = 'roleWake';

/**
 * 云端 role-wake 声明的 payload 草案。
 * - readOnlyToolScope：醒来 run 的只读工具面（云端版 resolveWakeRunToolScope 的产出）。
 * - maxWakesPerDay：每日醒来上限随声明携带；触发时点的计数是云端调度器落地后的后续单。
 */
interface RoleWakeCloudPayload {
  kind: typeof ROLE_WAKE_CLOUD_PAYLOAD_KIND;
  roleId: string;
  environmentId: string;
  readOnlyToolScope: string[];
  maxWakesPerDay: number;
}

/** 校验失败的 reason code：调用方的错误消息要原样带出，靠它区分拒因。 */
type RoleWakeCloudPayloadRejectionReason =
  | 'missing-role-id'
  | 'missing-environment-id'
  | 'invalid-max-wakes'
  | 'max-wakes-exceeds-cap'
  | 'non-read-only-tool';

/** 校验结果；non-read-only-tool 时 toolName 指认第一个不合规工具。 */
type RoleWakeCloudValidationResult =
  | { ok: true; payload: RoleWakeCloudPayload }
  | { ok: false; reason: RoleWakeCloudPayloadRejectionReason; toolName?: string };

/**
 * 纯校验器：全部输入显式传入——不读 fs/DB、不 import roleProactivity、同步。
 * 只读判定也由调用方以谓词传入，本模块不持有任何工具清单。
 * 缺失/空白字符串、非整数或 <=0 的 maxWakesPerDay 一律 fail-closed。
 */
export function validateRoleWakeCloudPayload(input: {
  roleId: string | undefined;
  environmentId: string | undefined;
  readOnlyToolScope: readonly string[];
  maxWakesPerDay: number;
  isToolReadOnly: (toolName: string) => boolean;
}): RoleWakeCloudValidationResult {
  const roleId = typeof input.roleId === 'string' ? input.roleId.trim() : '';
  if (!roleId) return { ok: false, reason: 'missing-role-id' };

  const environmentId = typeof input.environmentId === 'string' ? input.environmentId.trim() : '';
  if (!environmentId) return { ok: false, reason: 'missing-environment-id' };

  const { maxWakesPerDay } = input;
  if (!Number.isInteger(maxWakesPerDay) || maxWakesPerDay <= 0) {
    return { ok: false, reason: 'invalid-max-wakes' };
  }
  if (maxWakesPerDay > ROLE_PROACTIVITY.MAX_WAKES_PER_DAY) {
    return { ok: false, reason: 'max-wakes-exceeds-cap' };
  }

  const readOnlyToolScope = [...input.readOnlyToolScope];
  for (const toolName of readOnlyToolScope) {
    if (!input.isToolReadOnly(toolName)) {
      return { ok: false, reason: 'non-read-only-tool', toolName };
    }
  }

  return {
    ok: true,
    payload: {
      kind: ROLE_WAKE_CLOUD_PAYLOAD_KIND,
      roleId,
      environmentId,
      readOnlyToolScope,
      maxWakesPerDay,
    },
  };
}
