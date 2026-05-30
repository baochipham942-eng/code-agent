import type {
  CapabilityActionInfo,
  CapabilityCenterItem,
  CapabilityPermission,
  CapabilityRequirement,
  CapabilityRiskInfo,
  CapabilityRuntimeState,
  CapabilitySourceKind,
  CapabilityStateInfo,
} from '../../../shared/contract/capability';
import type {
  AgentEngineDescriptor,
  AgentEngineRuntimeState,
} from '../../../shared/contract/agentEngine';

export function buildAgentEngineCapabilityItem(descriptor: AgentEngineDescriptor): CapabilityCenterItem {
  const isNative = descriptor.kind === 'native';
  const executable = descriptor.capabilities.includes('execute') && descriptor.executable;
  const binaryStatus = descriptor.installState === 'missing'
    ? 'missing'
    : isNative
      ? 'not_applicable'
      : 'met';
  const launchMode = isNative ? 'builtin runtime' : 'external CLI';
  const workspacePolicy = descriptor.cwdPolicy === 'workspace_only'
    ? 'current workspace only'
    : descriptor.cwdPolicy;
  const detectedAt = new Date(descriptor.detectedAt).toISOString();
  const riskReasons = isNative
    ? ['使用 Neo 现有 provider、tools、permissions、trace 和 review queue']
    : [
        '外部 engine 只允许在当前 workspace cwd 内运行',
        ...(descriptor.auditNotes ?? []),
      ];

  return {
    id: encodeCapabilityId('agent-engine', descriptor.kind),
    kind: 'agent_engine',
    name: descriptor.label,
    summary: descriptor.summary,
    tags: [
      'agent-engine',
      descriptor.kind,
      descriptor.defaultPermissionProfile,
      descriptor.cwdPolicy,
      launchMode,
    ],
    source: {
      kind: isNative ? 'builtin' : 'runtime',
      label: sourceLabel(isNative ? 'builtin' : 'runtime'),
      path: descriptor.binaryPath,
      version: descriptor.version,
    },
    state: buildState({
      install: isNative
        ? 'not_applicable'
        : descriptor.installState === 'installed'
          ? 'installed'
          : 'missing',
      enable: 'not_applicable',
      runtime: runtimeFromEngineState(descriptor.runtimeState),
      statusLabel: executable
        ? '版本检测通过'
        : descriptor.installState === 'missing'
          ? '未安装'
          : '仅检测/导入',
      error: descriptor.lastError,
    }),
    risk: buildRisk(descriptor.riskTier, riskReasons, isNative
      ? ['Neo runtime']
      : ['当前 workspace cwd', '外部 CLI stdout/stderr/event stream']),
    permissions: [
      permission(
        isNative ? 'Native permission stack' : 'Read-only default',
        isNative ? 'medium' : 'low',
        isNative
          ? '使用 Neo 现有 provider、tools 和权限栈'
          : '当前版本外部 engine 手动选择后默认使用 read_only profile',
      ),
      permission('Workspace cwd guard', 'medium', '外部 engine 运行前会校验 cwd 必须落在当前 workspace 内'),
      permission('No implicit channel launch', 'medium', 'Channel 和 Automation 不能隐式触发外部 engine'),
    ],
    config: [
      requirement('binary', `${descriptor.label} binary`, binaryStatus, descriptor.binaryPath),
      requirement('account', `${descriptor.label} login`, isNative ? 'not_applicable' : 'unknown'),
      requirement('config', 'Launch mode', 'met', launchMode),
      requirement('config', 'Permission profile', 'met', descriptor.defaultPermissionProfile),
      requirement('config', 'Workspace policy', 'met', workspacePolicy),
    ],
    dependencies: [],
    audit: {
      installedFiles: descriptor.binaryPath ? [descriptor.binaryPath] : [],
      notes: [
        `command: ${descriptor.command ?? 'builtin'}`,
        `cwd policy: ${descriptor.cwdPolicy}`,
        `detected at: ${detectedAt}`,
        descriptor.version ? `version: ${descriptor.version}` : undefined,
        ...(descriptor.auditNotes ?? []),
      ].filter((entry): entry is string => Boolean(entry)),
    },
    actions: buildAction(false, 'Agent Engine 的检测、启用和执行入口分开管理'),
    metrics: {
      tools: descriptor.capabilities.length,
    },
  };
}

function encodeCapabilityId(prefix: string, rawId: string): string {
  return `${prefix}:${encodeURIComponent(rawId)}`;
}

function sourceLabel(kind: CapabilitySourceKind): string {
  switch (kind) {
    case 'builtin':
      return '内置';
    case 'runtime':
      return '运行时';
    default:
      return '本地';
  }
}

function buildAction(canToggle: boolean, reason?: string): CapabilityActionInfo {
  return {
    canEnable: canToggle,
    canDisable: canToggle,
    ...(reason ? { reason } : {}),
  };
}

function buildState(args: {
  install?: CapabilityStateInfo['install'];
  enable?: CapabilityStateInfo['enable'];
  runtime?: CapabilityRuntimeState;
  statusLabel?: string;
  error?: string;
}): CapabilityStateInfo {
  return {
    install: args.install ?? 'installed',
    enable: args.enable ?? 'enabled',
    runtime: args.runtime ?? 'ready',
    mount: 'not_applicable',
    ...(args.statusLabel ? { statusLabel: args.statusLabel } : {}),
    ...(args.error ? { error: args.error } : {}),
  };
}

function buildRisk(tier: CapabilityRiskInfo['tier'], reasons: string[], dataTouched?: string[]): CapabilityRiskInfo {
  return {
    tier,
    reasons,
    ...(dataTouched?.length ? { dataTouched } : {}),
  };
}

function permission(label: string, level: CapabilityPermission['level'], detail?: string): CapabilityPermission {
  return {
    label,
    level,
    ...(detail ? { detail } : {}),
  };
}

function requirement(
  kind: CapabilityRequirement['kind'],
  label: string,
  status: CapabilityRequirement['status'],
  value?: string,
  sensitive = false,
): CapabilityRequirement {
  return {
    kind,
    label,
    status,
    ...(value ? { value } : {}),
    ...(sensitive ? { sensitive } : {}),
  };
}

function runtimeFromEngineState(state: AgentEngineRuntimeState): CapabilityRuntimeState {
  switch (state) {
    case 'ready':
    case 'not_configured':
    case 'blocked':
    case 'error':
    case 'unknown':
      return state;
    default:
      return 'unknown';
  }
}
