// ============================================================================
// SlashCommandDisplayGroups - 命令面板分组显示模型
// 从 SlashCommandPopover.tsx 纯平移（god-file 债务门贴边 1000 行）。
// 注意：当前生产渲染走 slashPickerModel 的 groupSlashCandidates，
// 本模块仅被 tests/renderer/components/slashCommandPopover.test.ts 消费。
// ============================================================================

import type { ReactNode } from 'react';

export type SlashCommandDisplayGroupId =
  | 'session'
  | 'tools'
  | 'prompt_file'
  | 'prompt_mcp'
  | 'mode'
  | 'agent'
  | 'model'
  | 'context'
  | 'status'
  | 'ui'
  | 'system';

export interface SlashCommandDisplayItem {
  id: string;
  label: string;
  description: string;
  icon: ReactNode;
  group: SlashCommandDisplayGroupId;
  sourceLabel?: string;
  shortcut?: string;
  action: () => void;
}

export interface SlashCommandGroup<T extends SlashCommandDisplayItem = SlashCommandDisplayItem> {
  id: SlashCommandDisplayGroupId;
  label: string;
  description: string;
  commands: T[];
}

const SLASH_COMMAND_GROUP_ORDER: SlashCommandDisplayGroupId[] = [
  'session',
  'agent',
  'tools',
  'prompt_file',
  'prompt_mcp',
  'mode',
  'model',
  'context',
  'status',
  'ui',
  'system',
];

const SLASH_COMMAND_GROUP_META: Record<SlashCommandDisplayGroupId, Omit<SlashCommandGroup, 'id' | 'commands'>> = {
  session: { label: '会话', description: '创建、清理、归档和恢复会话' },
  agent: { label: 'Agent 与编排', description: '选择 Agent、创建角色、设定目标和工作流' },
  tools: { label: '工具与能力', description: 'Skills、MCP、Connectors、Plugins 等能力面' },
  prompt_file: { label: '自定义命令', description: '用户、项目和插件安装的文件式 prompt command' },
  prompt_mcp: { label: 'MCP Prompts', description: '来自 MCP server 的 prompt 命令' },
  mode: { label: '模式与权限', description: '交互模式、推理强度和权限模式' },
  model: { label: '模型', description: '查看或切换模型配置' },
  context: { label: '上下文', description: '查看和管理上下文窗口' },
  status: { label: '状态与诊断', description: '状态、成本、Hooks、权限和诊断信息' },
  ui: { label: '界面', description: '打开设置、工作区、DAG 和侧边栏' },
  system: { label: '系统', description: '帮助、配置和系统命令' },
};

export function buildSlashCommandGroups<T extends SlashCommandDisplayItem>(commands: T[]): Array<SlashCommandGroup<T>> {
  const grouped = new Map<SlashCommandDisplayGroupId, T[]>();
  const groupOrder: SlashCommandDisplayGroupId[] = [];
  for (const command of commands) {
    if (!grouped.has(command.group)) {
      groupOrder.push(command.group);
    }
    const existing = grouped.get(command.group) ?? [];
    existing.push(command);
    grouped.set(command.group, existing);
  }

  return groupOrder
    .map((id) => ({
      id,
      ...SLASH_COMMAND_GROUP_META[id],
      commands: grouped.get(id) ?? [],
    } as SlashCommandGroup<T>));
}

function getSlashCommandGroupRank(
  group: SlashCommandDisplayGroupId,
  preferredGroup?: SlashCommandDisplayGroupId,
): number {
  if (preferredGroup && group === preferredGroup) {
    return -1;
  }
  const index = SLASH_COMMAND_GROUP_ORDER.indexOf(group);
  return index === -1 ? SLASH_COMMAND_GROUP_ORDER.length : index;
}

export function orderSlashCommandsForDisplay<T extends SlashCommandDisplayItem>(
  commands: T[],
  options: { preferredGroup?: SlashCommandDisplayGroupId; exactId?: string } = {},
): T[] {
  return [...commands].sort((a, b) => {
    const rankDelta = getSlashCommandGroupRank(a.group, options.preferredGroup) - getSlashCommandGroupRank(b.group, options.preferredGroup);
    if (rankDelta !== 0) return rankDelta;
    if (options.exactId) {
      const aExact = a.id.toLowerCase() === options.exactId ? 0 : 1;
      const bExact = b.id.toLowerCase() === options.exactId ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
    }
    return a.label.localeCompare(b.label, 'zh-CN');
  });
}
