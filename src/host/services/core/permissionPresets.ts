// ============================================================================
// Permission Presets - 权限预设配置
// ============================================================================

import * as nodePath from 'path';
import type { PermissionLevel, PermissionPreset } from '@shared/contract';

// PermissionPreset 类型已移至 shared/contract/permission.ts
// 此处通过 re-export 保持向后兼容
export type { PermissionPreset } from '@shared/contract';

/**
 * 权限配置接口
 */
export interface PermissionConfig {
  autoApprove: Record<PermissionLevel, boolean>;
  blockedCommands: string[];
  /** 是否自动批准项目目录内的操作 */
  trustProjectDirectory: boolean;
  /** 可信目录列表（development 模式使用） */
  trustedDirectories: string[];
  /** 危险命令是否需要二次确认 */
  confirmDangerousCommands: boolean;
}

/**
 * 预设配置定义
 */
export const PERMISSION_PRESETS: Record<Exclude<PermissionPreset, 'custom'>, PermissionConfig> = {
  /**
   * Strict 模式 - 最安全
   * - 所有操作都需要用户确认
   * - 不信任任何目录
   * - 危险命令需要二次确认
   */
  strict: {
    autoApprove: {
      read: false,
      write: false,
      execute: false,
      network: false,
    },
    blockedCommands: [
      'rm -rf /',
      'rm -rf ~',
      'rm -rf /*',
      'sudo rm',
      ':(){:|:&};:',
      'mkfs',
      'dd if=/dev/',
      '> /dev/sda',
      'chmod -R 777 /',
      'wget | sh',
      'curl | sh',
    ],
    trustProjectDirectory: false,
    trustedDirectories: [],
    confirmDangerousCommands: true,
  },

  /**
   * Development 模式 - 平衡安全与效率
   * - 读取操作自动批准
   * - 项目目录内的写入和执行自动批准
   * - 网络操作（WebSearch/WebFetch 等，读取外部信息）自动批准，研究型子 agent 需要
   * - 危险命令需要二次确认
   *
   * 注：本 preset 仅用于子 agent（getPresetConfig 只被 subagentPipeline 调用，主 agent 走 modes.ts）。
   * network 放开是产品决策——组队/研究型子 agent 联网调研是核心场景，且团队启动已走审批门；
   * write/execute 仍由 trustProjectDirectory 收口，本机变更类操作不受此放开影响。
   */
  development: {
    autoApprove: {
      read: true,
      write: false, // 通过 trustProjectDirectory 控制
      execute: false, // 通过 trustProjectDirectory 控制
      network: true, // 读取型联网自动批准（研究型子 agent 需要）；写/执行仍受控
    },
    blockedCommands: [
      'rm -rf /',
      'rm -rf ~',
      'rm -rf /*',
      'sudo rm',
      ':(){:|:&};:',
      'mkfs',
      'dd if=/dev/',
    ],
    trustProjectDirectory: true,
    trustedDirectories: [], // 运行时根据工作目录填充
    confirmDangerousCommands: true,
  },

  /**
   * CI 模式 - 四类操作全部自动批准，不受工作目录限制。
   * 专家详情「安全」页的「放手」档映射到这里。
   *
   * 「全自动批准」只作用于审批闸：硬毙清单与危险命令二次确认照旧生效——
   * 用户能让专家少问几句，但不能让它做绝对禁止的事。
   */
  ci: {
    autoApprove: {
      read: true,
      write: true,
      execute: true,
      network: true,
    },
    blockedCommands: [
      'rm -rf /',
      'rm -rf ~',
      'rm -rf /*',
      'sudo rm',
      ':(){:|:&};:',
      'mkfs',
      'dd if=/dev/',
    ],
    trustProjectDirectory: true,
    trustedDirectories: [], // CI 中通常整个 workspace 都可信
    confirmDangerousCommands: true,
  },
};

/**
 * 获取预设配置
 * @param preset 预设名称
 * @param projectDirectory 当前项目目录（用于 development 模式）
 * @returns 权限配置
 */
