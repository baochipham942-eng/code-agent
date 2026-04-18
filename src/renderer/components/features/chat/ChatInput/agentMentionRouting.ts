export interface MentionRoutingAgent {
  id: string;
  name: string;
}

export interface ParsedAgentMentionRouting {
  content: string;
  targetAgentIds: string[];
}

export interface AgentMentionAutocompleteResult {
  query: string;
  matches: MentionRoutingAgent[];
}

export function normalizeMentionToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildAgentAliasSet(agent: MentionRoutingAgent): Set<string> {
  const aliases = new Set<string>();
  const addAlias = (value: string) => {
    const normalized = normalizeMentionToken(value);
    if (!normalized) return;
    aliases.add(normalized);
    aliases.add(normalized.replace(/-/g, ''));
  };

  addAlias(agent.id);
  addAlias(agent.name);
  return aliases;
}

function resolveAgentByToken(
  token: string,
  agents: MentionRoutingAgent[],
): MentionRoutingAgent | null {
  const normalizedToken = normalizeMentionToken(token);
  if (!normalizedToken) return null;

  for (const agent of agents) {
    const aliases = buildAgentAliasSet(agent);
    if (aliases.has(normalizedToken)) {
      return agent;
    }
  }

  return null;
}

function isLeadingMentionPrefix(prefix: string): boolean {
  return /^(?:@[A-Za-z0-9._-]+\s+)*$/.test(prefix);
}

function getTrailingMentionQuery(value: string): string | null {
  const trimmedStart = value.replace(/^\s+/, '');
  if (!trimmedStart.startsWith('@')) {
    return null;
  }

  const trailingMentionMatch = trimmedStart.match(/(?:^|\s)@([A-Za-z0-9._-]*)$/);
  if (!trailingMentionMatch) {
    return null;
  }

  const mentionText = trailingMentionMatch[0].trimStart();
  const prefix = trimmedStart.slice(0, trimmedStart.length - mentionText.length);
  if (!isLeadingMentionPrefix(prefix)) {
    return null;
  }

  return trailingMentionMatch[1] || '';
}

export function getPreferredAgentMentionToken(agent: MentionRoutingAgent): string {
  return normalizeMentionToken(agent.name) || normalizeMentionToken(agent.id);
}

function formatAgentList(agents: MentionRoutingAgent[]): string {
  return agents.map((agent) => agent.name).join('、');
}

export function buildDirectRoutingHint(
  selectedAgents: MentionRoutingAgent[],
  availableAgents: MentionRoutingAgent[],
): string {
  if (selectedAgents.length > 0) {
    if (selectedAgents.length === 1) {
      const target = selectedAgents[0]!;
      return `这条消息会发给 ${target.name}，也可以直接输入 @${getPreferredAgentMentionToken(target)} ...`;
    }
    return `这条消息会发给 ${formatAgentList(selectedAgents)}，也可以继续输入 @agent 调整目标。`;
  }

  const sampleAgent = availableAgents[0];
  if (sampleAgent) {
    return `Direct 模式：点上面的 agent，或直接输入 @${getPreferredAgentMentionToken(sampleAgent)} 开始。`;
  }

  return 'Direct 模式：先点上面的 agent，或直接输入 @agent 开始。';
}

export function buildDirectRoutingPlaceholder(
  selectedAgents: MentionRoutingAgent[],
  availableAgents: MentionRoutingAgent[],
): string {
  if (selectedAgents.length > 0) {
    if (selectedAgents.length === 1) {
      const target = selectedAgents[0]!;
      return `发给 ${target.name}，或直接写 @${getPreferredAgentMentionToken(target)} ...`;
    }
    return `发给 ${selectedAgents.length} 个 agent，或继续写 @agent ...`;
  }

  const sampleAgent = availableAgents[0];
  if (sampleAgent) {
    return `Direct 模式：输入 @${getPreferredAgentMentionToken(sampleAgent)} 开始`;
  }

  return 'Direct 模式：输入 @agent 开始';
}

export function syncLeadingAgentMentions(
  value: string,
  selectedAgents: MentionRoutingAgent[],
  availableAgents: MentionRoutingAgent[],
): string {
  const parsed = parseLeadingAgentMentions(value, availableAgents);
  const content = parsed ? parsed.content : value.trim();

  if (selectedAgents.length === 0) {
    return content;
  }

  const mentionPrefix = selectedAgents
    .map((agent) => `@${getPreferredAgentMentionToken(agent)}`)
    .join(' ');

  return content ? `${mentionPrefix} ${content}` : `${mentionPrefix} `;
}

export function getLeadingAgentMentionAutocomplete(
  value: string,
  agents: MentionRoutingAgent[],
): AgentMentionAutocompleteResult | null {
  const query = getTrailingMentionQuery(value);
  if (query === null) {
    return null;
  }

  const normalizedQuery = normalizeMentionToken(query);
  const matches = agents.filter((agent) => {
    const aliases = buildAgentAliasSet(agent);
    if (!normalizedQuery) {
      return aliases.size > 0;
    }
    return Array.from(aliases).some((alias) => alias.startsWith(normalizedQuery));
  });

  if (matches.length === 0) {
    return null;
  }

  return {
    query,
    matches,
  };
}

export function applyAgentMentionSuggestion(
  value: string,
  agent: MentionRoutingAgent,
): string {
  const query = getTrailingMentionQuery(value);
  if (query === null) {
    return value;
  }

  const mentionText = `@${query}`;
  const replaceStart = value.length - mentionText.length;
  const nextMention = `@${getPreferredAgentMentionToken(agent)}`;
  return `${value.slice(0, replaceStart)}${nextMention} `;
}

export function parseLeadingAgentMentions(
  content: string,
  agents: MentionRoutingAgent[],
): ParsedAgentMentionRouting | null {
  const trimmedStart = content.replace(/^\s+/, '');
  if (!trimmedStart.startsWith('@')) {
    return null;
  }

  const resolvedAgents: MentionRoutingAgent[] = [];
  let cursor = 0;

  while (cursor < trimmedStart.length) {
    const mentionMatch = trimmedStart.slice(cursor).match(/^@([A-Za-z0-9._-]+)(?=\s|$)/);
    if (!mentionMatch) break;

    const agent = resolveAgentByToken(mentionMatch[1], agents);
    if (!agent) {
      break;
    }

    resolvedAgents.push(agent);
    cursor += mentionMatch[0].length;

    const whitespaceMatch = trimmedStart.slice(cursor).match(/^\s+/);
    if (!whitespaceMatch) {
      break;
    }
    cursor += whitespaceMatch[0].length;
  }

  if (resolvedAgents.length === 0) {
    return null;
  }

  const targetAgentIds = Array.from(new Set(resolvedAgents.map((agent) => agent.id)));
  const strippedContent = trimmedStart.slice(cursor).trim();

  return {
    content: strippedContent,
    targetAgentIds,
  };
}

export function isLeadingAgentMentionInput(
  value: string,
  agents: MentionRoutingAgent[],
): boolean {
  return getLeadingAgentMentionAutocomplete(value, agents) !== null;
}
