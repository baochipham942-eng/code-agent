import { describe, expect, it } from 'vitest';
import {
  findAgentForCommandToken,
  getAgentCommandOptions,
  parseAgentSlashCommand,
  removeLeadingAgentCommandTrigger,
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
    const customAgents: AgentListEntry[] = [
      { id: 'review-assistant', name: 'Review Assistant', description: 'Reviews code quality.', source: 'user', modelTier: 'balanced', readonly: true, tools: [] },
      ...agents,
    ];
    const options = getAgentCommandOptions(customAgents, 'rev');

    // 传统内置 reviewer 已被面板过滤，只有自建 agent 命中
    expect(options).toHaveLength(1);
    expect(options[0]!.token).toBe('review-assistant');
  });

  it('removeLeadingAgentCommandTrigger 清掉 /agent 触发文本（含 query 与尾空格）', () => {
    expect(removeLeadingAgentCommandTrigger('/agent')).toBe('');
    expect(removeLeadingAgentCommandTrigger('/agent ')).toBe('');
    expect(removeLeadingAgentCommandTrigger('/agent d')).toBe('');
    expect(removeLeadingAgentCommandTrigger('/agent reviewer ')).toBe('');
    // 触发文本之后的正文草稿保留
    expect(removeLeadingAgentCommandTrigger('/agent reviewer 继续干')).toBe('继续干');
    // 非 /agent 开头的输入原样返回
    expect(removeLeadingAgentCommandTrigger('帮我看看')).toBe('帮我看看');
    expect(removeLeadingAgentCommandTrigger('/compact')).toBe('/compact');
  });

  it('面板收敛：系统型与传统内置不进 /agent 面板，自建/专家可见', () => {
    const withSystem: AgentListEntry[] = [
      ...agents,
      { id: 'coder', name: 'Coder', description: 'Writes', source: 'builtin', modelTier: 'balanced', readonly: false, tools: [] },
      { id: 'reviewer', name: 'Reviewer', description: 'Reviews', source: 'builtin', modelTier: 'balanced', readonly: true, tools: [] },
      { id: 'explore', name: 'Explorer', description: 'Explores', source: 'builtin', modelTier: 'fast', readonly: true, tools: [] },
      { id: 'plan', name: 'Planner', description: 'Plans', source: 'builtin', modelTier: 'balanced', readonly: true, tools: [] },
      { id: 'awaiter', name: 'Awaiter', description: 'Monitors', source: 'builtin', modelTier: 'fast', readonly: false, tools: [] },
      { id: 'dream', name: 'Dream', description: 'Review', source: 'builtin', modelTier: 'balanced', readonly: false, tools: [] },
      { id: 'distill', name: 'Distill', description: 'Distill', source: 'builtin', modelTier: 'balanced', readonly: false, tools: [] },
      { id: 'review-assistant', name: 'Review 助手', description: '自建', source: 'user', modelTier: 'balanced', readonly: true, tools: [] },
    ];
    const options = getAgentCommandOptions(withSystem);
    const ids = options.map((o) => o.id);
    for (const hidden of ['coder', 'reviewer', 'explore', 'plan', 'awaiter', 'dream', 'distill']) {
      expect(ids).not.toContain(hidden);
    }
    // 自建 agent / 专家照常可选
    expect(ids).toContain('review-assistant');
  });

  it('roles 与 agent 分组：isRole 条目归入 role 组且排在 agent 组之后', () => {
    const withRole: AgentListEntry[] = [
      { id: '数据处理看板周报专家', name: '数据处理看板周报专家', description: '角色', source: 'user', modelTier: 'balanced', readonly: false, tools: [], isRole: true },
      { id: 'review-assistant', name: 'Review Assistant', description: '自建', source: 'user', modelTier: 'balanced', readonly: true, tools: [] },
      ...agents,
    ];
    const options = getAgentCommandOptions(withRole);
    // 2026-07-29 起面板无 Default 项：首项就是第一个可选 agent
    expect(options.every((o) => o.id !== null)).toBe(true);
    expect(options[0]!.id).toBe('review-assistant');
    expect(options[0]!.group).toBe('agent');
    const groups = options.map((o) => o.group);
    expect(groups.lastIndexOf('agent')).toBeLessThan(groups.indexOf('role'));
    expect(options.find((o) => o.id === '数据处理看板周报专家')?.group).toBe('role');
  });

  it('/agent default 文本命令仍按「恢复自动路由」解析（CLI 兼容，面板无此项）', () => {
    expect(parseAgentSlashCommand('/agent default', agents)).toEqual({ kind: 'clear', content: '' });
  });
});
