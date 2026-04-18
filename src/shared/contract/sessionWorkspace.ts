import type {
  BrowserSessionMode,
  ConversationRoutingMode,
  WorkbenchMessageMetadata,
} from './conversationEnvelope';
import type { Message } from './message';
import { extractWorkbenchReferenceFromToolCall } from './workbenchTools';

export interface SessionWorkbenchSnapshot {
  summary: string;
  labels: string[];
  recentToolNames: string[];
  primarySurface?: 'workspace' | 'browser' | 'desktop' | 'connector' | 'chat';
  evidenceSource?: 'message_metadata' | 'tool_history' | 'session_provenance' | 'session_metadata';
  workspaceLabel?: string;
  routingMode?: ConversationRoutingMode;
  skillIds?: string[];
  connectorIds?: string[];
  mcpServerIds?: string[];
}

export interface SessionWorkbenchProvenance extends WorkbenchMessageMetadata {
  capturedAt: number;
}

const DESKTOP_TOOL_PATTERNS = [
  /^desktop/i,
  /^nativeDesktop$/i,
];

const WORKSPACE_TOOL_PATTERNS = [
  /^read$/i,
  /^write$/i,
  /^edit$/i,
  /^multi_edit$/i,
  /^grep$/i,
  /^glob$/i,
  /^ls$/i,
  /^list/i,
  /^bash$/i,
  /^shell/i,
  /^notebook/i,
  /^read_file$/i,
  /^write_file$/i,
];

type SurfaceKind = NonNullable<SessionWorkbenchSnapshot['primarySurface']>;
type EvidenceSource = NonNullable<SessionWorkbenchSnapshot['evidenceSource']>;

interface SurfaceEvidence {
  kind: Exclude<SurfaceKind, 'chat'>;
  label: string;
  timestamp: number;
  source: EvidenceSource;
}

interface CapabilityEvidence {
  skillIds: string[];
  connectorIds: string[];
  mcpServerIds: string[];
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function matchesPattern(name: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(name));
}

function collectRecentToolNames(messages: Array<Pick<Message, 'toolCalls'>>): string[] {
  const toolNames = messages.flatMap((message) =>
    message.toolCalls?.map((toolCall) => toolCall.name).filter(Boolean) || [],
  );

  const deduped = Array.from(new Set(toolNames.reverse()));
  return deduped.slice(0, 3).reverse();
}

function cloneWorkbenchMetadata(
  metadata: WorkbenchMessageMetadata,
): WorkbenchMessageMetadata {
  return {
    ...metadata,
    targetAgentIds: metadata.targetAgentIds ? [...metadata.targetAgentIds] : undefined,
    targetAgentNames: metadata.targetAgentNames ? [...metadata.targetAgentNames] : undefined,
    selectedSkillIds: metadata.selectedSkillIds ? [...metadata.selectedSkillIds] : undefined,
    selectedConnectorIds: metadata.selectedConnectorIds ? [...metadata.selectedConnectorIds] : undefined,
    selectedMcpServerIds: metadata.selectedMcpServerIds ? [...metadata.selectedMcpServerIds] : undefined,
    executionIntent: metadata.executionIntent ? {
      ...metadata.executionIntent,
      browserSessionSnapshot: metadata.executionIntent.browserSessionSnapshot
        ? {
            ...metadata.executionIntent.browserSessionSnapshot,
            preview: metadata.executionIntent.browserSessionSnapshot.preview
              ? { ...metadata.executionIntent.browserSessionSnapshot.preview }
              : undefined,
          }
        : undefined,
    } : undefined,
  };
}

export function toSessionWorkbenchProvenance(
  metadata?: WorkbenchMessageMetadata,
  capturedAt: number = Date.now(),
): SessionWorkbenchProvenance | undefined {
  if (!metadata) {
    return undefined;
  }

  return {
    capturedAt,
    ...cloneWorkbenchMetadata(metadata),
  };
}

function getWorkspaceLabel(workingDirectory?: string | null): string | undefined {
  const trimmed = workingDirectory?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.replace(/[\\/]+$/, '');
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || normalized;
}

