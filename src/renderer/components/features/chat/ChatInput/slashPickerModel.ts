import type { AgentListEntry } from '@shared/contract/agentRegistry';
import type { ParsedSkill } from '@shared/contract/agentSkill';
import type { SessionSkillMount } from '@shared/contract/skillRepository';
import type { WorkbenchCapabilityRegistryItem } from '../../../../utils/workbenchCapabilityRegistry';
import { getAgentCommandOptions } from './agentCommand';
import { zh } from '../../../../i18n/zh';

export type SlashCandidateKind = 'command' | 'prompt' | 'agent' | 'skill' | 'connector' | 'mcp';

export type SlashCandidateGroup = 'suggested' | 'command' | 'prompt' | 'agent' | 'skill' | 'connector' | 'mcp';

export type SlashCandidateAction =
  | 'execute'
  | 'prefill-leading-command'
  | 'select-agent'
  | 'prefill-prompt'
  | 'select-skill'
  | 'select-connector'
  | 'select-mcp'
  | 'open-agent-command'
  | 'create-role';

export interface SlashTokenMatch {
  query: string;
  start: number;
  end: number;
  baseInput: string;
}

export interface PromptCommandCandidateInput {
  name: string;
  description?: string;
  source: 'file' | 'mcp' | 'builtin';
  hints: string[];
  scope?: 'user' | 'project';
  serverName?: string;
  contentPreview?: string;
  contentSearchText?: string;
}

export interface RecommendedSkillCandidateInput {
  skillName: string;
  libraryId: string;
  reason: string;
  action?: 'mount' | 'install';
  displayName?: string;
  repoId?: string;
}

export interface SlashPickerCandidate {
  id: string;
  kind: SlashCandidateKind;
  group: SlashCandidateGroup;
  actionKind: SlashCandidateAction;
  label: string;
  description: string;
  slashText: string;
  searchText: string;
  effectLabel: string;
  shortcut?: string;
  source?: string;
  emptyQueryVisible?: boolean;
  emptyQueryRank?: number;
  suggested?: boolean;
  commandId?: string;
  promptName?: string;
  promptSource?: PromptCommandCandidateInput['source'];
  promptHints?: string[];
  promptScope?: PromptCommandCandidateInput['scope'];
  promptServerName?: string;
  promptContentPreview?: string;
  agentToken?: string;
  agentId?: string | null;
  skillName?: string;
  skillLibraryId?: string;
  skillMounted?: boolean;
  skillSelected?: boolean;
  skillRecommendationAction?: RecommendedSkillCandidateInput['action'];
  skillRecommendationRepoId?: string;
  connectorId?: string;
  connectorConnected?: boolean;
  mcpServerId?: string;
  mcpConnected?: boolean;
}

export interface SlashPickerCandidateGroup<T extends SlashPickerCandidate = SlashPickerCandidate> {
  group: SlashCandidateGroup;
  label: string;
  items: T[];
}

/**
 * 候选装饰文案注入（同 agentCommand 的 AgentCommandOptionLabels 模式）：
 * 渲染层从 i18n 的 slashCommands.picker 传入；缺省回退中文保持既有行为。
 */
export interface SlashPickerLabels {
  prefillCommand?: string;
  executeNow?: string;
  builtinCommand?: string;
  paramsPrefix?: string;
  noParams?: string;
  mcpPromptFallback?: string;
  filePromptFallback?: string;
  prefillPromptWithArgs?: string;
  prefillPrompt?: string;
  setAgentForTurn?: string;
  restoreAutoAgent?: string;
  defaultAgentDescription?: string;
  mountedSkillPrefix?: string;
  selectForTurn?: string;
  mountAndSelect?: string;
  installAndSelect?: string;
  localConnector?: string;
  connectorNeedsConnection?: string;
  mcpNeedsConnection?: string;
}

export function getTrailingSlashToken(value: string): SlashTokenMatch | null {
  const match = /(^|\s)\/([^\s/]*)$/.exec(value);
  if (!match) return null;

  const leading = match[1] ?? '';
  const start = (match.index ?? 0) + leading.length;
  const query = match[2] ?? '';
  return {
    query,
    start,
    end: value.length,
    baseInput: value.slice(0, start).trim(),
  };
}

