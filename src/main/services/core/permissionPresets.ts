// ============================================================================
// Permission Presets - 权限预设配置
// ============================================================================

import type { PermissionLevel } from '@shared/types';

/**
 * 预设类型
 * - strict: 最严格，所有操作需确认
 * - development: 开发模式，项目目录内自动批准
 * - ci: CI 环境，完全信任
 * - custom: 用户自定义
 */
export type PermissionPreset = 'strict' | 'development' | 'ci' | 'custom';

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
   * - 网络操作需要确认
   * - 危险命令需要二次确认
   */
  development: {
    autoApprove: {
      read: true,
      write: false, // 通过 trustProjectDirectory 控制
      execute: false, // 通过 trustProjectDirectory 控制
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
    ],
    trustProjectDirectory: true,
    trustedDirectories: [], // 运行时根据工作目录填充
    confirmDangerousCommands: true,
  },

  /**
   * CI 模式 - 完全信任
   * - 所有操作自动批准
   * - 无阻止命令（CI 环境由 pipeline 控制）
   * - 用于自动化测试和部署
   *
   * 警告：仅在受控的 CI 环境中使用
   */
  ci: {
    autoApprove: {
      read: true,
      write: true,
      execute: true,
      network: true,
    },
    blockedCommands: [], // CI 环境由 pipeline 权限控制
    trustProjectDirectory: true,
    trustedDirectories: [], // CI 中通常整个 workspace 都可信
    confirmDangerousCommands: false,
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
export function isPathTrusted(path: string, trustedDirectories: string[]): boolean {
  if (!path || trustedDirectories.length === 0) {
    return false;
  }

  // 规范化路径（移除尾部斜杠）
  const normalizedPath = path.replace(/\/+$/, '');

  return trustedDirectories.some((dir) => {
    const normalizedDir = dir.replace(/\/+$/, '');
    // 路径必须完全匹配或是子目录
    return normalizedPath === normalizedDir || normalizedPath.startsWith(normalizedDir + '/');
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
    /\brm\s+(-[rf]+\s+)*[\/~]/i, // rm with paths
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
