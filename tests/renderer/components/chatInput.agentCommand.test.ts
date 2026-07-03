import { describe, expect, it } from 'vitest';
import {
  applyAgentCommandOption,
  findAgentForCommandToken,
  getAgentCommandOptions,
  parseAgentSlashCommand,
} from '../../../src/renderer/components/features/chat/ChatInput/agentCommand';
import type { AgentListEntry } from '../../../src/shared/contract/agentRegistry';

const agents: AgentListEntry[] = [
  {
    id: 'coder',
    name: 'Coder',
    description: 'Writes and debugs code.',
    source: 'builtin',
    modelTier: 'balanced',
    readonly: false,
    tools: [],
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews code quality.',
    source: 'builtin',
    modelTier: 'balanced',
    readonly: true,
    tools: [],
  },
];

describe('/agent command helpers', () => {
  it('parses an agent override and strips the command from message content', () => {
    expect(parseAgentSlashCommand('/agent reviewer 看一下风险', agents)).toEqual({
      kind: 'select',
      agent: agents[1],
      content: '看一下风险',
    });
  });

  it('parses reset aliases as clearing the selected agent', () => {
    expect(parseAgentSlashCommand('/agent default 继续自动判断', agents)).toEqual({
      kind: 'clear',
      content: '继续自动判断',
    });
  });

  it('matches agent names case-insensitively', () => {
    expect(findAgentForCommandToken('Coder', agents)?.id).toBe('coder');
  });

  it('builds compact options without a search input', () => {
    const options = getAgentCommandOptions(agents, 'rev');

    expect(options).toHaveLength(1);
    expect(applyAgentCommandOption(options[0]!)).toBe('/agent reviewer ');
  });

  it('面板收敛：系统型内置（awaiter/dream/distill）不进 /agent 面板', () => {
    const withSystem: AgentListEntry[] = [
      ...agents,
      { id: 'awaiter', name: 'Awaiter', description: 'Monitors', source: 'builtin', modelTier: 'fast', readonly: false, tools: [] },
      { id: 'dream', name: 'Dream', description: 'Review', source: 'builtin', modelTier: 'balanced', readonly: false, tools: [] },
      { id: 'distill', name: 'Distill', description: 'Distill', source: 'builtin', modelTier: 'balanced', readonly: false, tools: [] },
    ];
    const options = getAgentCommandOptions(withSystem);
    const ids = options.map((o) => o.id);
    expect(ids).not.toContain('awaiter');
    expect(ids).not.toContain('dream');
    expect(ids).not.toContain('distill');
    expect(ids).toContain('coder');
  });

  it('roles 与 agent 分组：isRole 条目归入 role 组且排在 agent 组之后', () => {
    const withRole: AgentListEntry[] = [
      { id: '数据处理看板周报专家', name: '数据处理看板周报专家', description: '角色', source: 'user', modelTier: 'balanced', readonly: false, tools: [], isRole: true },
      ...agents,
    ];
    const options = getAgentCommandOptions(withRole);
    expect(options[0]!.id).toBeNull();
    expect(options[0]!.group).toBe('agent');
    const groups = options.map((o) => o.group);
    expect(groups.lastIndexOf('agent')).toBeLessThan(groups.indexOf('role'));
    expect(options.find((o) => o.id === '数据处理看板周报专家')?.group).toBe('role');
  });

  it('Default 项文案可由调用方注入（i18n）', () => {
    const options = getAgentCommandOptions(agents, '', {
      defaultName: 'Default',
      defaultDescription: 'Resume auto routing',
    });
    expect(options[0]!.description).toBe('Resume auto routing');
  });
});
