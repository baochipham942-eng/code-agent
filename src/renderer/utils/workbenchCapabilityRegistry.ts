import type { ConnectorStatusSummary } from '@shared/ipc';
import type { SessionSkillMount } from '@shared/contract/skillRepository';
import type { ParsedSkill } from '@shared/contract/agentSkill';
import type { CapabilityAssessmentInfo } from '@shared/contract/capability';
import type {
  BlockedCapabilityReason,
  TurnCapabilityReadiness,
  TurnWorkbenchSnapshot,
} from '@shared/contract/turnTimeline';
import {
  buildWorkbenchCapabilities,
  type WorkbenchCapabilities,
  type WorkbenchConnectorCapability,
  type WorkbenchMcpCapability,
  type WorkbenchSkillCapability,
} from '../hooks/useWorkbenchCapabilities';
import type { MCPServerStateSummary } from '../hooks/useMcpServerStates';

export type WorkbenchCapabilityHealth = 'healthy' | 'degraded' | 'error' | 'inactive';
export type WorkbenchCapabilityInstallState = 'installed' | 'missing' | 'not_applicable';
export type WorkbenchCapabilityMountState = 'mounted' | 'unmounted' | 'not_applicable';
export type WorkbenchCapabilityConnectionState =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'error'
  | 'lazy'
  | 'not_applicable';

export type WorkbenchCapabilityBlockedState = Pick<BlockedCapabilityReason, 'code' | 'detail' | 'hint' | 'severity'>;

export interface WorkbenchCapabilityLifecycle {
  installState: WorkbenchCapabilityInstallState;
  mountState: WorkbenchCapabilityMountState;
  connectionState: WorkbenchCapabilityConnectionState;
}

interface WorkbenchCapabilityRegistryBase {
  key: string;
  selected: boolean;
  available: boolean;
  turnReadiness: TurnCapabilityReadiness;
  autoAllowed: boolean;
  blocked: boolean;
  visibleInWorkbench: boolean;
  health: WorkbenchCapabilityHealth;
  lifecycle: WorkbenchCapabilityLifecycle;
  assessment?: CapabilityAssessmentInfo;
  blockedReason?: WorkbenchCapabilityBlockedState;
}

export interface WorkbenchSkillRegistryItem extends WorkbenchSkillCapability, WorkbenchCapabilityRegistryBase {}

export interface WorkbenchConnectorRegistryItem extends WorkbenchConnectorCapability, WorkbenchCapabilityRegistryBase {}

export interface WorkbenchMcpRegistryItem extends WorkbenchMcpCapability, WorkbenchCapabilityRegistryBase {}

export type WorkbenchCapabilityRegistryItem =
  | WorkbenchSkillRegistryItem
  | WorkbenchConnectorRegistryItem
  | WorkbenchMcpRegistryItem;

export interface WorkbenchCapabilityRegistry {
  items: WorkbenchCapabilityRegistryItem[];
  skills: WorkbenchSkillRegistryItem[];
  connectors: WorkbenchConnectorRegistryItem[];
  mcpServers: WorkbenchMcpRegistryItem[];
}

export interface BuildWorkbenchCapabilityRegistryArgs {
  mountedSkills: SessionSkillMount[];
  availableSkills: ParsedSkill[];
  selectedSkillIds: string[];
  connectorStatuses: ConnectorStatusSummary[];
  selectedConnectorIds: string[];
  mcpServerStates: MCPServerStateSummary[];
  selectedMcpServerIds: string[];
}

const MCP_STATUS_LABELS_ZH: Record<WorkbenchMcpCapability['status'], string> = {
  connected: '已连接',
  connecting: '连接中',
  disconnected: '未连接',
  error: '错误',
  lazy: '懒加载',
};

