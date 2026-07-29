import { isPanelVisibleAgent, type AgentListEntry } from '@shared/contract/agentRegistry';

export interface AgentCommandOption {
  id: string | null;
  name: string;
  description: string;
  token: string;
  /** 面板分组：内置/自建 agent 在前，角色（roles）折叠成独立组在后 */
  group: 'agent' | 'role';
  /** 职业（如「内容主理人」）：跟在花名后，让用户知道这个专家是干什么的 */
  profession?: string;
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

// 2026-07-29 起面板不再提供「Default / 恢复自动路由」项：去掉专家 chip 就是默认，
// 交互层不需要显式恢复入口。'/agent default' 文本命令的解析（RESET_TOKENS）保留作 CLI 兼容。
export function getAgentCommandOptions(
  agents: AgentListEntry[],
  query = '',
): AgentCommandOption[] {
  const normalizedQuery = normalizeToken(query);
  const visible = agents.filter(isPanelVisibleAgent);
  const toOption = (agent: AgentListEntry): AgentCommandOption => ({
    id: agent.id,
    name: agent.name || agent.id,
    description: agent.description,
    token: getAgentCommandToken(agent),
    group: agent.isRole ? 'role' : 'agent',
    profession: agent.profession,
  });
  const agentOptions = visible.filter((a) => !a.isRole).map(toOption);
  const roleOptions = visible.filter((a) => a.isRole).map(toOption);
  const options = [...agentOptions, ...roleOptions];
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

/**
 * 清掉行首的 /agent 触发文本（连同已输入的 query token 和尾空格），保留其后正文草稿。
 * 二级面板选中后 chip 立即生效，触发文本不再留作路由前缀。
 * removeTrailingSlashToken 只认末尾 /token，覆盖不了 '/agent d'、'/agent ' 这些场景，故单列。
 */
export function removeLeadingAgentCommandTrigger(value: string): string {
  const match = /^\s*\/agent(?:\s+[^\s]*)?\s*/i.exec(value);
  if (!match) return value;
  return value.slice(match[0].length);
}
