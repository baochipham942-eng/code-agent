import { useEffect, useMemo } from 'react';
import type { SessionSkillMount } from '@shared/contract/skillRepository';
import type { ParsedSkill, SkillSource } from '@shared/contract/agentSkill';
import type { ToolCall } from '@shared/contract/tool';
import type { ConnectorLifecycleAction, ConnectorStatusSummary } from '@shared/ipc';
import {
  extractWorkbenchReferenceFromToolCall,
} from '@shared/contract/workbenchTools';
import { useComposerStore } from '../stores/composerStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSkillStore } from '../stores/skillStore';
import { useConnectorStatuses } from './useConnectorStatuses';
import { useMcpServerStates, type MCPServerStateSummary } from './useMcpServerStates';

export interface WorkbenchSkillCapability {
  kind: 'skill';
  id: string;
  label: string;
  selected: boolean;
  mounted: boolean;
  installState: 'mounted' | 'available' | 'missing';
  description?: string;
  source?: SkillSource;
  libraryId?: string;
}

export interface WorkbenchConnectorCapability {
  kind: 'connector';
  id: string;
  label: string;
  selected: boolean;
  connected: boolean;
  readiness?: ConnectorStatusSummary['readiness'];
  detail?: string;
  error?: string;
  checkedAt?: number;
  actions?: ConnectorLifecycleAction[];
  capabilities: string[];
}

export interface WorkbenchMcpCapability {
  kind: 'mcp';
  id: string;
  label: string;
  selected: boolean;
  status: MCPServerStateSummary['status'];
  enabled: boolean;
  transport: MCPServerStateSummary['config']['type'];
  toolCount: number;
  resourceCount: number;
  error?: string;
}

export interface WorkbenchCapabilities {
  skills: WorkbenchSkillCapability[];
  connectors: WorkbenchConnectorCapability[];
  mcpServers: WorkbenchMcpCapability[];
}

export interface WorkbenchSkillReference extends WorkbenchSkillCapability {
  invoked: boolean;
}

export interface WorkbenchConnectorReference extends WorkbenchConnectorCapability {
  invoked: boolean;
}

export interface WorkbenchMcpReference extends WorkbenchMcpCapability {
  invoked: boolean;
}

export type WorkbenchReference =
  | WorkbenchSkillReference
  | WorkbenchConnectorReference
  | WorkbenchMcpReference;

export interface WorkbenchInvocationSummary {
  skillIds: string[];
  connectorIds: string[];
  mcpServerIds: string[];
}

export interface WorkbenchHistoryAction {
  label: string;
  count: number;
}

export interface WorkbenchHistoryItem {
  kind: 'skill' | 'connector' | 'mcp';
  id: string;
  label: string;
  count: number;
  lastUsed: number;
  topActions: WorkbenchHistoryAction[];
}

function mergeVisibleIds(...groups: string[][]): string[] {
  return Array.from(new Set(groups.flat().map((id) => id.trim()).filter(Boolean)));
}

function deriveSkillLibraryId(skill: ParsedSkill): string | undefined {
  const pathParts = skill.basePath.split('/').filter(Boolean);
  const librariesIndex = pathParts.findIndex((part) => part === 'libraries');
  if (librariesIndex >= 0 && pathParts[librariesIndex + 1]) {
    return pathParts[librariesIndex + 1];
  }

  if (skill.source && skill.source !== 'library') {
    return skill.source;
  }

  const skillsIndex = pathParts.findIndex((part) => part === 'skills');
  if (skillsIndex > 0 && pathParts[skillsIndex - 1]) {
    return pathParts[skillsIndex - 1];
  }

  return skill.source;
}