function isComputerUseSmartAction(action: unknown): boolean {
  return typeof action === 'string' && [
    'locate_element',
    'locate_text',
    'locate_role',
    'smart_click',
    'smart_type',
    'smart_hover',
    'get_elements',
  ].includes(action);
}

function isBrowserToolCall(toolCall: NonNullable<Message['toolCalls']>[number]): boolean {
  const name = toolCall.name.toLowerCase();
  if (name === 'browser' || name === 'browser_action' || name === 'browser_navigate') {
    return true;
  }

  if (name === 'computer_use') {
    return isComputerUseSmartAction(toolCall.arguments?.action);
  }

  return false;
}

function isDesktopToolCall(toolCall: NonNullable<Message['toolCalls']>[number]): boolean {
  const name = toolCall.name.toLowerCase();
  if (name === 'computer_use') {
    return !isComputerUseSmartAction(toolCall.arguments?.action);
  }

  return matchesPattern(toolCall.name, DESKTOP_TOOL_PATTERNS);
}

function isWorkspaceToolCall(toolCall: NonNullable<Message['toolCalls']>[number]): boolean {
  return matchesPattern(toolCall.name, WORKSPACE_TOOL_PATTERNS);
}

function getBrowserLabelFromMode(
  mode: Exclude<BrowserSessionMode, 'none'>,
  metadata?: WorkbenchMessageMetadata,
): string {
  if (mode === 'managed') {
    return 'Browser(托管)';
  }

  if (metadata?.executionIntent?.browserSessionSnapshot?.ready === false) {
    return 'Browser(桌面待就绪)';
  }

  return 'Browser(桌面)';
}

function getBrowserLabelFromToolCall(
  toolCall: NonNullable<Message['toolCalls']>[number],
  toolResults: NonNullable<Message['toolResults']>,
): string {
  const result = toolResults.find((item) => item.toolCallId === toolCall.id);
  if (result?.metadata && typeof result.metadata === 'object' && result.metadata.workbenchBlocked === true) {
    return 'Browser(受阻)';
  }

  const name = toolCall.name.toLowerCase();
  if (name === 'browser_action') {
    return 'Browser(托管)';
  }
  if (name === 'browser_navigate') {
    return 'Browser(系统)';
  }
  if (name === 'computer_use') {
    return isComputerUseSmartAction(toolCall.arguments?.action) ? 'Browser' : 'Desktop';
  }
  return 'Browser';
}

function collectCapabilityEvidence(
  messages: Array<Pick<Message, 'toolCalls'>>,
): CapabilityEvidence {
  const skills: string[] = [];
  const connectors: string[] = [];
  const mcps: string[] = [];

  for (const message of messages) {
    for (const toolCall of message.toolCalls || []) {
      const reference = extractWorkbenchReferenceFromToolCall(toolCall);
      if (!reference) {
        continue;
      }

      if (reference.kind === 'skill') {
        skills.push(reference.id);
      } else if (reference.kind === 'connector') {
        connectors.push(reference.id);
      } else if (reference.kind === 'mcp') {
        mcps.push(reference.id);
      }
    }
  }

  return {
    skillIds: dedupe(skills),
    connectorIds: dedupe(connectors),
    mcpServerIds: dedupe(mcps),
  };
}

function findLatestWorkbenchMetadata(
  messages: Array<Pick<Message, 'metadata'>>,
): WorkbenchMessageMetadata | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const metadata = messages[index]?.metadata?.workbench;
    if (metadata) {
      return metadata;
    }
  }
  return undefined;
}

