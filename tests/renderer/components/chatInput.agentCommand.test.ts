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
});
