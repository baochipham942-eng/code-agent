import { describe, expect, it } from 'vitest';
import React from 'react';
import {
  buildSlashCommandGroups,
  orderSlashCommandsForDisplay,
} from '../../../src/renderer/components/features/chat/ChatInput/SlashCommandPopover';

type SlashCommandFixture = Parameters<typeof buildSlashCommandGroups>[0][number];

function command(id: string, group: SlashCommandFixture['group'], label = id): SlashCommandFixture {
  return {
    id,
    label,
    group,
    description: `${label} command`,
    icon: React.createElement('span'),
    action: () => {},
  };
}

describe('SlashCommandPopover helpers', () => {
  it('groups slash commands by supported command/function type', () => {
    const groups = buildSlashCommandGroups([
      command('new', 'session', '新建会话'),
      command('mcp', 'tools', 'MCP'),
      command('inspect', 'prompt_file', 'Inspect'),
      command('summarize', 'prompt_mcp', 'Summarize'),
    ]);

    expect(groups.map((group) => ({
      id: group.id,
      label: group.label,
      commands: group.commands.map((item) => item.id),
    }))).toEqual([
      { id: 'session', label: '会话', commands: ['new'] },
      { id: 'tools', label: '工具与能力', commands: ['mcp'] },
      { id: 'prompt_file', label: '自定义命令', commands: ['inspect'] },
      { id: 'prompt_mcp', label: 'MCP Prompts', commands: ['summarize'] },
    ]);
  });

  it('keeps exact matches first without breaking grouped visual order', () => {
    const ordered = orderSlashCommandsForDisplay([
      command('workflow', 'agent', 'Workflow'),
      command('low', 'mode', 'Low'),
      command('code', 'mode', 'Code'),
      command('mcp', 'tools', 'MCP'),
    ], {
      preferredGroup: 'mode',
      exactId: 'low',
    });

    expect(ordered.map((item) => item.id)).toEqual(['low', 'code', 'workflow', 'mcp']);
    expect(buildSlashCommandGroups(ordered).map((group) => group.id)).toEqual(['mode', 'agent', 'tools']);
  });
});