export function removeTrailingSlashToken(value: string): string {
  const match = getTrailingSlashToken(value);
  if (!match) return value;
  return value.slice(0, match.start).trimEnd();
}

export function buildLeadingSlashCommandValue(
  value: string,
  commandText: string,
): string {
  const match = getTrailingSlashToken(value);
  const baseInput = match ? match.baseInput : value.trim();
  const command = commandText.trim().replace(/^\//, '');
  return baseInput ? `/${command} ${baseInput} ` : `/${command} `;
}

function normalize(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

function buildSearchText(parts: Array<string | undefined>): string {
  return parts.map(normalize).filter(Boolean).join(' ');
}

export function createCommandCandidate(input: {
  id: string;
  label: string;
  description: string;
  shortcut?: string;
  actionKind?: SlashCandidateAction;
  emptyQueryVisible?: boolean;
  emptyQueryRank?: number;
  effectLabel?: string;
}, labels?: SlashPickerLabels): SlashPickerCandidate {
  const slashText = `/${input.id}`;
  return {
    id: input.id,
    kind: 'command',
    group: 'command',
    actionKind: input.actionKind ?? 'execute',
    label: input.label,
    description: input.description,
    slashText,
    effectLabel: input.effectLabel ?? (input.actionKind === 'prefill-leading-command'
      ? (labels?.prefillCommand ?? zh.slashCommands.picker.prefillCommand)
      : (labels?.executeNow ?? zh.slashCommands.picker.executeNow)),
    shortcut: input.shortcut,
    emptyQueryVisible: input.emptyQueryVisible,
    emptyQueryRank: input.emptyQueryRank,
    commandId: input.id,
    searchText: buildSearchText([input.id, input.label, input.description, slashText]),
  };
}

export function createPromptCandidate(
  command: PromptCommandCandidateInput,
  labels?: SlashPickerLabels,
): SlashPickerCandidate {
  const slashText = `/${command.name}`;
  const sourceLabel = command.source === 'mcp'
    ? `MCP${command.serverName ? `:${command.serverName}` : ''}`
    : command.source === 'builtin'
      ? (labels?.builtinCommand ?? zh.slashCommands.picker.builtinCommand)
      : command.scope === 'project'
        ? 'Project command'
        : 'User command';
  const hintLabel = command.hints.length > 0
    ? `${labels?.paramsPrefix ?? zh.slashCommands.picker.paramsPrefix}${command.hints.join(' ')}`
    : (labels?.noParams ?? zh.slashCommands.picker.noParams);
  const contentPreview = command.contentPreview?.trim();
  const description = (
    command.description || (command.source === 'mcp'
      ? (labels?.mcpPromptFallback ?? zh.slashCommands.picker.mcpPromptFallback)
      : (labels?.filePromptFallback ?? zh.slashCommands.picker.filePromptFallback))
  ) + `（${sourceLabel} · ${hintLabel}）`;

  return {
    id: `prompt:${command.name}`,
    kind: 'prompt',
    group: 'prompt',
    actionKind: 'prefill-prompt',
    label: command.name,
    description,
    slashText,
    source: command.source,
    effectLabel: command.hints.length > 0
      ? (labels?.prefillPromptWithArgs ?? zh.slashCommands.picker.prefillPromptWithArgs)
      : (labels?.prefillPrompt ?? zh.slashCommands.picker.prefillPrompt),
    promptName: command.name,
    promptSource: command.source,
    promptHints: command.hints,
    promptScope: command.scope,
    promptServerName: command.serverName,
    promptContentPreview: contentPreview,
    searchText: buildSearchText([
      command.name,
      command.description,
      command.source,
      command.scope,
      command.serverName,
      command.hints.join(' '),
      command.contentSearchText,
      contentPreview,
      slashText,
      `/prompts:${command.name}`,
    ]),
  };
}

export function createAgentCandidates(
  agents: AgentListEntry[],
  labels?: SlashPickerLabels,
): SlashPickerCandidate[] {
  return getAgentCommandOptions(agents, '', {
    ...(labels?.defaultAgentDescription ? { defaultDescription: labels.defaultAgentDescription } : {}),
  }).map((option) => ({
    id: `agent:${option.id ?? 'default'}`,
    kind: 'agent',
    group: 'agent',
    actionKind: 'select-agent',
    label: option.name,
    description: option.description,
    slashText: `/agent ${option.token}`,
    effectLabel: option.id
      ? (labels?.setAgentForTurn ?? zh.slashCommands.picker.setAgentForTurn)
      : (labels?.restoreAutoAgent ?? zh.slashCommands.picker.restoreAutoAgent),
    agentToken: option.token,
    agentId: option.id,
    searchText: buildSearchText([
      option.id || '',
      option.name,
      option.description,
      option.token,
      `/agent ${option.token}`,
    ]),
  }));
}

export function deriveSkillLibraryId(skill: ParsedSkill): string {
  const pathParts = skill.basePath.split('/');
  const librariesIndex = pathParts.findIndex((part) => part === 'libraries' || part === 'skills');
  if (librariesIndex >= 0 && pathParts[librariesIndex + 1]) {
    return pathParts[librariesIndex + 1]!;
  }
  return skill.source || pathParts[pathParts.length - 2] || 'unknown';
}

export function createSkillCandidates(input: {
  availableSkills: ParsedSkill[];
  mountedSkills: SessionSkillMount[];
  selectedSkillIds: string[];
  recommendations?: RecommendedSkillCandidateInput[];
}, labels?: SlashPickerLabels): SlashPickerCandidate[] {
  const mountedByName = new Map(input.mountedSkills.map((mount) => [mount.skillName, mount]));
  const selected = new Set(input.selectedSkillIds);
  const recommendations = new Map((input.recommendations ?? []).map((item) => [item.skillName, item]));
  const byName = new Map<string, SlashPickerCandidate>();

  for (const skill of input.availableSkills) {
    if (skill.enabled === false) continue;
    const mounted = mountedByName.get(skill.name);
    const recommendation = recommendations.get(skill.name);
    byName.set(skill.name, {
      id: `skill:${skill.name}`,
      kind: 'skill',
      group: recommendation ? 'suggested' : 'skill',
      actionKind: 'select-skill',
      label: recommendation?.displayName || skill.name,
      description: skill.description || 'Skill',
      slashText: `/skills:${skill.name}`,
      effectLabel: mounted
        ? (labels?.selectForTurn ?? zh.slashCommands.picker.selectForTurn)
        : (labels?.mountAndSelect ?? zh.slashCommands.picker.mountAndSelect),
      source: skill.source,
      suggested: Boolean(recommendation),
      emptyQueryVisible: Boolean(recommendation || mounted || selected.has(skill.name)),
      emptyQueryRank: recommendation ? 15 : mounted ? 40 : 50,
      skillName: skill.name,
      skillLibraryId: mounted?.libraryId || recommendation?.libraryId || deriveSkillLibraryId(skill),
      skillMounted: Boolean(mounted),
      skillSelected: selected.has(skill.name),
      skillRecommendationAction: recommendation?.action,
      skillRecommendationRepoId: recommendation?.repoId,
      searchText: buildSearchText([
        skill.name,
        recommendation?.displayName,
        recommendation?.reason,
        skill.description,
        skill.source,
        `/skills:${skill.name}`,
      ]),
    });
  }

  for (const mount of input.mountedSkills) {
    if (byName.has(mount.skillName)) continue;
    const recommendation = recommendations.get(mount.skillName);
    byName.set(mount.skillName, {
      id: `skill:${mount.skillName}`,
      kind: 'skill',
      group: recommendation ? 'suggested' : 'skill',
      actionKind: 'select-skill',
      label: recommendation?.displayName || mount.skillName,
      description: `${labels?.mountedSkillPrefix ?? zh.slashCommands.picker.mountedSkillPrefix} (${mount.libraryId})`,
      slashText: `/skills:${mount.skillName}`,
      effectLabel: labels?.selectForTurn ?? zh.slashCommands.picker.selectForTurn,
      source: mount.source,
      suggested: Boolean(recommendation),
      emptyQueryVisible: true,
      emptyQueryRank: recommendation ? 15 : 40,
      skillName: mount.skillName,
      skillLibraryId: mount.libraryId,
      skillMounted: true,
      skillSelected: selected.has(mount.skillName),
      skillRecommendationAction: recommendation?.action,
      skillRecommendationRepoId: recommendation?.repoId,
      searchText: buildSearchText([
        mount.skillName,
        recommendation?.displayName,
        recommendation?.reason,
        mount.libraryId,
        mount.source,
        `/skills:${mount.skillName}`,
      ]),
    });
  }

  for (const recommendation of input.recommendations ?? []) {
    if (byName.has(recommendation.skillName)) continue;
    byName.set(recommendation.skillName, {
      id: `skill:${recommendation.skillName}`,
      kind: 'skill',
      group: 'suggested',
      actionKind: 'select-skill',
      label: recommendation.displayName || recommendation.skillName,
      description: recommendation.reason,
      slashText: `/skills:${recommendation.skillName}`,
      effectLabel: recommendation.action === 'install'
        ? (labels?.installAndSelect ?? zh.slashCommands.picker.installAndSelect)
        : (labels?.mountAndSelect ?? zh.slashCommands.picker.mountAndSelect),
      source: recommendation.repoId,
      suggested: true,
      emptyQueryVisible: true,
      emptyQueryRank: 15,
      skillName: recommendation.skillName,
      skillLibraryId: recommendation.libraryId,
      skillMounted: false,
      skillSelected: selected.has(recommendation.skillName),
      skillRecommendationAction: recommendation.action,
      skillRecommendationRepoId: recommendation.repoId,
      searchText: buildSearchText([
        recommendation.skillName,
        recommendation.displayName,
        recommendation.reason,
        recommendation.libraryId,
        recommendation.repoId,
        `/skills:${recommendation.skillName}`,
      ]),
    });
  }

  return [...byName.values()].sort((left, right) => {
    if (left.suggested !== right.suggested) return left.suggested ? -1 : 1;
    if (left.skillMounted !== right.skillMounted) return left.skillMounted ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
}

export function createWorkbenchCapabilityCandidates(
  capabilities: WorkbenchCapabilityRegistryItem[],
  suggestedKeys: string[] = [],
  labels?: SlashPickerLabels,
): SlashPickerCandidate[] {
  const suggested = new Set(suggestedKeys);
  return capabilities.flatMap((capability): SlashPickerCandidate[] => {
    if (capability.kind === 'skill') return [];
    const isSuggested = suggested.has(capability.key);
    if (capability.kind === 'connector') {
      return [{
        id: `connector:${capability.id}`,
        kind: 'connector',
        group: isSuggested ? 'suggested' : 'connector',
        actionKind: 'select-connector',
        label: capability.label,
        description: capability.detail || capability.error || (labels?.localConnector ?? zh.slashCommands.picker.localConnector),
        slashText: `/connectors:${capability.id}`,
        effectLabel: capability.connected
          ? (labels?.selectForTurn ?? zh.slashCommands.picker.selectForTurn)
          : (labels?.connectorNeedsConnection ?? zh.slashCommands.picker.connectorNeedsConnection),
        source: capability.readiness,
        suggested: isSuggested,
        emptyQueryVisible: isSuggested || capability.selected,
        emptyQueryRank: isSuggested ? 20 : 60,
        connectorId: capability.id,
        connectorConnected: capability.connected,
        searchText: buildSearchText([
          capability.id,
          capability.label,
          capability.detail,
          capability.error,
          capability.readiness,
          ...(capability.capabilities || []),
          `/connectors:${capability.id}`,
        ]),
      }];
    }

    return [{
      id: `mcp:${capability.id}`,
      kind: 'mcp',
      group: isSuggested ? 'suggested' : 'mcp',
      actionKind: 'select-mcp',
      label: capability.label,
      description: capability.error || `${capability.status} · ${capability.toolCount} tools`,
      slashText: `/mcp:${capability.id}`,
      effectLabel: capability.status === 'connected' || capability.status === 'lazy'
        ? (labels?.selectForTurn ?? zh.slashCommands.picker.selectForTurn)
        : (labels?.mcpNeedsConnection ?? zh.slashCommands.picker.mcpNeedsConnection),
      source: capability.transport,
      suggested: isSuggested,
      emptyQueryVisible: capability.selected,
      emptyQueryRank: 70,
      mcpServerId: capability.id,
      mcpConnected: capability.status === 'connected' || capability.status === 'lazy',
      searchText: buildSearchText([
        capability.id,
        capability.label,
        capability.status,
        capability.transport,
        capability.error,
        `/mcp:${capability.id}`,
      ]),
    }];
  });
}

function rankCandidate(candidate: SlashPickerCandidate, query: string): number {
  const normalizedQuery = normalize(query.replace(/^\//, ''));
  if (!normalizedQuery) return 10;

  const id = normalize(candidate.commandId || candidate.promptName || candidate.skillName || candidate.agentToken || candidate.id);
  const label = normalize(candidate.label);
  const slash = normalize(candidate.slashText.replace(/^\//, ''));
  const search = normalize(candidate.searchText);

  if (id === normalizedQuery || label === normalizedQuery || slash === normalizedQuery) return 0;
  if (id.startsWith(normalizedQuery) || label.startsWith(normalizedQuery) || slash.startsWith(normalizedQuery)) return 1;
  if (search.includes(normalizedQuery)) return 2;
  return Number.POSITIVE_INFINITY;
}

const GROUP_ORDER: Record<SlashCandidateGroup, number> = {
  suggested: 0,
  command: 1,
  prompt: 2,
  agent: 3,
  skill: 4,
  connector: 5,
  mcp: 6,
};

export function filterAndRankSlashCandidates<T extends SlashPickerCandidate>(
  candidates: T[],
  query: string,
  options: { maxEmptyItems?: number } = {},
): T[] {
  const normalizedQuery = normalize(query.replace(/^\//, ''));
  if (!normalizedQuery) {
    return candidates
      .filter((candidate) => candidate.emptyQueryVisible)
      .sort((left, right) => (
        (left.emptyQueryRank ?? 100) - (right.emptyQueryRank ?? 100)
        || GROUP_ORDER[left.group] - GROUP_ORDER[right.group]
        || left.label.localeCompare(right.label)
      ))
      .slice(0, options.maxEmptyItems ?? 12);
  }

  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      rank: rankCandidate(candidate, query),
      relevanceBoost: (
        (candidate.suggested ? -0.2 : 0)
        + (candidate.skillSelected ? -0.15 : 0)
        + (candidate.skillMounted ? -0.1 : 0)
      ),
    }))
    .filter((item) => Number.isFinite(item.rank))
    .sort((left, right) => (
      (left.rank + left.relevanceBoost) - (right.rank + right.relevanceBoost)
      || GROUP_ORDER[left.candidate.group] - GROUP_ORDER[right.candidate.group]
      || left.index - right.index
    ))
    .map((item) => item.candidate);
}

const GROUP_LABELS: Record<SlashCandidateGroup, string> = {
  suggested: 'Suggested',
  command: 'Commands',
  prompt: 'Prompts',
  agent: 'Agents',
  skill: 'Skills',
  connector: 'Connectors',
  mcp: 'MCP',
};

export function groupSlashCandidates<T extends SlashPickerCandidate>(
  candidates: T[],
): Array<SlashPickerCandidateGroup<T>> {
  const groupMap = new Map<SlashCandidateGroup, SlashPickerCandidateGroup<T>>();
  for (const candidate of candidates) {
    const existing = groupMap.get(candidate.group);
    if (existing) {
      existing.items.push(candidate);
      continue;
    }
    groupMap.set(candidate.group, {
      group: candidate.group,
      label: GROUP_LABELS[candidate.group],
      items: [candidate],
    });
  }
  return [...groupMap.values()];
}