function buildWorkbenchCapabilityAssessment(args: {
  kind: 'skill' | 'connector' | 'mcp';
  id: string;
  label: string;
  detail?: string;
  tags?: string[];
}): CapabilityAssessmentInfo | undefined {
  const text = [
    args.kind,
    args.id,
    args.label,
    args.detail,
    ...(args.tags || []),
  ].filter(Boolean).join(' ').toLowerCase();
  const evidenceRefs = ['marvis-runtime-capability-matrix', `${args.kind}:${args.id}`];

  if (/(yyb|androws|应用宝|小程序|mini[-_ ]?program|wechat mini)/i.test(text)) {
    return {
      priority: 'P2',
      portability: 'reference_only',
      recommendedUse: '只作为 Windows 应用链路和小程序 adapter 的产品 spec 参考，Mac runtime 暂不启用。',
      evidenceRefs,
    };
  }

  if (/(browser|playwright|patchright|computer|desktop|mac-desktop|vision)/i.test(text)) {
    return {
      priority: 'P0',
      portability: 'native',
      recommendedUse: '适合登录态、表单、多页网页操作、截图观察和 macOS 桌面自动化；纯阅读任务先用轻量读取。',
      evidenceRefs,
    };
  }

  if (/(excel|xlsx|docx|document|office|ppt|pptx|slide|frontend-slides|pdf)/i.test(text)) {
    return {
      priority: 'P1',
      portability: 'native',
      recommendedUse: '适合办公文档和数据产物生成；先读取/分析源材料，生成后回读或结构校验。',
      evidenceRefs,
    };
  }

  if (/(file|search|ripgrep|grep|glob|read_file|planning-with-files)/i.test(text)) {
    return {
      priority: 'P1',
      portability: 'native',
      recommendedUse: '适合文件读取、检索、摘要和代码库定位；读搜先走轻量工具，编辑和生成再升级到 skill。',
      evidenceRefs,
    };
  }

  return undefined;
}

function buildSkillBlockedReason(skill: WorkbenchSkillCapability): WorkbenchCapabilityBlockedState | undefined {
  if (skill.mounted) {
    return undefined;
  }

  if (skill.installState === 'available') {
    return {
      code: 'skill_not_mounted',
      detail: `Skill ${skill.label} 已安装但未挂载，本轮不会调用。`,
      hint: '去 TaskPanel/Skills 把它挂到当前会话。',
      severity: 'warning',
    };
  }

  return {
    code: 'skill_missing',
    detail: `Skill ${skill.label} 当前不可用，本轮不会调用。`,
    hint: '去 TaskPanel/Skills 检查安装状态。',
    severity: 'error',
  };
}

function buildConnectorBlockedReason(connector: WorkbenchConnectorCapability): WorkbenchCapabilityBlockedState | undefined {
  if (connector.connected) {
    return undefined;
  }

  if (connector.readiness === 'unchecked') {
    return {
      code: 'connector_unverified',
      detail: `Connector ${connector.label} 已启用但还没检查本地授权，本轮不会调用。`,
      hint: '点"检查/授权"执行一次显式探测；这一步可能拉起本地应用或触发系统授权。',
      severity: 'warning',
    };
  }

  if (connector.readiness === 'failed') {
    return {
      code: 'connector_auth_failed',
      detail: `Connector ${connector.label} 授权/可用性检查失败，本轮不会调用。${connector.error ? ` ${connector.error}` : ''}`,
      hint: '打开本地应用确认登录和系统授权后，再点"检查/授权"。',
      severity: 'error',
    };
  }

  return {
    code: 'connector_disconnected',
    detail: `Connector ${connector.label} 当前未连接，本轮不会调用。`,
    hint: '先点"启用/重试"把连接器加入 registry；启用后还需要单独做授权/可用性检查。',
    severity: 'warning',
  };
}

function buildMcpBlockedReason(server: WorkbenchMcpCapability): WorkbenchCapabilityBlockedState | undefined {
  if (server.status === 'connected') {
    return undefined;
  }

  if (server.status === 'error') {
    return {
      code: 'mcp_error',
      detail: `MCP ${server.label} 当前状态为 error，本轮不会调用。`,
      hint: '去 MCP Settings 查看报错并修复后重试。',
      severity: 'error',
    };
  }

  return {
    code: 'mcp_disconnected',
    detail: `MCP ${server.label} 当前状态为 ${MCP_STATUS_LABELS_ZH[server.status]}，本轮不会调用。`,
    hint: '去 MCP Settings 检查服务状态后再试。',
    severity: 'warning',
  };
}

