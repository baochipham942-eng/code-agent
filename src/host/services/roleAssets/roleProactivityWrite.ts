// ============================================================================
// Role Proactivity 写路径 —— roles.ipc setProactivity 与 chat 工具 set_role_proactivity 共用
// ============================================================================
//
// 单一真源：写 settings.roleAssets.proactivity.roles[roleId]（最高优先级层），
// 然后立即同步 cadence cron（开 → 注册闹钟；关 → 删除闹钟），不用等重启。
// 两个入口（设置页 IPC、对话工具）都必须走本函数，不许各写一份——
// merge 语义（null 覆盖 / undefined 不动 / 数组整份替换）只在这一处维护。
// ============================================================================

import { createLogger } from '../infra/logger';
import { sanitizeTopicList } from '../../../shared/roleTopicList';
import type { RoleProactivityConfig, RoleProactivityLevel } from '../../../shared/contract/roleAssets';
import { resolveRoleProactivityConfig, syncCadenceJobs } from './roleProactivity';

const logger = createLogger('RoleProactivity');

export interface RoleProactivityWriteInput {
  level: RoleProactivityLevel;
  /** 真值才写入；undefined = 保留已存 cadence（可能是旧自定义 cron，调用方按需显式传每日简报值） */
  cadence?: string;
  /** null 写入 = 清除免打扰；undefined = 不动 */
  quietHours?: RoleProactivityConfig['quietHours'];
  /** 传了就整份覆盖（本函数内部过 sanitizeTopicList），调用方负责先做增删合并 */
  topicsInclude?: string[];
  topicsExclude?: string[];
}

/**
 * 设置角色主动性（settings 覆盖层 + 立即同步 cadence cron）。
 * 返回写后的有效配置（resolveRoleProactivityConfig 再读一遍）与 cron 同步结果。
 */
export async function writeRoleProactivityConfig(
  roleId: string,
  input: RoleProactivityWriteInput,
): Promise<{ proactivity: RoleProactivityConfig; synced: Awaited<ReturnType<typeof syncCadenceJobs>> | null }> {
  const { level, cadence, quietHours, topicsInclude, topicsExclude } = input;
  const { getConfigService } = await import('../core/configService');
  await getConfigService().updateSettings({
    roleAssets: {
      proactivity: {
        roles: {
          [roleId]: {
            level,
            ...(cadence ? { cadence } : {}),
            // null 要写进去（mergeSettings 只对非 null 对象递归，null 直接覆盖 = 清除）；
            // undefined 才是"本次不动这个字段"。数组整份覆盖（含空数组 = 清除）。
            ...(quietHours !== undefined ? { quietHours } : {}),
            ...(topicsInclude !== undefined ? { topicsInclude: sanitizeTopicList(topicsInclude) } : {}),
            ...(topicsExclude !== undefined ? { topicsExclude: sanitizeTopicList(topicsExclude) } : {}),
          },
        },
      },
    },
  });

  // cron 同步失败不阻塞设置保存（headless 测试环境可能没有 cron 服务），下次启动会兜底同步
  const synced = await syncCadenceJobs().catch((error) => {
    logger.warn('syncCadenceJobs after setProactivity failed (will sync on next startup)', error);
    return null;
  });

  return { proactivity: await resolveRoleProactivityConfig(roleId), synced };
}
