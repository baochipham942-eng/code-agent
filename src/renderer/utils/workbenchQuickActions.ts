import type { SettingsTab } from '../stores/appStore';
import type {
  WorkbenchCapabilityRegistryItem,
  WorkbenchConnectorRegistryItem,
  WorkbenchMcpRegistryItem,
  WorkbenchSkillRegistryItem,
} from './workbenchCapabilityRegistry';
import { getWorkbenchCapabilityBlockedState } from './workbenchCapabilityRegistry';

export type WorkbenchQuickActionKind =
  | 'mount_skill'
  | 'open_skill_settings'
  | 'retry_mcp'
  | 'open_mcp_settings'
  | 'retry_connector'
  | 'probe_connector'
  | 'repair_connector_permission'
  | 'disconnect_connector'
  | 'remove_connector'
  | 'open_connector_app'
  | 'open_connector_settings';

export interface WorkbenchQuickAction {
  kind: WorkbenchQuickActionKind;
  label: string;
  emphasis: 'primary' | 'secondary';
}

export interface WorkbenchQuickActionCompletion {
  kind: WorkbenchQuickActionKind;
  completedAt: number;
}

export interface WorkbenchQuickActionFeedback {
  tone: 'success' | 'info';
  message: string;
}

export interface WorkbenchQuickActionOptions {
  includeUnselected?: boolean;
}

export interface WorkbenchQuickActionHandlers {
  mountSkill: (skillName: string, libraryId: string) => Promise<boolean>;
  openSettingsTab: (tab: SettingsTab) => void;
  reconnectMcpServer: (serverName: string) => Promise<boolean>;
  refreshMcpStatus?: () => void | Promise<void>;
  retryConnector: (connectorId: string) => Promise<boolean>;
  probeConnector: (connectorId: string) => Promise<boolean>;
  repairConnectorPermission: (connectorId: string) => Promise<boolean>;
  disconnectConnector: (connectorId: string) => Promise<boolean>;
  removeConnector: (connectorId: string) => Promise<boolean>;
  openConnectorApp: (connectorId: string) => Promise<boolean>;
}

function buildSkillQuickActions(
  blockedReason: WorkbenchSkillRegistryItem['blockedReason'],
): WorkbenchQuickAction[] {
  switch (blockedReason?.code) {
    case 'skill_not_mounted':
      return [
        {
          kind: 'mount_skill',
          label: '挂载',
          emphasis: 'primary',
        },
      ];
    case 'skill_missing':
      return [
        {
          kind: 'open_skill_settings',
          label: '打开设置',
          emphasis: 'secondary',
        },
      ];
    default:
      return [];
  }
}

function connectorSupports(
  connector: WorkbenchConnectorRegistryItem,
  action: NonNullable<WorkbenchConnectorRegistryItem['actions']>[number],
): boolean {
  return !connector.actions || connector.actions.includes(action);
}

function buildConnectorLifecycleActions(
  connector: WorkbenchConnectorRegistryItem,
): WorkbenchQuickAction[] {
  const actions: WorkbenchQuickAction[] = [];

  if (connectorSupports(connector, 'disconnect')) {
    actions.push({
      kind: 'disconnect_connector',
      label: '断开',
      emphasis: 'secondary',
    });
  }

  if (connectorSupports(connector, 'remove')) {
    actions.push({
      kind: 'remove_connector',
      label: '移除',
      emphasis: 'secondary',
    });
  }

  return actions;
}

function buildConnectorQuickActions(
  connector: WorkbenchConnectorRegistryItem,
  blockedReason: WorkbenchConnectorRegistryItem['blockedReason'],
): WorkbenchQuickAction[] {
  if (connector.connected) {
    return buildConnectorLifecycleActions(connector);
  }

  if (blockedReason?.code === 'connector_unverified' || blockedReason?.code === 'connector_auth_failed') {
    return [
      {
        kind: 'repair_connector_permission',
        label: '修复权限',
        emphasis: 'primary',
      },
      {
        kind: 'open_connector_app',
        label: '打开本地应用',
        emphasis: 'secondary',
      },
      ...buildConnectorLifecycleActions(connector),
      {
        kind: 'open_connector_settings',
        label: '打开连接器设置',
        emphasis: 'secondary',
      },
    ];
  }

  if (blockedReason?.code !== 'connector_disconnected') {
    return [];
  }

  return [
    {
      kind: 'retry_connector',
      label: '启用/重试',
      emphasis: 'primary',
    },
    {
      kind: 'open_connector_app',
      label: '打开本地应用',
      emphasis: 'secondary',
    },
    {
      kind: 'open_connector_settings',
      label: '打开连接器设置',
      emphasis: 'secondary',
    },
  ];
}

function buildMcpQuickActions(
  blockedReason: WorkbenchMcpRegistryItem['blockedReason'],
): WorkbenchQuickAction[] {
  if (blockedReason?.code !== 'mcp_disconnected' && blockedReason?.code !== 'mcp_error') {
    return [];
  }

  return [
    {
      kind: 'retry_mcp',
      label: '重连',
      emphasis: 'primary',
    },
    {
      kind: 'open_mcp_settings',
      label: '打开设置',
      emphasis: 'secondary',
    },
  ];
}

