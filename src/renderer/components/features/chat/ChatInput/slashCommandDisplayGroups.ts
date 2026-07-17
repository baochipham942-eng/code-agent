// ============================================================================
// SlashCommandDisplayGroups - 命令面板分组显示模型
// 从 SlashCommandPopover.tsx 纯平移（god-file 债务门贴边 1000 行）。
// 注意：当前生产渲染走 slashPickerModel 的 groupSlashCandidates，
// 本模块仅被 tests/renderer/components/slashCommandPopover.test.ts 消费。
// ============================================================================

import type { ReactNode } from 'react';
import { zh } from '../../../../i18n/zh';

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

const SLASH_COMMAND_GROUP_META: Record<SlashCommandDisplayGroupId, Omit<SlashCommandGroup, 'id' | 'commands'>> = zh.slashCommandGroups;

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
