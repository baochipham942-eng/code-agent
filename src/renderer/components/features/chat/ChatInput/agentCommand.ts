import type { AgentListEntry } from '@shared/contract/agentRegistry';

export interface AgentCommandOption {
  id: string | null;
  name: string;
  description: string;
  token: string;
}

export type AgentCommandParseResult =
  | { kind: 'none' }
  | { kind: 'prompt'; query: string }
  | { kind: 'unknown'; token: string }
  | { kind: 'clear'; content: string }
  | { kind: 'select'; agent: AgentListEntry; content: string };

const RESET_TOKENS = new Set(['default', 'auto', 'reset', 'none']);

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, '').replace(/\s+/g, '-');
}

export function getAgentCommandToken(agent: Pick<AgentListEntry, 'id' | 'name'>): string {
  return normalizeToken(agent.name || agent.id) || agent.id;
}

export function getAgentCommandOptions(
  agents: AgentListEntry[],
  query = '',
): AgentCommandOption[] {
  const normalizedQuery = normalizeToken(query);
  const defaultOption: AgentCommandOption = {
    id: null,
    name: 'Default',
    description: '恢复自动路由',
    token: 'default',
  };
  const agentOptions = agents.map((agent) => ({
    id: agent.id,
    name: agent.name || agent.id,
    description: agent.description,
    token: getAgentCommandToken(agent),
  }));
  const options = [defaultOption, ...agentOptions];
  if (!normalizedQuery) return options;
  return options.filter((option) => {
    const haystack = [
      option.id || '',
      option.name,
      option.description,
      option.token,
    ].join(' ').toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

export function findAgentForCommandToken(
  token: string,
  agents: AgentListEntry[],
): AgentListEntry | null {
  const normalized = normalizeToken(token);
  return agents.find((agent) => {
    const candidates = [
      agent.id,
      agent.name,
      getAgentCommandToken(agent),
    ].map(normalizeToken);
    return candidates.includes(normalized);
  }) ?? null;
}

export function parseAgentSlashCommand(
  value: string,
  agents: AgentListEntry[],
): AgentCommandParseResult {
  const trimmed = value.trim();
  if (!/^\/agent(?:\s|$)/i.test(trimmed)) {
    return { kind: 'none' };
  }

  const afterCommand = trimmed.slice('/agent'.length).trim();
  if (!afterCommand) {
    return { kind: 'prompt', query: '' };
  }

  const [rawToken = '', ...contentParts] = afterCommand.split(/\s+/);
  const token = normalizeToken(rawToken);
  const content = contentParts.join(' ').trim();

  if (RESET_TOKENS.has(token)) {
    return { kind: 'clear', content };
  }

  const agent = findAgentForCommandToken(rawToken, agents);
  if (!agent) {
    return { kind: 'unknown', token: rawToken };
  }

  return { kind: 'select', agent, content };
}

export function getAgentSlashCommandQuery(value: string): string | null {
  const lower = value.toLowerCase();
  if (!lower.startsWith('/agent ')) return null;
  const afterCommand = value.slice('/agent'.length).trimStart();
  const [token = '', ...rest] = afterCommand.split(/\s+/);
  return rest.length > 0 ? null : token;
}

export function applyAgentCommandOption(option: AgentCommandOption): string {
  return `/agent ${option.token} `;
}
