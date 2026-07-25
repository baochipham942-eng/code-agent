// ============================================================================
// 云货架专家的首轮权限档
// ============================================================================

import type { PermissionPreset } from '../../shared/contract/permission';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SubagentFirstRunPreset');

/**
 * 本轮子 agent 的权限档。云货架装来的专家**第一轮强制 strict**：不看包自己声明的档位——
 * 第三方 prompt 就是注入面，先让用户在最严档下看它一轮怎么干活（consume-on-use）。
 *
 * 抽成独立函数是为了让这条判定可测：它原本内联在 executeInternal 里，改坏了没有任何测试变红
 * （2026-07-25 变异验证实测的盲区）。
 */
export async function resolveSubagentPreset(
  declared: PermissionPreset | undefined,
  roleId: string | undefined,
): Promise<PermissionPreset> {
  const preset = declared || 'development';
  if (!roleId) return preset;
  const { consumeFirstRunStrict } = await import('../services/roleAssets/rolePackInstallService');
  if (!(await consumeFirstRunStrict(roleId))) return preset;
  logger.info(`[Subagent] ${roleId} 首次运行，本轮强制 strict 档（忽略包声明的 ${preset}）`);
  return 'strict';
}