export function getWorkbenchCapabilityQuickActions(
  capability: WorkbenchCapabilityRegistryItem,
  options?: WorkbenchQuickActionOptions,
): WorkbenchQuickAction[] {
  const blockedReason = getWorkbenchCapabilityBlockedState(capability);

  if (options?.includeUnselected) {
    if (capability.kind !== 'connector' && (capability.available || !blockedReason)) {
      return [];
    }
  } else if (!capability.selected || !capability.blocked || !blockedReason) {
    return [];
  }

  switch (capability.kind) {
    case 'skill':
      return buildSkillQuickActions(blockedReason);
    case 'connector':
      return buildConnectorQuickActions(capability, blockedReason);
    case 'mcp':
      return buildMcpQuickActions(blockedReason);
    default:
      return [];
  }
}

export function getWorkbenchCapabilityQuickActionFeedback(
  capability: WorkbenchCapabilityRegistryItem,
  completion?: WorkbenchQuickActionCompletion | null,
): WorkbenchQuickActionFeedback | null {
  if (completion?.kind === 'disconnect_connector') {
    return {
      tone: 'info',
      message: '已断开 connector；它不会进入后续运行时 scope。',
    };
  }

  if (completion?.kind === 'remove_connector') {
    return {
      tone: 'info',
      message: '已移除 connector；需要时可从连接器设置重新启用。',
    };
  }

  if (capability.available && !capability.blocked) {
    return {
      tone: 'success',
      message: '当前已修复，下条消息可用。',
    };
  }

  if (!completion) {
    return null;
  }

  switch (completion.kind) {
    case 'mount_skill':
      return {
        tone: 'info',
        message: '已尝试挂载；如果这项能力还没恢复，重新发送前再检查一次。',
      };
    case 'retry_mcp':
      return {
        tone: 'info',
        message: '已触发重连；如果还没恢复，去设置里看服务状态。',
      };
    case 'open_skill_settings':
      return {
        tone: 'info',
        message: '已打开 Skills 设置，修好后重发这条消息。',
      };
    case 'open_mcp_settings':
      return {
        tone: 'info',
        message: '已打开 MCP 设置，修好后重发这条消息。',
      };
    case 'retry_connector':
      return {
        tone: 'info',
        message: '已启用/刷新 connector；这只是启用，授权/可用性要再点"检查/授权"。',
      };
    case 'probe_connector':
      return {
        tone: 'info',
        message: '已触发授权/可用性检查；如果还没恢复，打开本地应用确认登录和系统授权。',
      };
    case 'repair_connector_permission':
      return {
        tone: 'info',
        message: '已触发权限修复；修复成功后，下条消息才会进入运行时 scope。',
      };
    case 'open_connector_app':
      return {
        tone: 'info',
        message: '已拉起本地应用；未启用时先点"启用/重试"，已启用后再点"检查/授权"。',
      };
    case 'open_connector_settings':
      return {
        tone: 'info',
        message: '已打开连接器设置，启用后回到能力详情再点"检查/授权"。',
      };
    default:
      return null;
  }
}

async function refreshMcpStatus(handlers: WorkbenchQuickActionHandlers): Promise<void> {
  if (!handlers.refreshMcpStatus) {
    return;
  }
  await handlers.refreshMcpStatus();
}

export async function runWorkbenchCapabilityQuickAction(
  capability: WorkbenchCapabilityRegistryItem,
  action: WorkbenchQuickAction,
  handlers: WorkbenchQuickActionHandlers,
): Promise<boolean> {
  switch (action.kind) {
    case 'mount_skill':
      if (capability.kind !== 'skill') {
        return false;
      }
      return handlers.mountSkill(capability.id, capability.libraryId || capability.source || 'unknown');
    case 'open_skill_settings':
      handlers.openSettingsTab('skills');
      return true;
    case 'retry_mcp':
      if (capability.kind !== 'mcp') {
        return false;
      }
      try {
        return await handlers.reconnectMcpServer(capability.id);
      } finally {
        await refreshMcpStatus(handlers);
      }
    case 'open_mcp_settings':
      handlers.openSettingsTab('mcp');
      return true;
    case 'retry_connector':
      if (capability.kind !== 'connector') {
        return false;
      }
      return handlers.retryConnector(capability.id);
    case 'probe_connector':
      if (capability.kind !== 'connector') {
        return false;
      }
      return handlers.probeConnector(capability.id);
    case 'repair_connector_permission':
      if (capability.kind !== 'connector') {
        return false;
      }
      return handlers.repairConnectorPermission(capability.id);
    case 'disconnect_connector':
      if (capability.kind !== 'connector') {
        return false;
      }
      return handlers.disconnectConnector(capability.id);
    case 'remove_connector':
      if (capability.kind !== 'connector') {
        return false;
      }
      return handlers.removeConnector(capability.id);
    case 'open_connector_app':
      if (capability.kind !== 'connector') {
        return false;
      }
      return handlers.openConnectorApp(capability.id);
    case 'open_connector_settings':
      if (capability.kind !== 'connector') {
        return false;
      }
      handlers.openSettingsTab('mcp');
      return true;
    default:
      return false;
  }
}