export function buildWorkbenchCapabilities(args: {
  mountedSkills: SessionSkillMount[];
  availableSkills: ParsedSkill[];
  selectedSkillIds: string[];
  connectorStatuses: ConnectorStatusSummary[];
  selectedConnectorIds: string[];
  mcpServerStates: MCPServerStateSummary[];
  selectedMcpServerIds: string[];
}): WorkbenchCapabilities {
  const {
    mountedSkills,
    availableSkills,
    selectedSkillIds,
    connectorStatuses,
    selectedConnectorIds,
    mcpServerStates,
    selectedMcpServerIds,
  } = args;

  const mountedSkillIds = mountedSkills.map((skill) => skill.skillName);
  const mountedSkillIdSet = new Set(mountedSkillIds);
  const availableSkillMap = new Map(availableSkills.map((skill) => [skill.name, skill]));
  const availableSkillIds = availableSkills.map((skill) => skill.name);
  const mountedSkillMap = new Map(mountedSkills.map((skill) => [skill.skillName, skill]));
  const skills = mergeVisibleIds(mountedSkillIds, selectedSkillIds, availableSkillIds).map((skillId) => {
    const availableSkill = availableSkillMap.get(skillId);
    const mountedSkill = mountedSkillMap.get(skillId);
    const mounted = mountedSkillIdSet.has(skillId);

    return {
      kind: 'skill' as const,
      id: skillId,
      label: skillId,
      selected: selectedSkillIds.includes(skillId),
      mounted,
      installState: (mounted ? 'mounted' : availableSkill ? 'available' : 'missing') as WorkbenchSkillCapability['installState'],
      description: availableSkill?.description,
      source: availableSkill?.source,
      libraryId: mountedSkill?.libraryId || (availableSkill ? deriveSkillLibraryId(availableSkill) : undefined),
    };
  });

  const connectorMap = new Map(connectorStatuses.map((connector) => [connector.id, connector]));
  const connectedConnectorIds = connectorStatuses
    .filter((connector) => connector.connected)
    .map((connector) => connector.id);
  const connectors = mergeVisibleIds(connectedConnectorIds, selectedConnectorIds).map((connectorId) => {
    const connector = connectorMap.get(connectorId);
    return {
      kind: 'connector' as const,
      id: connectorId,
      label: connector?.label || connectorId,
      selected: selectedConnectorIds.includes(connectorId),
      connected: connector?.connected ?? false,
      readiness: connector?.readiness,
      detail: connector?.detail,
      error: connector?.error,
      checkedAt: connector?.checkedAt,
      actions: connector?.actions,
      capabilities: connector?.capabilities || [],
    };
  });

  const mcpServerMap = new Map(mcpServerStates.map((server) => [server.config.name, server]));
  const connectedMcpServerIds = mcpServerStates
    .filter((server) => server.status === 'connected')
    .map((server) => server.config.name);
  const mcpServers = mergeVisibleIds(connectedMcpServerIds, selectedMcpServerIds).map((serverId) => {
    const server = mcpServerMap.get(serverId);
    return {
      kind: 'mcp' as const,
      id: serverId,
      label: serverId,
      selected: selectedMcpServerIds.includes(serverId),
      status: server?.status || 'disconnected',
      enabled: server?.config.enabled ?? false,
      transport: server?.config.type || 'stdio',
      toolCount: server?.toolCount || 0,
      resourceCount: server?.resourceCount || 0,
      error: server?.error,
    };
  });

  return {
    skills,
    connectors,
    mcpServers,
  };
}

export function buildReferencedWorkbenchSkills(
  skills: WorkbenchSkillCapability[],
  invokedSkillIds: string[],
): WorkbenchSkillReference[] {
  const skillMap = new Map(skills.map((skill) => [skill.id, skill]));
  const mountedSkillIds = skills.filter((skill) => skill.mounted).map((skill) => skill.id);
  const referencedSkillIds = mergeVisibleIds(mountedSkillIds, invokedSkillIds);

  return referencedSkillIds
    .map((skillId) => {
      const skill = skillMap.get(skillId);
      return {
        kind: 'skill' as const,
        id: skillId,
        label: skill?.label || skillId,
        selected: skill?.selected ?? false,
        mounted: skill?.mounted ?? false,
        installState: skill?.installState ?? 'missing',
        description: skill?.description,
        source: skill?.source,
        libraryId: skill?.libraryId,
        invoked: invokedSkillIds.includes(skillId),
      };
    })
    .sort((left, right) => {
      if (left.mounted !== right.mounted) {
        return left.mounted ? -1 : 1;
      }
      if (left.installState !== right.installState) {
        const rank = { mounted: 0, available: 1, missing: 2 } as const;
        return rank[left.installState] - rank[right.installState];
      }
      return left.label.localeCompare(right.label);
    });
}

export function extractWorkbenchInvocationSummary(messages: Array<{ toolCalls?: ToolCall[] }>): WorkbenchInvocationSummary {
  const skillIds = new Set<string>();
  const connectorIds = new Set<string>();
  const mcpServerIds = new Set<string>();

  for (const message of messages) {
    for (const toolCall of message.toolCalls || []) {
      const reference = extractWorkbenchReferenceFromToolCall(toolCall);
      if (!reference) {
        continue;
      }

      if (reference.kind === 'skill') {
        skillIds.add(reference.id);
      } else if (reference.kind === 'connector') {
        connectorIds.add(reference.id);
      } else if (reference.kind === 'mcp') {
        mcpServerIds.add(reference.id);
      }
    }
  }

  return {
    skillIds: Array.from(skillIds),
    connectorIds: Array.from(connectorIds),
    mcpServerIds: Array.from(mcpServerIds),
  };
}

