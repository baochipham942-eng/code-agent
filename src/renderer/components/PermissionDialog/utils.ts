// ============================================================================
// PermissionDialog - Utility Functions
// ============================================================================

import React from 'react';
import {
  FileText,
  FileEdit,
  FilePlus,
  Trash2,
  Terminal,
  Globe,
  MessageSquare,
  AlertTriangle,
} from 'lucide-react';
import type { PermissionType, PermissionConfig } from './types';

// 权限配置映射
export function getPermissionConfig(type: PermissionType): PermissionConfig {
  const configs: Record<PermissionType, PermissionConfig> = {
    file_read: {
      icon: React.createElement(FileText, { size: 20 }),
      title: '读取文件',
      color: 'text-blue-400',
      bgColor: 'bg-blue-500/10',
      borderColor: 'border-blue-500/30',
    },
    file_write: {
      icon: React.createElement(FilePlus, { size: 20 }),
      title: '创建文件',
      color: 'text-green-400',
      bgColor: 'bg-green-500/10',
      borderColor: 'border-green-500/30',
    },
    file_edit: {
      icon: React.createElement(FileEdit, { size: 20 }),
      title: '编辑文件',
      color: 'text-yellow-400',
      bgColor: 'bg-yellow-500/10',
      borderColor: 'border-yellow-500/30',
    },
    file_delete: {
      icon: React.createElement(Trash2, { size: 20 }),
      title: '删除文件',
      color: 'text-red-400',
      bgColor: 'bg-red-500/10',
      borderColor: 'border-red-500/30',
    },
    command: {
      icon: React.createElement(Terminal, { size: 20 }),
      title: '执行命令',
      color: 'text-purple-400',
      bgColor: 'bg-purple-500/10',
      borderColor: 'border-purple-500/30',
    },
    dangerous_command: {
      icon: React.createElement(AlertTriangle, { size: 20 }),
      title: '危险命令',
      color: 'text-red-400',
      bgColor: 'bg-red-500/10',
      borderColor: 'border-red-500/30',
    },
    network: {
      icon: React.createElement(Globe, { size: 20 }),
      title: '网络请求',
      color: 'text-cyan-400',
      bgColor: 'bg-cyan-500/10',
      borderColor: 'border-cyan-500/30',
    },
    mcp: {
      icon: React.createElement(MessageSquare, { size: 20 }),
      title: 'MCP 工具',
      color: 'text-indigo-400',
      bgColor: 'bg-indigo-500/10',
      borderColor: 'border-indigo-500/30',
    },
  };

  return configs[type] || configs.command;
}

// 危险命令检测模式
const DANGEROUS_PATTERNS = [
  // 删除相关
  /rm\s+-rf/i,
  /rm\s+.*--no-preserve-root/i,
  /sudo\s+rm/i,
  /rm\s+-r\s+\/(?!\w)/i, // rm -r / 但不匹配 rm -r /path

  // 磁盘操作
  /mkfs/i,
  /dd\s+if=/i,
  />\s*\/dev\/sd/i,
  />\s*\/dev\/nvme/i,

  // 权限相关
  /chmod\s+777/i,
  /chmod\s+-R\s+777/i,
  /chown\s+-R\s+root/i,

  // 危险的 shell 模式
  /:(){:|:&};:/,  // fork bomb
  /\|\s*xargs\s+rm/i,

  // 网络下载执行
  /curl.*\|\s*(ba)?sh/i,
  /wget.*\|\s*(ba)?sh/i,
  /curl.*\|\s*python/i,
  /wget.*\|\s*python/i,

  // 系统文件修改
  />\s*\/etc\/passwd/i,
  />\s*\/etc\/shadow/i,
  />\s*\/etc\/sudoers/i,

  // 强制覆盖
  /mv\s+-f\s+.*\s+\/bin/i,
  /mv\s+-f\s+.*\s+\/usr/i,

  // 数据库危险操作
  /DROP\s+DATABASE/i,
  /DROP\s+TABLE/i,
  /TRUNCATE\s+TABLE/i,
  /DELETE\s+FROM\s+\w+\s*;?\s*$/i, // DELETE FROM table 无 WHERE
];

// 检测命令是否危险
export function isDangerousCommand(command?: string): boolean {
  if (!command) return false;
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

// 获取危险命令的原因描述
export function getDangerReason(command?: string): string | null {
  if (!command) return null;

  if (/rm\s+-rf|rm\s+-r/.test(command)) {
    return '递归删除文件，可能导致数据丢失';
  }
  if (/mkfs|dd\s+if=/.test(command)) {
    return '磁盘格式化/写入，可能破坏数据';
  }
  if (/chmod\s+777/.test(command)) {
    return '设置宽松权限，可能造成安全风险';
  }
  if (/curl.*\|.*sh|wget.*\|.*sh/.test(command)) {
    return '从网络下载并执行脚本，可能包含恶意代码';
  }
  if (/DROP\s+DATABASE|DROP\s+TABLE/i.test(command)) {
    return '删除数据库/表，数据将永久丢失';
  }

  return '此命令可能对系统造成不可逆的影响';
}

// 格式化文件路径（缩短显示）
export function formatFilePath(path: string, maxLength = 60): string {
  if (path.length <= maxLength) return path;

  const parts = path.split('/');
  if (parts.length <= 3) return path;

  // 保留前两部分和最后两部分
  const start = parts.slice(0, 2).join('/');
  const end = parts.slice(-2).join('/');

  return `${start}/.../${end}`;
}

// 解析命令获取基础命令名
export function getBaseCommand(command?: string): string {
  if (!command) return '';

  // 去除 sudo 前缀
  const withoutSudo = command.replace(/^sudo\s+/, '');

  // 获取第一个命令（处理管道）
  const firstCommand = withoutSudo.split('|')[0].trim();

  // 获取基础命令名
  const parts = firstCommand.split(/\s+/);
  return parts[0] || '';
}