function isHighRiskCapability(capability: Pick<WorkbenchCapabilityRegistryItem, 'kind' | 'id'>): boolean {
  if (capability.kind !== 'mcp') {
    return false;
  }

  return ['cua-driver', 'computer-use', 'filesystem', 'docker'].includes(capability.id);
}

export function getWorkbenchCapabilityReadiness(
  capability: WorkbenchCapabilityRegistryItem,
): TurnCapabilityReadiness {
  if (capability.available) {
    return isHighRiskCapability(capability) ? 'blocked_high_risk' : 'ready';
  }

  switch (capability.kind) {
    case 'skill':
      return capability.installState === 'available' ? 'needs_config' : 'unsupported';
    case 'connector':
      if (capability.readiness === 'unchecked' || capability.readiness === 'failed') {
        return 'needs_permission';
      }
      return 'needs_config';
    case 'mcp':
      return capability.status === 'error' ? 'offline' : 'needs_config';
    default:
      return 'unsupported';
  }
}

export function isWorkbenchCapabilityAutoAllowed(
  capability: WorkbenchCapabilityRegistryItem,
): boolean {
  return getWorkbenchCapabilityReadiness(capability) === 'ready';
}

export function getWorkbenchCapabilityBlockedState(
  capability: WorkbenchCapabilityRegistryItem,
): WorkbenchCapabilityBlockedState | undefined {
  if (capability.blockedReason) {
    return capability.blockedReason;
  }

  switch (capability.kind) {
    case 'skill':
      return buildSkillBlockedReason(capability);
    case 'connector':
      return buildConnectorBlockedReason(capability);
    case 'mcp':
      return buildMcpBlockedReason(capability);
    default:
      return undefined;
  }
}

export function buildWorkbenchSkillRegistryItem(skill: WorkbenchSkillCapability): WorkbenchSkillRegistryItem {
  const blockedReason = skill.selected ? buildSkillBlockedReason(skill) : undefined;
  const available = skill.mounted;
  const readiness: TurnCapabilityReadiness = available ? 'ready' : skill.installState === 'available' ? 'needs_config' : 'unsupported';

  return {
    ...skill,
    key: `skill:${skill.id}`,
    available,
    turnReadiness: readiness,
    autoAllowed: readiness === 'ready',
    blocked: skill.selected && !available,
    visibleInWorkbench: available || skill.selected,
    health: skill.mounted ? 'healthy' : skill.installState === 'available' ? 'inactive' : 'error',
    lifecycle: {
      installState: skill.installState === 'missing' ? 'missing' : 'installed',
      mountState: skill.mounted ? 'mounted' : 'unmounted',
      connectionState: 'not_applicable',
    },
    assessment: buildWorkbenchCapabilityAssessment({
      kind: 'skill',
      id: skill.id,
      label: skill.label,
      detail: skill.description,
      tags: [skill.source || '', skill.libraryId || ''],
    }),
    blockedReason,
  };
}

export function buildWorkbenchConnectorRegistryItem(
  connector: WorkbenchConnectorCapability,
): WorkbenchConnectorRegistryItem {
  const available = connector.connected;
  const blockedReason = connector.selected ? buildConnectorBlockedReason(connector) : undefined;
  const connectionState: WorkbenchCapabilityConnectionState = connector.connected
    ? 'connected'
    : connector.readiness === 'unchecked'
      ? 'lazy'
      : connector.readiness === 'failed'
        ? 'error'
        : 'disconnected';
  const health: WorkbenchCapabilityHealth = connector.connected
    ? 'healthy'
    : connector.readiness === 'failed'
      ? 'error'
      : connector.readiness === 'unchecked'
        ? 'degraded'
        : 'inactive';
  const readiness: TurnCapabilityReadiness = available
    ? 'ready'
    : connector.readiness === 'unchecked' || connector.readiness === 'failed'
      ? 'needs_permission'
      : 'needs_config';

  return {
    ...connector,
    key: `connector:${connector.id}`,
    available,
    turnReadiness: readiness,
    autoAllowed: readiness === 'ready',
    blocked: connector.selected && !available,
    visibleInWorkbench: available || connector.selected,
    health,
    lifecycle: {
      installState: 'not_applicable',
      mountState: 'not_applicable',
      connectionState,
    },
    assessment: buildWorkbenchCapabilityAssessment({
      kind: 'connector',
      id: connector.id,
      label: connector.label,
      detail: connector.detail,
      tags: connector.capabilities,
    }),
    blockedReason,
  };
}