export function buildWorkbenchReferences(args: {
  skills: WorkbenchSkillCapability[];
  connectors: WorkbenchConnectorCapability[];
  mcpServers: WorkbenchMcpCapability[];
  invocationSummary: WorkbenchInvocationSummary;
}): WorkbenchReference[] {
  const skillReferences = buildReferencedWorkbenchSkills(args.skills, args.invocationSummary.skillIds);
  const connectorMap = new Map(args.connectors.map((connector) => [connector.id, connector]));
  const connectorReferences = args.invocationSummary.connectorIds.map((connectorId) => {
    const connector = connectorMap.get(connectorId);
    return {
      kind: 'connector' as const,
      id: connectorId,
      label: connector?.label || connectorId,
      selected: connector?.selected ?? false,
      connected: connector?.connected ?? false,
      readiness: connector?.readiness,
      detail: connector?.detail,
      error: connector?.error,
      checkedAt: connector?.checkedAt,
      capabilities: connector?.capabilities || [],
      invoked: true,
    };
  });

  const mcpServerMap = new Map(args.mcpServers.map((server) => [server.id, server]));
  const mcpReferences = args.invocationSummary.mcpServerIds.map((serverId) => {
    const server = mcpServerMap.get(serverId);
    return {
      kind: 'mcp' as const,
      id: serverId,
      label: server?.label || serverId,
      selected: server?.selected ?? false,
      status: server?.status || 'disconnected',
      enabled: server?.enabled ?? false,
      transport: server?.transport || 'stdio',
      toolCount: server?.toolCount || 0,
      resourceCount: server?.resourceCount || 0,
      error: server?.error,
      invoked: true,
    };
  });

  return [
    ...skillReferences,
    ...connectorReferences,
    ...mcpReferences,
  ];
}

export function buildWorkbenchHistory(args: {
  messages: Array<{ timestamp: number; toolCalls?: ToolCall[] }>;
  skills: WorkbenchSkillCapability[];
  connectors: WorkbenchConnectorCapability[];
  mcpServers: WorkbenchMcpCapability[];
}): WorkbenchHistoryItem[] {
  const skillMap = new Map(args.skills.map((skill) => [skill.id, skill]));
  const connectorMap = new Map(args.connectors.map((connector) => [connector.id, connector]));
  const mcpServerMap = new Map(args.mcpServers.map((server) => [server.id, server]));
  const historyMap = new Map<string, {
    kind: WorkbenchHistoryItem['kind'];
    id: string;
    label: string;
    count: number;
    lastUsed: number;
    actions: Map<string, number>;
  }>();

  for (const message of args.messages) {
    for (const toolCall of message.toolCalls || []) {
      const reference = extractWorkbenchReferenceFromToolCall(toolCall);
      if (!reference) {
        continue;
      }

      const key = `${reference.kind}:${reference.id}`;
      const existing = historyMap.get(key);
      const label = reference.kind === 'skill'
        ? skillMap.get(reference.id)?.label || reference.id
        : reference.kind === 'connector'
          ? connectorMap.get(reference.id)?.label || reference.id
          : mcpServerMap.get(reference.id)?.label || reference.id;

      if (existing) {
        existing.count++;
        existing.lastUsed = Math.max(existing.lastUsed, message.timestamp);
        if (reference.action) {
          existing.actions.set(reference.action, (existing.actions.get(reference.action) || 0) + 1);
        }
        continue;
      }

      const actions = new Map<string, number>();
      if (reference.action) {
        actions.set(reference.action, 1);
      }

      historyMap.set(key, {
        kind: reference.kind,
        id: reference.id,
        label,
        count: 1,
        lastUsed: message.timestamp,
        actions,
      });
    }
  }

  return Array.from(historyMap.values())
    .map((entry) => ({
      kind: entry.kind,
      id: entry.id,
      label: entry.label,
      count: entry.count,
      lastUsed: entry.lastUsed,
      topActions: Array.from(entry.actions.entries())
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 3)
        .map(([label, count]) => ({ label, count })),
    }))
    .sort((left, right) => right.lastUsed - left.lastUsed);
}

export function useWorkbenchCapabilities(): WorkbenchCapabilities {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const mountedSkills = useSkillStore((state) => state.mountedSkills);
  const availableSkills = useSkillStore((state) => state.availableSkills);
  const setSkillSession = useSkillStore((state) => state.setCurrentSession);
  const fetchAvailableSkills = useSkillStore((state) => state.fetchAvailableSkills);
  const selectedSkillIds = useComposerStore((state) => state.selectedSkillIds);
  const selectedConnectorIds = useComposerStore((state) => state.selectedConnectorIds);
  const selectedMcpServerIds = useComposerStore((state) => state.selectedMcpServerIds);
  const connectorStatuses = useConnectorStatuses();
  const mcpServerStates = useMcpServerStates();

  useEffect(() => {
    if (currentSessionId) {
      setSkillSession(currentSessionId);
    }
  }, [currentSessionId, setSkillSession]);

  useEffect(() => {
    if (availableSkills.length === 0) {
      void fetchAvailableSkills();
    }
  }, [availableSkills.length, fetchAvailableSkills]);

  return useMemo(() => buildWorkbenchCapabilities({
    mountedSkills,
    availableSkills,
    selectedSkillIds,
    connectorStatuses,
    selectedConnectorIds,
    mcpServerStates,
    selectedMcpServerIds,
  }), [
    connectorStatuses,
    mcpServerStates,
    availableSkills,
    mountedSkills,
    selectedConnectorIds,
    selectedMcpServerIds,
    selectedSkillIds,
  ]);
}