function collectSurfaceEvidence(
  messages: Array<Pick<Message, 'metadata' | 'timestamp' | 'toolCalls' | 'toolResults'>>,
  options: {
    workingDirectory?: string | null;
    provenance?: SessionWorkbenchProvenance;
  } = {},
): SurfaceEvidence[] {
  const evidence: SurfaceEvidence[] = [];

  for (const message of messages) {
    const timestamp = message.timestamp || 0;
    const metadata = message.metadata?.workbench;

    if (metadata?.executionIntent?.browserSessionMode) {
      evidence.push({
        kind: 'browser',
        label: getBrowserLabelFromMode(metadata.executionIntent.browserSessionMode, metadata),
        timestamp,
        source: 'message_metadata',
      });
    } else if (metadata?.executionIntent?.preferDesktopContext) {
      evidence.push({
        kind: 'desktop',
        label: 'Desktop',
        timestamp,
        source: 'message_metadata',
      });
    }

    if (metadata?.selectedConnectorIds?.length) {
      evidence.push({
        kind: 'connector',
        label: '连接器',
        timestamp,
        source: 'message_metadata',
      });
    }

    if (metadata?.workingDirectory?.trim()) {
      evidence.push({
        kind: 'workspace',
        label: '工作区',
        timestamp,
        source: 'message_metadata',
      });
    }

    const toolResults = message.toolResults || [];
    for (const toolCall of message.toolCalls || []) {
      if (isBrowserToolCall(toolCall)) {
        evidence.push({
          kind: 'browser',
          label: getBrowserLabelFromToolCall(toolCall, toolResults),
          timestamp,
          source: 'tool_history',
        });
        continue;
      }

      if (isDesktopToolCall(toolCall)) {
        evidence.push({
          kind: 'desktop',
          label: 'Desktop',
          timestamp,
          source: 'tool_history',
        });
        continue;
      }

      const reference = extractWorkbenchReferenceFromToolCall(toolCall);
      if (reference?.kind === 'connector') {
        evidence.push({
          kind: 'connector',
          label: '连接器',
          timestamp,
          source: 'tool_history',
        });
        continue;
      }

      if (isWorkspaceToolCall(toolCall)) {
        evidence.push({
          kind: 'workspace',
          label: '工作区',
          timestamp,
          source: 'tool_history',
        });
      }
    }
  }

  const provenance = options.provenance;
  if (provenance) {
    if (provenance.executionIntent?.browserSessionMode) {
      evidence.push({
        kind: 'browser',
        label: getBrowserLabelFromMode(provenance.executionIntent.browserSessionMode, provenance),
        timestamp: provenance.capturedAt,
        source: 'session_provenance',
      });
    } else if (provenance.executionIntent?.preferDesktopContext) {
      evidence.push({
        kind: 'desktop',
        label: 'Desktop',
        timestamp: provenance.capturedAt,
        source: 'session_provenance',
      });
    }

    if (provenance.selectedConnectorIds?.length) {
      evidence.push({
        kind: 'connector',
        label: '连接器',
        timestamp: provenance.capturedAt,
        source: 'session_provenance',
      });
    }

    if (provenance.workingDirectory?.trim()) {
      evidence.push({
        kind: 'workspace',
        label: '工作区',
        timestamp: provenance.capturedAt,
        source: 'session_provenance',
      });
    }
  }

  if (options.workingDirectory?.trim()) {
    evidence.push({
      kind: 'workspace',
      label: '工作区',
      timestamp: 0,
      source: 'session_metadata',
    });
  }

  return evidence;
}

function choosePrimarySurface(evidence: SurfaceEvidence[]): SurfaceEvidence | undefined {
  return [...evidence]
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) {
        return right.timestamp - left.timestamp;
      }

      const sourceRank = {
        message_metadata: 3,
        tool_history: 2,
        session_provenance: 1.5,
        session_metadata: 1,
      };
      return sourceRank[right.source] - sourceRank[left.source];
    })[0];
}

function formatNamedCapability(label: string, values: string[]): string | undefined {
  if (values.length === 0) {
    return undefined;
  }

  if (values.length <= 2) {
    return `${label} ${values.join('/')}`;
  }

  return `${label} ${values.length}`;
}

function buildCapabilitySummary(args: CapabilityEvidence): string | undefined {
  const parts = [
    formatNamedCapability('连接器', args.connectorIds),
    formatNamedCapability('MCP', args.mcpServerIds),
    formatNamedCapability('技能', args.skillIds),
  ].filter((value): value is string => Boolean(value));

  return parts.length > 0 ? parts.join(' / ') : undefined;
}

