import type { AgentListEntry } from '../../../../shared/contract/agentRegistry';

const DESCRIPTION_LIMIT = 100;

type AgentLister = () => readonly AgentListEntry[];

function registryGlobal(): { listAllAgents?: AgentLister } | undefined {
  return (globalThis as typeof globalThis & {
    codeAgentAgentRegistry?: { listAllAgents?: AgentLister };
  }).codeAgentAgentRegistry;
}

function defaultListAgents(): readonly AgentListEntry[] {
  // Keep schema modules lightweight at import time. Some runtime tests mock
  // low-level constants before loading tool schemas; pulling agentRegistry
  // eagerly would force coreAgents through those mocks.
  // 只走 agentRegistry 模块加载时注册的进程内 provider——不要在这里 require/import
  // registry：CJS bundle 里 import.meta.url 是 undefined，顶层 createRequire 会让
  // webServer 加载即炸（PR#417 CI 实锤）。拿不到 provider 就回静态描述。
  return registryGlobal()?.listAllAgents?.() ?? [];
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, limit = DESCRIPTION_LIMIT): string {
  const normalized = normalizeText(value);
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function nonEmptyList(value: readonly string[] | undefined): string[] | undefined {
  if (!value || value.length === 0) return undefined;
  const items = value.map(normalizeText).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function renderIoContract(agent: Pick<AgentListEntry, 'inputs' | 'outputs'>): string {
  const parts: string[] = [];
  const inputs = nonEmptyList(agent.inputs);
  const outputs = nonEmptyList(agent.outputs);
  if (inputs) parts.push(`inputs: ${inputs.join(', ')}`);
  if (outputs) parts.push(`outputs: ${outputs.join(', ')}`);
  return parts.length > 0 ? ` (${parts.join('; ')})` : '';
}

function renderAgentCatalogLines(agents: readonly AgentListEntry[]): string[] {
  return agents.map((agent) => {
    const description = truncateText(agent.description || `Agent ${agent.id}`);
    return `- ${agent.id}: ${description}${renderIoContract(agent)}`;
  });
}

export function renderAgentCatalogSection(
  fallback: string,
  listAgents: AgentLister = defaultListAgents,
): string {
  try {
    const agents = listAgents();
    if (agents.length === 0) return fallback;
    return `Available agent types:\n${renderAgentCatalogLines(agents).join('\n')}`;
  } catch {
    return fallback;
  }
}

export function renderAgentRoleDescription(
  fallback: string,
  listAgents: AgentLister = defaultListAgents,
): string {
  const section = renderAgentCatalogSection(fallback, listAgents);
  return section === fallback ? fallback : `Agent type to use. ${section}`;
}