export function buildWorkbenchMcpRegistryItem(server: WorkbenchMcpCapability): WorkbenchMcpRegistryItem {
  const available = server.status === 'connected';
  const blockedReason = server.selected ? buildMcpBlockedReason(server) : undefined;
  const health: WorkbenchCapabilityHealth =
    server.status === 'connected'
      ? 'healthy'
      : server.status === 'error'
        ? 'error'
        : server.status === 'connecting' || server.status === 'lazy'
          ? 'degraded'
          : 'inactive';
  const highRisk = ['cua-driver', 'computer-use', 'filesystem', 'docker'].includes(server.id);
  const readiness: TurnCapabilityReadiness = available
    ? highRisk ? 'blocked_high_risk' : 'ready'
    : server.status === 'error'
      ? 'offline'
      : 'needs_config';

  return {
    ...server,
    key: `mcp:${server.id}`,
    available,
    turnReadiness: readiness,
    autoAllowed: readiness === 'ready',
    blocked: server.selected && !available,
    visibleInWorkbench: available || server.selected,
    health,
    lifecycle: {
      installState: 'not_applicable',
      mountState: 'not_applicable',
      connectionState: server.status,
    },
    assessment: buildWorkbenchCapabilityAssessment({
      kind: 'mcp',
      id: server.id,
      label: server.label,
      detail: server.error,
      tags: [server.transport || '', `${server.toolCount} tools`, `${server.resourceCount} resources`],
    }),
    blockedReason,
  };
}

function withMissingConnectors(
  connectors: WorkbenchConnectorCapability[],
  connectorStatuses: ConnectorStatusSummary[],
): WorkbenchConnectorCapability[] {
  const connectorMap = new Map(connectors.map((connector) => [connector.id, connector]));
  const next = [...connectors];

  for (const connector of connectorStatuses) {
    if (connectorMap.has(connector.id)) {
      continue;
    }
    next.push({
      kind: 'connector',
      id: connector.id,
      label: connector.label,
      selected: false,
      connected: connector.connected,
      readiness: connector.readiness,
      detail: connector.detail,
      error: connector.error,
      checkedAt: connector.checkedAt,
      actions: connector.actions,
      capabilities: connector.capabilities,
    });
  }

  return next;
}

function withMissingMcpServers(
  mcpServers: WorkbenchMcpCapability[],
  mcpServerStates: MCPServerStateSummary[],
): WorkbenchMcpCapability[] {
  const mcpServerMap = new Map(mcpServers.map((server) => [server.id, server]));
  const next = [...mcpServers];

  for (const server of mcpServerStates) {
    if (mcpServerMap.has(server.config.name)) {
      continue;
    }
    next.push({
      kind: 'mcp',
      id: server.config.name,
      label: server.config.name,
      selected: false,
      status: server.status,
      enabled: server.config.enabled,
      transport: server.config.type,
      toolCount: server.toolCount,
      resourceCount: server.resourceCount,
      error: server.error,
    });
  }

  return next;
}

export function buildWorkbenchCapabilityRegistryFromCapabilities(
  capabilities: WorkbenchCapabilities,
): WorkbenchCapabilityRegistry {
  const skills = capabilities.skills.map(buildWorkbenchSkillRegistryItem);
  const connectors = capabilities.connectors.map(buildWorkbenchConnectorRegistryItem);
  const mcpServers = capabilities.mcpServers.map(buildWorkbenchMcpRegistryItem);

  return {
    items: [...skills, ...connectors, ...mcpServers],
    skills,
    connectors,
    mcpServers,
  };
}