function buildRoutingSummary(metadata?: WorkbenchMessageMetadata): string | undefined {
  if (!metadata?.routingMode || metadata.routingMode === 'auto') {
    return undefined;
  }

  if (metadata.routingMode === 'parallel') {
    return 'Parallel';
  }

  const targets = metadata.targetAgentNames?.length
    ? metadata.targetAgentNames
    : metadata.targetAgentIds;

  if (targets?.length) {
    return targets.length <= 2
      ? `Direct ${targets.join('/')}`
      : `Direct ${targets.length}`;
  }

  return 'Direct';
}

export function deriveSessionWorkbenchSnapshot(
  messages: Array<Pick<Message, 'toolCalls' | 'toolResults' | 'metadata' | 'timestamp'>> = [],
  options: {
    workingDirectory?: string | null;
    provenance?: SessionWorkbenchProvenance;
  } = {},
): SessionWorkbenchSnapshot {
  const recentToolNames = collectRecentToolNames(messages);
  const latestMetadata = findLatestWorkbenchMetadata(messages) || options.provenance;
  const inferredCapabilities = collectCapabilityEvidence(messages);
  const capabilities: CapabilityEvidence = {
    skillIds: latestMetadata?.selectedSkillIds?.length
      ? dedupe(latestMetadata.selectedSkillIds)
      : inferredCapabilities.skillIds,
    connectorIds: latestMetadata?.selectedConnectorIds?.length
      ? dedupe(latestMetadata.selectedConnectorIds)
      : inferredCapabilities.connectorIds,
    mcpServerIds: latestMetadata?.selectedMcpServerIds?.length
      ? dedupe(latestMetadata.selectedMcpServerIds)
      : inferredCapabilities.mcpServerIds,
  };
  const capabilitySummary = buildCapabilitySummary(capabilities);
  const routingSummary = buildRoutingSummary(latestMetadata);
  const workspaceLabel = getWorkspaceLabel(
    latestMetadata?.workingDirectory ?? options.workingDirectory,
  );
  const surfaceEvidence = collectSurfaceEvidence(messages, {
    workingDirectory: options.workingDirectory,
    provenance: options.provenance,
  });
  const primarySurface = choosePrimarySurface(surfaceEvidence)
    || (workspaceLabel
      ? {
          kind: 'workspace' as const,
          label: '工作区',
          timestamp: 0,
          source: 'session_metadata' as const,
        }
      : undefined);

  const surfaceKinds = new Set(surfaceEvidence.map((item) => item.kind));
  const labels: string[] = [];
  if (primarySurface) {
    labels.push(primarySurface.label);
  }
  if (surfaceKinds.has('workspace')) {
    labels.push('工作区');
  }
  if (surfaceKinds.has('browser')) {
    labels.push('Browser');
  }
  if (surfaceKinds.has('desktop')) {
    labels.push('Desktop');
  }
  if (surfaceKinds.has('connector')) {
    labels.push('连接器');
  }
  if (routingSummary) {
    labels.push(routingSummary);
  }
  labels.push(...capabilities.connectorIds.map((id) => `连接器:${id}`));
  labels.push(...capabilities.mcpServerIds.map((id) => `MCP:${id}`));
  labels.push(...capabilities.skillIds.map((id) => `技能:${id}`));

  const summarySegments: string[] = [];
  summarySegments.push(primarySurface?.label || '纯对话');
  if (routingSummary) {
    summarySegments.push(routingSummary);
  }
  if (capabilitySummary) {
    summarySegments.push(capabilitySummary);
  }
  if ((primarySurface?.kind !== 'workspace') && workspaceLabel) {
    summarySegments.push('工作区');
  }

  return {
    summary: summarySegments.join(' · '),
    labels: labels.length > 0 ? dedupe(labels) : ['纯对话'],
    recentToolNames,
    primarySurface: primarySurface?.kind || 'chat',
    evidenceSource: primarySurface?.source || 'session_metadata',
    workspaceLabel,
    routingMode: latestMetadata?.routingMode,
    skillIds: capabilities.skillIds,
    connectorIds: capabilities.connectorIds,
    mcpServerIds: capabilities.mcpServerIds,
  };
}
