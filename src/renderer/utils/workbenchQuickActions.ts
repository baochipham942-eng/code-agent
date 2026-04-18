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
  | 'open_mcp_settings';

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

function buildConnectorQuickActions(
  blockedReason: WorkbenchConnectorRegistryItem['blockedReason'],
): WorkbenchQuickAction[] {
  if (blockedReason?.code !== 'connector_disconnected') {
    return [];
  }

  return [];
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
    if (capability.available || !blockedReason) {
      return [];
    }
  } else if (!capability.selected || !capability.blocked || !blockedReason) {
    return [];
  }

  switch (capability.kind) {
    case 'skill':
      return buildSkillQuickActions(blockedReason);
    case 'connector':
      return buildConnectorQuickActions(blockedReason);
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
    default:
      return false;
  }
}
