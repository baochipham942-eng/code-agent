// ============================================================================
// Connector IPC Handlers - connector:* 通道
// ============================================================================

import { exec } from 'child_process';
import type { IpcMain, AppWindow } from '../platform';
import { broadcastToRenderer } from '../platform';
import {
  IPC_CHANNELS,
  IPC_DOMAINS,
  type IPCRequest,
  type IPCResponse,
  type ConnectorStatusSummary,
  type ConnectorEvent,
  type NativeConnectorInventoryItem,
} from '../../shared/ipc';
import { getConnectorRegistry } from '../connectors';
import { ConnectorAuth } from '../connectors/oauth/connectorAuth';
import { ConnectorOAuthStore } from '../connectors/oauth/connectorOAuthStore';
import { OAuthCoordinator } from '../connectors/oauth/oauthCoordinator';
import { FEISHU_OAUTH_DESCRIPTOR } from '../connectors/oauth/feishuOAuth';
import { createLarkCliDriver } from '../connectors/feishu/larkCli';
import type { ProviderDescriptor } from '../connectors/oauth/providerDescriptor';
import { NATIVE_CONNECTOR_IDS, type NativeConnectorId } from '../../shared/constants';
import type { ConfigService } from '../services';

// macOS native connector → host app 映射。Mail/Calendar/Reminders 走 open -a，
// 其他未来可接入 AppleScript 连接器可在这里扩展。
const CONNECTOR_NATIVE_APPS: Record<string, string> = {
  mail: 'Mail',
  calendar: 'Calendar',
  reminders: 'Reminders',
};

const NATIVE_CONNECTOR_LABELS: Record<NativeConnectorId, string> = {
  calendar: 'Calendar',
  mail: 'Mail',
  reminders: 'Reminders',
  photos: 'Photos',
};

const CONNECTOR_STATUS_POLL_MS = 15_000;
let connectorStatusWatchTimer: NodeJS.Timeout | null = null;
let lastConnectorStatusSnapshot = '';

function isNativeConnectorId(id: string | undefined): id is NativeConnectorId {
  return Boolean(id && (NATIVE_CONNECTOR_IDS as readonly string[]).includes(id));
}

export function getEnabledNativeConnectorIdsAfterRetry(args: {
  connectorId?: string;
  enabledNative: string[];
  registered: boolean;
}): string[] | null {
  if (!args.connectorId || args.registered || !isNativeConnectorId(args.connectorId)) {
    return null;
  }

  if (args.enabledNative.includes(args.connectorId)) {
    return [...args.enabledNative];
  }

  return [...args.enabledNative, args.connectorId];
}

export function getEnabledNativeConnectorIdsAfterDisconnect(args: {
  connectorId?: string;
  enabledNative: string[];
}): string[] | null {
  if (!isNativeConnectorId(args.connectorId)) {
    return null;
  }

  return args.enabledNative.filter((id) => id !== args.connectorId);
}

export function getEnabledNativeConnectorIdsAfterPermissionRepair(args: {
  connectorId?: string;
  enabledNative: string[];
}): string[] | null {
  if (!isNativeConnectorId(args.connectorId)) {
    return null;
  }

  if (args.enabledNative.includes(args.connectorId)) {
    return [...args.enabledNative];
  }

  return [...args.enabledNative, args.connectorId];
}

