// ============================================================================
// Ink TUI 权限审批卡的数据逻辑（纯函数，无 Ink 依赖，可单测）
// 规格：docs/design/2026-08-29-ink-tui-grok-interaction-spec.md「权限确认」节
// ============================================================================

import type { PermissionRequestData } from '../../host/tools/types';

/** 审批卡选项（1-3 直选 + ↑↓+Enter） */
export type ApprovalChoice = 'once' | 'reject' | 'always';

export interface ApprovalOption {
  choice: ApprovalChoice;
  /** 显示文案（含 always 的目标） */
  label: string;
}

/**
 * "Always allow" 的授权 key：命令类取首 token（npm/git/…），其余取工具名。
 * 会话级内存集合，不持久化（规格 P4 范围）。
 */
export function approvalKey(request: PermissionRequestData): string {
  if ((request.type === 'command' || request.type === 'dangerous_command') && request.details?.command) {
    const command = String(request.details.command).trim();
    const firstToken = command.split(/\s+/)[0] || command;
    return `bash:${firstToken}`;
  }
  return `tool:${request.tool}`;
}

/** 卡片上的目标摘要：bash 命令 / 文件路径 / URL（单行截断） */
export function approvalTarget(request: PermissionRequestData): string {
  const raw = String(
    request.details?.command
    || request.details?.path
    || request.details?.filePath
    || request.details?.url
    || request.tool,
  );
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 72 ? oneLine.slice(0, 69) + '...' : oneLine;
}

/** 卡片选项组合：Allow once / No, reject / Always allow: <前缀或工具> */
export function approvalOptions(request: PermissionRequestData): ApprovalOption[] {
  const key = approvalKey(request);
  const alwaysTarget = key.startsWith('bash:') ? key.slice('bash:'.length) : request.tool;
  return [
    { choice: 'once', label: 'Allow once' },
    { choice: 'reject', label: 'No, reject' },
    { choice: 'always', label: `Always allow: ${alwaysTarget}` },
  ];
}

/** 会话级放行集合（always 选择写入；会话内存即可，不持久化） */
export class SessionAllowList {
  private readonly keys = new Set<string>();

  has(request: PermissionRequestData): boolean {
    return this.keys.has(approvalKey(request));
  }

  add(request: PermissionRequestData): void {
    this.keys.add(approvalKey(request));
  }

  get size(): number {
    return this.keys.size;
  }
}