function buildSelectedWorkbenchSkillRegistryItems(
  snapshot: TurnWorkbenchSnapshot,
  capabilities: WorkbenchCapabilities,
): WorkbenchSkillRegistryItem[] {
  const skillMap = new Map(capabilities.skills.map((skill) => [skill.id, skill]));

  return (snapshot.selectedSkillIds || []).map((skillId) => {
    const rawSkill = skillMap.get(skillId);
    return buildWorkbenchSkillRegistryItem(rawSkill ? {
      ...rawSkill,
      selected: true,
    } : {
      kind: 'skill',
      id: skillId,
      label: skillId,
      selected: true,
      mounted: false,
      installState: 'missing',
      description: undefined,
      source: undefined,
      libraryId: undefined,
    });
  });
}

function buildSelectedWorkbenchConnectorRegistryItems(
  snapshot: TurnWorkbenchSnapshot,
  capabilities: WorkbenchCapabilities,
): WorkbenchConnectorRegistryItem[] {
  const connectorMap = new Map(capabilities.connectors.map((connector) => [connector.id, connector]));

  return (snapshot.selectedConnectorIds || []).map((connectorId) => {
    const rawConnector = connectorMap.get(connectorId);
    return buildWorkbenchConnectorRegistryItem(rawConnector ? {
      ...rawConnector,
      selected: true,
    } : {
      kind: 'connector',
      id: connectorId,
      label: connectorId,
      selected: true,
      connected: false,
      readiness: undefined,
      detail: undefined,
      error: undefined,
      checkedAt: undefined,
      actions: undefined,
      capabilities: [],
    });
  });
}

function buildSelectedWorkbenchMcpRegistryItems(
  snapshot: TurnWorkbenchSnapshot,
  capabilities: WorkbenchCapabilities,
): WorkbenchMcpRegistryItem[] {
  const mcpMap = new Map(capabilities.mcpServers.map((server) => [server.id, server]));

  return (snapshot.selectedMcpServerIds || []).map((serverId) => {
    const rawServer = mcpMap.get(serverId);
    return buildWorkbenchMcpRegistryItem(rawServer ? {
      ...rawServer,
      selected: true,
    } : {
      kind: 'mcp',
      id: serverId,
      label: serverId,
      selected: true,
      status: 'disconnected',
      enabled: false,
      transport: 'stdio',
      toolCount: 0,
      resourceCount: 0,
      error: undefined,
    });
  });
}

export function buildSelectedWorkbenchCapabilityRegistryItems(
  snapshot: TurnWorkbenchSnapshot | undefined,
  capabilities: WorkbenchCapabilities,
): WorkbenchCapabilityRegistryItem[] {
  if (!snapshot) {
    return [];
  }

  return [
    ...buildSelectedWorkbenchSkillRegistryItems(snapshot, capabilities),
    ...buildSelectedWorkbenchConnectorRegistryItems(snapshot, capabilities),
    ...buildSelectedWorkbenchMcpRegistryItems(snapshot, capabilities),
  ];
}

export function buildWorkbenchCapabilityRegistry(
  args: BuildWorkbenchCapabilityRegistryArgs,
): WorkbenchCapabilityRegistry {
  const baseCapabilities = buildWorkbenchCapabilities(args);
  return buildWorkbenchCapabilityRegistryFromCapabilities({
    ...baseCapabilities,
    connectors: withMissingConnectors(baseCapabilities.connectors, args.connectorStatuses),
    mcpServers: withMissingMcpServers(baseCapabilities.mcpServers, args.mcpServerStates),
  });
}

export function buildBlockedCapabilityReasonFromRegistryItem(
  capability: WorkbenchCapabilityRegistryItem,
): BlockedCapabilityReason | null {
  if (!capability.blockedReason) {
    return null;
  }

  return {
    kind: capability.kind,
    id: capability.id,
    label: capability.label,
    ...capability.blockedReason,
  };
}