export function normalizeConnectorStatuses(statuses: ConnectorStatusSummary[]): ConnectorStatusSummary[] {
  return [...statuses]
    .map((status) => ({
      ...status,
      ...(status.actions ? { actions: [...status.actions].sort() } : {}),
      capabilities: [...status.capabilities].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function serializeConnectorStatuses(statuses: ConnectorStatusSummary[]): string {
  return JSON.stringify(normalizeConnectorStatuses(statuses));
}

async function handleListStatuses(): Promise<ConnectorStatusSummary[]> {
  const connectors = getConnectorRegistry().list();
  return Promise.all(connectors.map(async (connector) => {
    const status = await connector.getStatus();
    return {
      id: connector.id,
      label: connector.label,
      connected: status.connected,
      readiness: status.readiness,
      detail: status.detail,
      error: status.error,
      checkedAt: status.checkedAt,
      actions: status.actions,
      capabilities: status.capabilities,
    } satisfies ConnectorStatusSummary;
  }));
}

function readEnabledNative(getConfigService: () => ConfigService | null): string[] {
  const configService = getConfigService();
  if (!configService) return [];
  return configService.getSettings().connectors?.enabledNative ?? [];
}

async function persistEnabledNative(
  getConfigService: () => ConfigService | null,
  enabled: string[],
): Promise<void> {
  const configService = getConfigService();
  if (!configService) {
    throw new Error('Config service not initialized');
  }
  await configService.updateSettings({
    connectors: { enabledNative: enabled },
  });
}

function handleListNativeInventory(
  getConfigService: () => ConfigService | null,
): NativeConnectorInventoryItem[] {
  const enabled = new Set(readEnabledNative(getConfigService));
  // 经 registry 取平台可用集（非 macOS 为空），settings 不展示开了也无效的开关
  return getConnectorRegistry().listAvailableNativeIds().map((id) => ({
    id,
    label: NATIVE_CONNECTOR_LABELS[id],
    enabled: enabled.has(id),
  }));
}

async function handleSetNativeEnabled(
  getConfigService: () => ConfigService | null,
  payload: { id?: string; enabled?: boolean } | undefined,
  broadcast: () => Promise<void>,
): Promise<ConnectorStatusSummary[]> {
  const id = payload?.id;
  const enabled = Boolean(payload?.enabled);
  if (!id || !(NATIVE_CONNECTOR_IDS as readonly string[]).includes(id)) {
    throw new Error(`Unknown native connector id: ${id}`);
  }

  const current = new Set(readEnabledNative(getConfigService));
  if (enabled) {
    current.add(id);
  } else {
    current.delete(id);
  }
  const next = Array.from(current);
  await persistEnabledNative(getConfigService, next);
  getConnectorRegistry().configure(next);

  lastConnectorStatusSnapshot = '';
  await broadcast();
  return handleListStatuses();
}

async function handleRetryConnector(
  getConfigService: () => ConfigService | null,
  connectorId: string | undefined,
  broadcast: () => Promise<void>,
): Promise<ConnectorStatusSummary[]> {
  // 失效 broadcast 快照，强制下一次 poll 发事件；并立刻重新 listStatuses 回执
  lastConnectorStatusSnapshot = '';
  if (connectorId) {
    const connector = getConnectorRegistry().get(connectorId);
    const enabledAfterRetry = getEnabledNativeConnectorIdsAfterRetry({
      connectorId,
      enabledNative: readEnabledNative(getConfigService),
      registered: Boolean(connector),
    });

    if (enabledAfterRetry) {
      await persistEnabledNative(getConfigService, enabledAfterRetry);
      getConnectorRegistry().configure(enabledAfterRetry);
      await broadcast();
      return handleListStatuses();
    }

    if (!connector) {
      throw new Error(`Unknown connector: ${connectorId}`);
    }
  }
  return handleListStatuses();
}

async function handleProbeConnector(
  connectorId: string | undefined,
  broadcast: () => Promise<void>,
): Promise<ConnectorStatusSummary[]> {
  if (!connectorId) {
    throw new Error('connectorId is required');
  }

  const connector = getConnectorRegistry().get(connectorId);
  if (!connector) {
    throw new Error(`Unknown connector: ${connectorId}`);
  }

  try {
    await connector.execute('probe_access', {});
  } finally {
    lastConnectorStatusSnapshot = '';
    await broadcast();
  }

  return handleListStatuses();
}

async function handleDisconnectConnector(
  getConfigService: () => ConfigService | null,
  connectorId: string | undefined,
  broadcast: () => Promise<void>,
): Promise<ConnectorStatusSummary[]> {
  const next = getEnabledNativeConnectorIdsAfterDisconnect({
    connectorId,
    enabledNative: readEnabledNative(getConfigService),
  });

  if (!next) {
    throw new Error(`Unknown native connector id: ${connectorId}`);
  }

  const connector = getConnectorRegistry().get(connectorId!);
  if (connector) {
    await connector.execute('disconnect', {});
  }

  await persistEnabledNative(getConfigService, next);
  getConnectorRegistry().unregister(connectorId!);
  lastConnectorStatusSnapshot = '';
  await broadcast();
  return handleListStatuses();
}

async function handleRemoveConnector(
  getConfigService: () => ConfigService | null,
  connectorId: string | undefined,
  broadcast: () => Promise<void>,
): Promise<ConnectorStatusSummary[]> {
  const next = getEnabledNativeConnectorIdsAfterDisconnect({
    connectorId,
    enabledNative: readEnabledNative(getConfigService),
  });

  if (!next) {
    throw new Error(`Unknown native connector id: ${connectorId}`);
  }

  const connector = getConnectorRegistry().get(connectorId!);
  if (connector) {
    await connector.execute('remove', {});
  }

  await persistEnabledNative(getConfigService, next);
  getConnectorRegistry().unregister(connectorId!);
  lastConnectorStatusSnapshot = '';
  await broadcast();
  return handleListStatuses();
}

async function handleRepairConnectorPermission(
  getConfigService: () => ConfigService | null,
  connectorId: string | undefined,
  broadcast: () => Promise<void>,
): Promise<ConnectorStatusSummary[]> {
  const next = getEnabledNativeConnectorIdsAfterPermissionRepair({
    connectorId,
    enabledNative: readEnabledNative(getConfigService),
  });

  if (!next) {
    throw new Error(`Unknown native connector id: ${connectorId}`);
  }

  await persistEnabledNative(getConfigService, next);
  getConnectorRegistry().configure(next);

  const connector = getConnectorRegistry().get(connectorId!);
  if (!connector) {
    throw new Error(`Unknown connector: ${connectorId}`);
  }

  try {
    await connector.execute('repair_permissions', {});
  } finally {
    lastConnectorStatusSnapshot = '';
    await broadcast();
  }

  return handleListStatuses();
}

async function handleOpenConnectorApp(connectorId: string | undefined): Promise<{ opened: boolean; app?: string }> {
  if (!connectorId) {
    throw new Error('connectorId is required');
  }
  const appName = CONNECTOR_NATIVE_APPS[connectorId];
  if (!appName) {
    throw new Error(`Connector ${connectorId} has no native app mapping`);
  }
  if (process.platform !== 'darwin') {
    throw new Error(`open-a 仅支持 macOS，当前平台 ${process.platform}`);
  }
  await new Promise<void>((resolve, reject) => {
    exec(`open -a ${JSON.stringify(appName)}`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return { opened: true, app: appName };
}

// SaaS connector OAuth（N-SAAS-A2A 第一刀）。descriptor 一家一条，加一家只加一行，
// 流程代码不变。accountId 暂等于 providerId：本刀只支持每家一个账号，多账号是后续刀的事。
const OAUTH_PROVIDERS: Record<string, ProviderDescriptor> = {
  [FEISHU_OAUTH_DESCRIPTOR.id]: FEISHU_OAUTH_DESCRIPTOR,
};

const larkCli = createLarkCliDriver();

function requireOAuthProvider(providerId: string | undefined): ProviderDescriptor {
  const descriptor = providerId ? OAUTH_PROVIDERS[providerId] : undefined;
  if (!descriptor) {
    throw new Error(`Unknown OAuth connector provider: ${providerId}`);
  }
  return descriptor;
}

interface ConnectorOAuthProviderStatus {
  id: string;
  displayName: string;
  clientIdConfigured: boolean;
  // 这家要不要 App Secret，以及本机填没填 —— 界面靠这两个才能说清「还差什么」，
  // 而不是等用户点了连接再吃厂商一个 400。
  requiresClientSecret: boolean;
  clientSecretConfigured: boolean;
  connected: boolean;
  loopbackRedirectUriSupport: ProviderDescriptor['loopbackRedirectUriSupport'];
  authMode: 'oauth' | 'lark-cli';
}

async function listConnectorOAuthStatuses(): Promise<ConnectorOAuthProviderStatus[]> {
  return Promise.all(Object.values(OAUTH_PROVIDERS).map(async (descriptor) => {
    const authMode = descriptor.authMode ?? 'oauth';
    if (authMode === 'lark-cli') {
      const cliStatus = await larkCli.status();
      return {
        id: descriptor.id,
        displayName: descriptor.displayName,
        clientIdConfigured: true,
        requiresClientSecret: false,
        clientSecretConfigured: false,
        connected: cliStatus.connected,
        loopbackRedirectUriSupport: descriptor.loopbackRedirectUriSupport,
        authMode,
      };
    }
    return {
      id: descriptor.id,
      displayName: descriptor.displayName,
      clientIdConfigured: descriptor.clientId.trim().length > 0,
      requiresClientSecret: descriptor.requiresClientSecret,
      clientSecretConfigured: Boolean(new ConnectorOAuthStore(descriptor.id).clientSecret()),
      connected: Boolean(new ConnectorOAuthStore(descriptor.id).tokens()),
      loopbackRedirectUriSupport: descriptor.loopbackRedirectUriSupport,
      authMode,
    };
  }));
}

async function handleConnectorOAuthConnect(
  payload: { providerId?: string; action?: string } | undefined,
): Promise<ConnectorOAuthProviderStatus[]> {
  const descriptor = requireOAuthProvider(payload?.providerId);
  if (descriptor.authMode === 'lark-cli') {
    const { openExternal } = await import('../platform/nativeShell');
    await larkCli.connect(openExternal);
    return listConnectorOAuthStatuses();
  }
  const action = payload?.action ?? Object.keys(descriptor.scopes)[0];
  if (!action) {
    throw new Error(`OAuth connector provider ${descriptor.id} declares no writeback scope`);
  }

  // ponytail: 授权页本身就是用户在厂商侧的同意面，这里只负责把它打开；
  // 连接前的「要授哪些权限」摘要属于 UI 那一刀，不在本刀。
  const auth = new ConnectorAuth({
    coordinator: new OAuthCoordinator({
      openAuthorization: async (authUrl) => {
        const { openExternal } = await import('../platform/nativeShell');
        await openExternal(authUrl.toString());
      },
    }),
  });

  await auth.beginFlow({
    accountId: descriptor.id,
    accountLabel: descriptor.displayName,
    descriptor,
    action,
  });
  return listConnectorOAuthStatuses();
}

async function handleConnectorOAuthSetSecret(
  payload: { providerId?: string; clientSecret?: string } | undefined,
): Promise<ConnectorOAuthProviderStatus[]> {
  const descriptor = requireOAuthProvider(payload?.providerId);
  if (descriptor.authMode === 'lark-cli') {
    throw new Error('飞书官方 lark-cli 连接不需要 App Secret，不能在此保存');
  }
  const clientSecret = payload?.clientSecret;
  if (typeof clientSecret !== 'string' || !clientSecret.trim()) {
    throw new Error(`App Secret is required for ${descriptor.id}`);
  }
  new ConnectorOAuthStore(descriptor.id).saveClientSecret(clientSecret);
  return listConnectorOAuthStatuses();
}

async function handleConnectorOAuthDisconnect(
  payload: { providerId?: string } | undefined,
): Promise<ConnectorOAuthProviderStatus[]> {
  const descriptor = requireOAuthProvider(payload?.providerId);
  if (descriptor.authMode === 'lark-cli') {
    await larkCli.disconnect();
    return listConnectorOAuthStatuses();
  }
  new ConnectorOAuthStore(descriptor.id).invalidateCredentials('all');
  return listConnectorOAuthStatuses();
}

async function pollAndBroadcastConnectorStatuses(
  getMainWindow: () => AppWindow | null,
): Promise<void> {
  const statuses = await handleListStatuses();
  const nextSnapshot = serializeConnectorStatuses(statuses);
  if (nextSnapshot === lastConnectorStatusSnapshot) {
    return;
  }

  lastConnectorStatusSnapshot = nextSnapshot;
  const event: ConnectorEvent = {
    type: 'status_changed',
    data: statuses,
  };

  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.CONNECTOR_EVENT, event);
    return;
  }

  broadcastToRenderer(IPC_CHANNELS.CONNECTOR_EVENT, event);
}

function ensureConnectorStatusWatcher(
  getMainWindow: () => AppWindow | null,
): void {
  if (connectorStatusWatchTimer) {
    return;
  }

  void pollAndBroadcastConnectorStatuses(getMainWindow).catch(() => {});
  connectorStatusWatchTimer = setInterval(() => {
    void pollAndBroadcastConnectorStatuses(getMainWindow).catch(() => {});
  }, CONNECTOR_STATUS_POLL_MS);
  connectorStatusWatchTimer.unref?.();

  void import('../services/infra/gracefulShutdown')
    .then(({ onShutdown }) => {
      onShutdown('ipc/connector.statusWatcher', async () => {
        if (connectorStatusWatchTimer) {
          clearInterval(connectorStatusWatchTimer);
          connectorStatusWatchTimer = null;
        }
      });
    })
    .catch(() => { /* shutdown infra 不可用就靠 .unref() */ });
}

export function registerConnectorHandlers(
  ipcMain: IpcMain,
  getMainWindow: () => AppWindow | null,
  getConfigService: () => ConfigService | null,
): void {
  ensureConnectorStatusWatcher(getMainWindow);

  const broadcast = () => pollAndBroadcastConnectorStatuses(getMainWindow);

  ipcMain.handle(IPC_DOMAINS.CONNECTOR, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action } = request;

    try {
      let data: unknown;

      switch (action) {
        case 'listStatuses':
          data = await handleListStatuses();
          break;
        case 'listNativeInventory':
          data = handleListNativeInventory(getConfigService);
          break;
        case 'setNativeEnabled':
          data = await handleSetNativeEnabled(
            getConfigService,
            request.payload as { id?: string; enabled?: boolean } | undefined,
            broadcast,
          );
          break;
        case 'retry':
          data = await handleRetryConnector(
            getConfigService,
            (request.payload as { connectorId?: string } | undefined)?.connectorId,
            broadcast,
          );
          break;
        case 'probe':
          data = await handleProbeConnector(
            (request.payload as { connectorId?: string } | undefined)?.connectorId,
            broadcast,
          );
          break;
        case 'disconnect':
          data = await handleDisconnectConnector(
            getConfigService,
            (request.payload as { connectorId?: string } | undefined)?.connectorId,
            broadcast,
          );
          break;
        case 'remove':
          data = await handleRemoveConnector(
            getConfigService,
            (request.payload as { connectorId?: string } | undefined)?.connectorId,
            broadcast,
          );
          break;
        case 'repairPermission':
          data = await handleRepairConnectorPermission(
            getConfigService,
            (request.payload as { connectorId?: string } | undefined)?.connectorId,
            broadcast,
          );
          break;
        case 'oauthStatus':
          data = await listConnectorOAuthStatuses();
          break;
        case 'oauthConnect':
          data = await handleConnectorOAuthConnect(
            request.payload as { providerId?: string; action?: string } | undefined,
          );
          break;
        case 'oauthSetSecret':
          data = await handleConnectorOAuthSetSecret(
            request.payload as { providerId?: string; clientSecret?: string } | undefined,
          );
          break;
        case 'oauthDisconnect':
          data = await handleConnectorOAuthDisconnect(
            request.payload as { providerId?: string } | undefined,
          );
          break;
        case 'openApp':
          data = await handleOpenConnectorApp(
            (request.payload as { connectorId?: string } | undefined)?.connectorId,
          );
          break;
        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` } };
      }

      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) },
      };
    }
  });
}