export function getPresetConfig(
  preset: PermissionPreset,
  projectDirectory?: string
): PermissionConfig {
  if (preset === 'custom') {
    // custom 模式返回默认的 strict 配置，由用户自行修改
    return { ...PERMISSION_PRESETS.strict };
  }

  const config = { ...PERMISSION_PRESETS[preset] };

  // development 模式下，将项目目录添加到可信目录
  if (preset === 'development' && projectDirectory) {
    config.trustedDirectories = [projectDirectory];
  }

  return config;
}

/**
 * 检查路径是否在可信目录内
 * @param path 要检查的路径
 * @param trustedDirectories 可信目录列表
 * @returns 是否可信
 */
export function isPathTrusted(
  targetPath: string,
  trustedDirectories: string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!targetPath || trustedDirectories.length === 0) {
    return false;
  }

  // 按平台选 path 实现：win32 路径（C:\、反斜杠、大小写不敏感）用字符串前缀
  // 拼 '/' 判断会失效，导致信任目录匹配错误（漏判或 /foo 误匹配 /foobar）
  const p = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const fold = (input: string): string => (platform === 'win32' ? input.toLowerCase() : input);

  const normalize = (input: string): string => {
    let normalized = p.normalize(input);
    while (normalized.length > 1 && normalized.endsWith(p.sep)) {
      normalized = normalized.slice(0, -1);
    }
    return fold(normalized);
  };

  const normalizedTarget = normalize(targetPath);

  return trustedDirectories.some((dir) => {
    const normalizedDir = normalize(dir);
    if (normalizedTarget === normalizedDir) return true;
    const rel = p.relative(normalizedDir, normalizedTarget);
    // rel 为空=同路径；以 .. 段开头=在目录外；绝对路径=跨盘符（win32）
    if (rel === '' || rel === '..' || rel.startsWith('..' + p.sep)) return false;
    return !p.isAbsolute(rel);
  });
}

/**
 * 检查命令是否被阻止
 * @param command 要检查的命令
 * @param blockedCommands 阻止命令列表
 * @returns 是否被阻止
 */
export function isCommandBlocked(command: string, blockedCommands: string[]): boolean {
  const normalizedCommand = command.trim().toLowerCase();
  return blockedCommands.some((blocked) => {
    const normalizedBlocked = blocked.toLowerCase();
    return normalizedCommand.includes(normalizedBlocked);
  });
}

/**
 * 检查命令是否为危险命令（需要二次确认）
 * @param command 要检查的命令
 * @returns 是否危险
 */
export function isDangerousCommand(command: string): boolean {
  const dangerousPatterns = [
    /\brm\s+(-[rf]+\s+)*[/~]/i, // rm with paths
    /\bsudo\b/i,
    /\bchmod\s+.*777/i,
    /\bchown\s+-R/i,
    /\bgit\s+(push\s+--force|reset\s+--hard)/i,
    /\bdrop\s+(database|table)/i,
    /\btruncate\s+table/i,
    /\bdelete\s+from\s+\w+\s*;?\s*$/i, // DELETE without WHERE
    />\s*\/dev\/sd[a-z]/i,
    /\bmkfs\b/i,
    /\bdd\s+if=/i,
  ];

  return dangerousPatterns.some((pattern) => pattern.test(command));
}

/**
 * 预设描述（用于 UI 展示）
 */
export const PRESET_DESCRIPTIONS: Record<PermissionPreset, { name: string; description: string }> = {
  strict: {
    name: '严格模式',
    description: '所有操作都需要用户确认，最安全但效率较低',
  },
  development: {
    name: '开发模式',
    description: '项目目录内的操作自动批准，平衡安全与效率',
  },
  ci: {
    name: 'CI 模式',
    description: '完全信任所有操作，仅用于自动化环境',
  },
  custom: {
    name: '自定义',
    description: '自定义权限规则',
  },
};
