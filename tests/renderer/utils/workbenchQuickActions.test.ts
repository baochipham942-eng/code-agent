import { describe, expect, it, vi } from 'vitest';
import {
  getWorkbenchCapabilityQuickActionFeedback,
  getWorkbenchCapabilityQuickActions,
  runWorkbenchCapabilityQuickAction,
} from '../../../src/renderer/utils/workbenchQuickActions';

describe('workbenchQuickActions', () => {
  it('builds the shortest-path quick actions for blocked capabilities', () => {
    const skillActions = getWorkbenchCapabilityQuickActions({
      kind: 'skill',
      key: 'skill:draft-skill',
      id: 'draft-skill',
      label: 'draft-skill',
      selected: true,
      mounted: false,
      installState: 'available',
      description: 'Draft release notes',
      source: 'community',
      libraryId: 'community',
      available: false,
      blocked: true,
      visibleInWorkbench: true,
      health: 'inactive',
      lifecycle: {
        installState: 'installed',
        mountState: 'unmounted',
        connectionState: 'not_applicable',
      },
      blockedReason: {
        code: 'skill_not_mounted',
        detail: 'not mounted',
        hint: 'mount it first',
        severity: 'warning',
      },
    });
    const connectorActions = getWorkbenchCapabilityQuickActions({
      kind: 'connector',
      key: 'connector:calendar',
      id: 'calendar',
      label: 'Calendar',
      selected: true,
      connected: false,
      detail: 'offline',
      capabilities: ['list_events'],
      available: false,
      blocked: true,
      visibleInWorkbench: true,
      health: 'inactive',
      lifecycle: {
        installState: 'not_applicable',
        mountState: 'not_applicable',
        connectionState: 'disconnected',
      },
      blockedReason: {
        code: 'connector_disconnected',
        detail: 'connector disconnected',
        hint: 'open settings',
        severity: 'warning',
      },
    });
    const mcpActions = getWorkbenchCapabilityQuickActions({
      kind: 'mcp',
      key: 'mcp:slack',
      id: 'slack',
      label: 'slack',
      selected: true,
      status: 'error',
      enabled: true,
      transport: 'stdio',
      toolCount: 0,
      resourceCount: 0,
      error: 'handshake failed',
      available: false,
      blocked: true,
      visibleInWorkbench: true,
      health: 'error',
      lifecycle: {
        installState: 'not_applicable',
        mountState: 'not_applicable',
        connectionState: 'error',
      },
      blockedReason: {
        code: 'mcp_error',
        detail: 'mcp error',
        hint: 'retry it',
        severity: 'error',
      },
    });

    expect(skillActions.map((action) => action.kind)).toEqual(['mount_skill']);
    expect(connectorActions.map((action) => action.kind)).toEqual([
      'retry_connector',
      'open_connector_app',
      'open_connector_settings',
    ]);
    expect(mcpActions.map((action) => action.kind)).toEqual(['retry_mcp', 'open_mcp_settings']);
  });

  it('separates native connector enable from explicit authorization check', () => {
    const actions = getWorkbenchCapabilityQuickActions({
      kind: 'connector',
      key: 'connector:calendar',
      id: 'calendar',
      label: 'Calendar',
      selected: true,
      connected: false,
      readiness: 'unchecked',
      detail: 'needs authorization check',
      capabilities: ['list_events'],
      available: false,
      blocked: true,
      visibleInWorkbench: true,
      health: 'degraded',
      lifecycle: {
        installState: 'not_applicable',
        mountState: 'not_applicable',
        connectionState: 'lazy',
      },
      blockedReason: {
        code: 'connector_unverified',
        detail: 'connector needs authorization check',
        hint: 'probe it first',
        severity: 'warning',
      },
    });

    expect(actions.map((action) => action.kind)).toEqual([
      'repair_connector_permission',
      'open_connector_app',
      'disconnect_connector',
      'remove_connector',
      'open_connector_settings',
    ]);
    expect(actions[0]).toMatchObject({
      label: '修复权限',
      emphasis: 'primary',
    });
  });

  it('allows the sheet to expose one-step actions for unavailable capabilities even before they are selected', () => {
    const sheetActions = getWorkbenchCapabilityQuickActions({
      kind: 'skill',
      key: 'skill:draft-skill',
      id: 'draft-skill',
      label: 'draft-skill',
      selected: false,
      mounted: false,
      installState: 'available',
      description: 'Draft release notes',
      source: 'community',
      libraryId: 'community',
      available: false,
      blocked: false,
      visibleInWorkbench: false,
      health: 'inactive',
      lifecycle: {
        installState: 'installed',
        mountState: 'unmounted',
        connectionState: 'not_applicable',
      },
    }, {
      includeUnselected: true,
    });

    const inlineActions = getWorkbenchCapabilityQuickActions({
      kind: 'skill',
      key: 'skill:draft-skill',
      id: 'draft-skill',
      label: 'draft-skill',
      selected: false,
      mounted: false,
      installState: 'available',
      description: 'Draft release notes',
      source: 'community',
      libraryId: 'community',
      available: false,
      blocked: false,
      visibleInWorkbench: false,
      health: 'inactive',
      lifecycle: {
        installState: 'installed',
        mountState: 'unmounted',
        connectionState: 'not_applicable',
      },
    });

    expect(sheetActions.map((action) => action.kind)).toEqual(['mount_skill']);
    expect(inlineActions).toEqual([]);
  });

  it('routes quick action execution to the existing mount and MCP handlers', async () => {
    const mountSkill = vi.fn().mockResolvedValue(true);
    const openSettingsTab = vi.fn();
    const reconnectMcpServer = vi.fn().mockResolvedValue(true);
    const refreshMcpStatus = vi.fn();
    const retryConnector = vi.fn().mockResolvedValue(true);
    const probeConnector = vi.fn().mockResolvedValue(true);
    const repairConnectorPermission = vi.fn().mockResolvedValue(true);
    const disconnectConnector = vi.fn().mockResolvedValue(true);
    const removeConnector = vi.fn().mockResolvedValue(true);
    const openConnectorApp = vi.fn().mockResolvedValue(true);

    const mounted = await runWorkbenchCapabilityQuickAction({
      kind: 'skill',
      key: 'skill:draft-skill',
      id: 'draft-skill',
      label: 'draft-skill',
      selected: true,
      mounted: false,
      installState: 'available',
      description: 'Draft release notes',
      source: 'community',
      libraryId: 'community',
      available: false,
      blocked: true,
      visibleInWorkbench: true,
      health: 'inactive',
      lifecycle: {
        installState: 'installed',
        mountState: 'unmounted',
        connectionState: 'not_applicable',
      },
      blockedReason: {
        code: 'skill_not_mounted',
        detail: 'not mounted',
        hint: 'mount it first',
        severity: 'warning',
      },
    }, {
      kind: 'mount_skill',
      label: '挂载',
      emphasis: 'primary',
    }, {
      mountSkill,
      openSettingsTab,
      reconnectMcpServer,
      refreshMcpStatus,
      retryConnector,
      probeConnector,
      repairConnectorPermission,
      disconnectConnector,
      removeConnector,
      openConnectorApp,
    });

    const retried = await runWorkbenchCapabilityQuickAction({
      kind: 'mcp',
      key: 'mcp:slack',
      id: 'slack',
      label: 'slack',
      selected: true,
      status: 'disconnected',
      enabled: true,
      transport: 'stdio',
      toolCount: 0,
      resourceCount: 0,
      error: undefined,
      available: false,
      blocked: true,
      visibleInWorkbench: true,
      health: 'inactive',
      lifecycle: {
        installState: 'not_applicable',
        mountState: 'not_applicable',
        connectionState: 'disconnected',
      },
      blockedReason: {
        code: 'mcp_disconnected',
        detail: 'mcp disconnected',
        hint: 'retry it',
        severity: 'warning',
      },
    }, {
      kind: 'retry_mcp',
      label: '重连',
      emphasis: 'primary',
    }, {
      mountSkill,
      openSettingsTab,
      reconnectMcpServer,
      refreshMcpStatus,
      retryConnector,
      probeConnector,
      repairConnectorPermission,
      disconnectConnector,
      removeConnector,
      openConnectorApp,
    });

    const connectorRetried = await runWorkbenchCapabilityQuickAction({
      kind: 'connector',
      key: 'connector:calendar',
      id: 'calendar',
      label: 'Calendar',
      selected: true,
      connected: false,
      detail: 'offline',
      capabilities: ['list_events'],
      available: false,
      blocked: true,
      visibleInWorkbench: true,
      health: 'inactive',
      lifecycle: {
        installState: 'not_applicable',
        mountState: 'not_applicable',
        connectionState: 'disconnected',
      },
      blockedReason: {
        code: 'connector_disconnected',
        detail: 'connector disconnected',
        hint: 'retry',
        severity: 'warning',
      },
    }, {
      kind: 'retry_connector',
      label: '启用/重试',
      emphasis: 'primary',
    }, {
      mountSkill,
      openSettingsTab,
      reconnectMcpServer,
      refreshMcpStatus,
      retryConnector,
      probeConnector,
      repairConnectorPermission,
      disconnectConnector,
      removeConnector,
      openConnectorApp,
    });

    const connectorProbed = await runWorkbenchCapabilityQuickAction({
      kind: 'connector',
      key: 'connector:calendar',
      id: 'calendar',
      label: 'Calendar',
      selected: true,
      connected: false,
      readiness: 'unchecked',
      detail: 'unchecked',
      capabilities: ['list_events'],
      available: false,
      blocked: true,
      visibleInWorkbench: true,
      health: 'degraded',
      lifecycle: {
        installState: 'not_applicable',
        mountState: 'not_applicable',
        connectionState: 'lazy',
      },
      blockedReason: {
        code: 'connector_unverified',
        detail: 'connector needs check',
        hint: 'probe',
        severity: 'warning',
      },
    }, {
      kind: 'probe_connector',
      label: '检查/授权',
      emphasis: 'primary',
    }, {
      mountSkill,
      openSettingsTab,
      reconnectMcpServer,
      refreshMcpStatus,
      retryConnector,
      probeConnector,
      repairConnectorPermission,
      disconnectConnector,
      removeConnector,
      openConnectorApp,
    });

    const connectorPermissionRepaired = await runWorkbenchCapabilityQuickAction({
      kind: 'connector',
      key: 'connector:calendar',
      id: 'calendar',
      label: 'Calendar',
      selected: true,
      connected: false,
      readiness: 'failed',
      detail: 'failed',
      error: 'not authorized',
      capabilities: ['list_events'],
      available: false,
      blocked: true,
      visibleInWorkbench: true,
      health: 'error',
      lifecycle: {
        installState: 'not_applicable',
        mountState: 'not_applicable',
        connectionState: 'error',
      },
      blockedReason: {
        code: 'connector_auth_failed',
        detail: 'connector auth failed',
        hint: 'repair',
        severity: 'error',
      },
    }, {
      kind: 'repair_connector_permission',
      label: '修复权限',
      emphasis: 'primary',
    }, {
      mountSkill,
      openSettingsTab,
      reconnectMcpServer,
      refreshMcpStatus,
      retryConnector,
      probeConnector,
      repairConnectorPermission,
      disconnectConnector,
      removeConnector,
      openConnectorApp,
    });

    const connectorDisconnected = await runWorkbenchCapabilityQuickAction({
      kind: 'connector',
      key: 'connector:calendar',
      id: 'calendar',
      label: 'Calendar',
      selected: true,
      connected: true,
      readiness: 'ready',
      detail: 'ready',
      actions: ['disconnect', 'remove'],
      capabilities: ['list_events'],
      available: true,
      blocked: false,
      visibleInWorkbench: true,
      health: 'healthy',
      lifecycle: {
        installState: 'not_applicable',
        mountState: 'not_applicable',
        connectionState: 'connected',
      },
    }, {
      kind: 'disconnect_connector',
      label: '断开',
      emphasis: 'secondary',
    }, {
      mountSkill,
      openSettingsTab,
      reconnectMcpServer,
      refreshMcpStatus,
      retryConnector,
      probeConnector,
      repairConnectorPermission,
      disconnectConnector,
      removeConnector,
      openConnectorApp,
    });

    const connectorRemoved = await runWorkbenchCapabilityQuickAction({
      kind: 'connector',
      key: 'connector:calendar',
      id: 'calendar',
      label: 'Calendar',
      selected: true,
      connected: true,
      readiness: 'ready',
      detail: 'ready',
      actions: ['disconnect', 'remove'],
      capabilities: ['list_events'],
      available: true,
      blocked: false,
      visibleInWorkbench: true,
      health: 'healthy',
      lifecycle: {
        installState: 'not_applicable',
        mountState: 'not_applicable',
        connectionState: 'connected',
      },
    }, {
      kind: 'remove_connector',
      label: '移除',
      emphasis: 'secondary',
    }, {
      mountSkill,
      openSettingsTab,
      reconnectMcpServer,
      refreshMcpStatus,
      retryConnector,
      probeConnector,
      repairConnectorPermission,
      disconnectConnector,
      removeConnector,
      openConnectorApp,
    });

    expect(mounted).toBe(true);
    expect(retried).toBe(true);
    expect(connectorRetried).toBe(true);
    expect(connectorProbed).toBe(true);
    expect(connectorPermissionRepaired).toBe(true);
    expect(connectorDisconnected).toBe(true);
    expect(connectorRemoved).toBe(true);
    expect(mountSkill).toHaveBeenCalledWith('draft-skill', 'community');
    expect(reconnectMcpServer).toHaveBeenCalledWith('slack');
    expect(refreshMcpStatus).toHaveBeenCalledTimes(1);
    expect(retryConnector).toHaveBeenCalledWith('calendar');
    expect(probeConnector).toHaveBeenCalledWith('calendar');
    expect(repairConnectorPermission).toHaveBeenCalledWith('calendar');
    expect(disconnectConnector).toHaveBeenCalledWith('calendar');
    expect(removeConnector).toHaveBeenCalledWith('calendar');
  });

  it('routes connector settings quick action to MCP settings', async () => {
    const openSettingsTab = vi.fn();
    const completed = await runWorkbenchCapabilityQuickAction({
      kind: 'connector',
      key: 'connector:calendar',
      id: 'calendar',
      label: 'Calendar',
      selected: true,
      connected: false,
      detail: 'offline',
      capabilities: ['list_events'],
      available: false,
      blocked: true,
      visibleInWorkbench: true,
      health: 'inactive',
      lifecycle: {
        installState: 'not_applicable',
        mountState: 'not_applicable',
        connectionState: 'disconnected',
      },
      blockedReason: {
        code: 'connector_disconnected',
        detail: 'connector disconnected',
        hint: 'retry',
        severity: 'warning',
      },
    }, {
      kind: 'open_connector_settings',
      label: '打开连接器设置',
      emphasis: 'secondary',
    }, {
      mountSkill: vi.fn(),
      openSettingsTab,
      reconnectMcpServer: vi.fn(),
      retryConnector: vi.fn(),
      probeConnector: vi.fn(),
      repairConnectorPermission: vi.fn(),
      disconnectConnector: vi.fn(),
      removeConnector: vi.fn(),
      openConnectorApp: vi.fn(),
    });

    expect(completed).toBe(true);
    expect(openSettingsTab).toHaveBeenCalledWith('mcp');
  });

  it('builds post-action feedback for repaired and settings-routed capabilities', () => {
    expect(getWorkbenchCapabilityQuickActionFeedback({
      kind: 'skill',
      key: 'skill:review-skill',
      id: 'review-skill',
      label: 'review-skill',
      selected: true,
      mounted: true,
      installState: 'mounted',
      description: 'Review code changes',
      source: 'library',
      libraryId: 'core',
      available: true,
      blocked: false,
      visibleInWorkbench: true,
      health: 'healthy',
      lifecycle: {
        installState: 'installed',
        mountState: 'mounted',
        connectionState: 'not_applicable',
      },
    }, {
      kind: 'mount_skill',
      completedAt: 1,
    })).toEqual({
      tone: 'success',
      message: '当前已修复，下条消息可用。',
    });

    expect(getWorkbenchCapabilityQuickActionFeedback({
      kind: 'connector',
      key: 'connector:calendar',
      id: 'calendar',
      label: 'Calendar',
      selected: true,
      connected: false,
      detail: 'offline',
      capabilities: ['list_events'],
      available: false,
      blocked: true,
      visibleInWorkbench: true,
      health: 'inactive',
      lifecycle: {
        installState: 'not_applicable',
        mountState: 'not_applicable',
        connectionState: 'disconnected',
      },
      blockedReason: {
        code: 'connector_disconnected',
        detail: 'connector disconnected',
        hint: '当前没有一键连接入口，先在本地应用里完成授权/可用性检查，再重新发送。',
        severity: 'warning',
      },
    }, null)).toBeNull();

    expect(getWorkbenchCapabilityQuickActionFeedback({
      kind: 'connector',
      key: 'connector:calendar',
      id: 'calendar',
      label: 'Calendar',
      selected: true,
      connected: true,
      readiness: 'ready',
      detail: 'ready',
      actions: ['disconnect', 'remove'],
      capabilities: ['list_events'],
      available: true,
      blocked: false,
      visibleInWorkbench: true,
      health: 'healthy',
      lifecycle: {
        installState: 'not_applicable',
        mountState: 'not_applicable',
        connectionState: 'connected',
      },
    }, {
      kind: 'disconnect_connector',
      completedAt: 2,
    })).toEqual({
      tone: 'info',
      message: '已断开 connector；它不会进入后续运行时 scope。',
    });
  });
});
