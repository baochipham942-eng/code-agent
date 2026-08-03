// ============================================================================
// MCP IPC Handlers - mcp:* 通道
// ============================================================================

import fs from 'fs/promises';
import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import {
  getMCPClient,
  isHttpStreamableConfig,
  refreshMCPServersFromCloud,
  type MCPServerConfig,
  type MCPServerState,
} from '../mcp/mcpClient';
import { McpOAuthProvider } from '../mcp/mcpOAuthProvider';
import { getMcpOAuthCoordinator } from '../mcp/mcpOAuthCoordinator';
import {
  ensureConfigDir,
  ensureUserConfigDir,
  getMcpConfigPath,
  getMcpScopedConfigPaths,
  pathExists,
} from '../config';
import { getContextHealthService } from '../context/contextHealthService';
import { getCloudConfigService } from '../services/cloud';
import { getConfigService } from '../services/core/configService';
import { getSecureStorage } from '../services/core/secureStorage';
import { extractSecrets } from '../mcp/secretRef';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('MCP.ipc');
const activeMcpInstalls = new Map<string, AbortController>();

class McpInstallInProgressError extends Error {
  readonly code = 'INSTALL_IN_PROGRESS';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function runMcpInstall<T>(
  serverName: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (activeMcpInstalls.has(serverName)) {
    return Promise.reject(new McpInstallInProgressError(
      `MCP server "${serverName}" installation is already in progress`,
    ));
  }
  const controller = new AbortController();
  activeMcpInstalls.set(serverName, controller);
  return operation(controller.signal).finally(() => {
    if (activeMcpInstalls.get(serverName) === controller) {
      activeMcpInstalls.delete(serverName);
    }
  });
}

const BLOCKED_STDIO_COMMANDS = new Set([
  'rm',
  'sudo',
  'chmod',
  'chown',
  'kill',
  'killall',
  'shutdown',
  'reboot',
  'dd',
  'mkfs',
  'fdisk',
  'mount',
  'umount',
]);

interface RegisterMcpHandlersOptions {
  getWorkingDirectory?: () => string | undefined;
}

type McpServerStateSummary = MCPServerState & {
  authMode?: 'oauth';
  hasOAuthTokens?: boolean;
};

type McpSettingsServerScope = 'user' | 'project';
type McpSettingsConfigKey = 'servers' | 'mcpServers';

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a string array`);
  }
  const result: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string') {
      throw new Error(`${label} must be a string array`);
    }
    const trimmed = entry.trim();
    if (trimmed) {
      result.push(trimmed);
    }
  }
  return result;
}

function optionalStringMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, label);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string') {
      throw new Error(`${label}.${key} must be a string`);
    }
    if (key.trim() && entry.trim()) {
      result[key.trim()] = entry.trim();
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function readMcpSettingsServerScope(value: unknown): McpSettingsServerScope {
  if (value === undefined) return 'project';
  if (value === 'user' || value === 'project') return value;
  throw new Error("scope must be 'user' or 'project'");
}

function readRequiredString(record: Record<string, unknown>, key: string, message: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(message);
  }
  return value.trim();
}

function validateServerName(name: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('Server name can only contain letters, numbers, dashes, and underscores');
  }
}

function validateStdioCommand(command: string): void {
  const normalized = command.toLowerCase().trim();
  const commandName = normalized.split(/[\s/]/).pop() || '';
  if (BLOCKED_STDIO_COMMANDS.has(commandName)) {
    throw new Error(`Command '${commandName}' is not allowed for MCP servers`);
  }
}

function validateHttpUrl(serverUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new Error('Invalid URL format');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Invalid protocol: ${parsed.protocol}. Only http:// and https:// are allowed.`);
  }
}

function createOAuthManagementProvider(serverName: string, serverIdentity: string): McpOAuthProvider {
  return new McpOAuthProvider({
    serverIdentity,
    serverName,
    redirectUrl: () => 'http://127.0.0.1/oauth-management',
    state: () => 'oauth-management',
    onRedirectToAuthorization: () => {
      throw new Error('OAuth management provider cannot start authorization');
    },
  });
}

function getOAuthProviderForState(state: MCPServerState): McpOAuthProvider | undefined {
  if (!isHttpStreamableConfig(state.config) || state.config.auth !== 'oauth') {
    return undefined;
  }
  const serverIdentity = getMCPClient().getServerIdentity(state.config.name);
  if (!serverIdentity) {
    return undefined;
  }
  return createOAuthManagementProvider(state.config.name, serverIdentity);
}

function summarizeMcpServerState(state: MCPServerState): McpServerStateSummary {
  const oauthProvider = getOAuthProviderForState(state);
  if (!oauthProvider) {
    return state;
  }

  return {
    ...state,
    authMode: 'oauth',
    hasOAuthTokens: Boolean(oauthProvider.tokens()),
  };
}

export function normalizeMcpSettingsServerConfig(input: unknown): MCPServerConfig {
  const config = asRecord(input, 'config');
  const name = readRequiredString(config, 'name', 'Server name is required');
  validateServerName(name);

  const type = readRequiredString(config, 'type', 'Server type is required');
  if (type === 'stdio') {
    const command = readRequiredString(config, 'command', 'command is required for stdio MCP servers');
    validateStdioCommand(command);
    return {
      name,
      type: 'stdio',
      command,
      args: optionalStringArray(config.args, 'args') || [],
      env: optionalStringMap(config.env, 'env') || {},
      enabled: false,
      lazyLoad: true,
    };
  }

  if (type === 'sse' || type === 'http') {
    const serverUrl = readRequiredString(
      config,
      'url',
      'url is required for remote MCP servers',
    );
    validateHttpUrl(serverUrl);
    const headers = optionalStringMap(config.headers, 'headers');
    const auth = typeof config.auth === 'string' ? config.auth.trim() : undefined;
    if (auth && (type !== 'http' || auth !== 'oauth')) {
      throw new Error("auth must be 'oauth' for http MCP servers");
    }
    if (type === 'sse') {
      const serverConfig = {
        name,
        type: 'sse' as const,
        serverUrl,
        enabled: false,
      };
      return headers ? { ...serverConfig, headers } : serverConfig;
    }
    const serverConfig = {
      name,
      type: 'http-streamable' as const,
      serverUrl,
      enabled: false,
      ...(auth === 'oauth' ? { auth: 'oauth' as const } : {}),
    };
    return headers ? { ...serverConfig, headers } : serverConfig;
  }

  throw new Error(`Unsupported MCP server type: ${type}`);
}

export async function persistMcpSettingsServerConfig(
  workingDirectory: string,
  serverConfig: MCPServerConfig,
): Promise<{ filePath: string }> {
  const mcpPaths = getMcpConfigPath(workingDirectory);
  const [newExists, legacyExists] = await Promise.all([
    pathExists(mcpPaths.new),
    pathExists(mcpPaths.legacy),
  ]);

  let configPath: string;
  let configKey: McpSettingsConfigKey;

  if (newExists) {
    configPath = mcpPaths.new;
    configKey = 'servers';
  } else if (legacyExists) {
    configPath = mcpPaths.legacy;
    configKey = 'mcpServers';
  } else {
    await ensureConfigDir(workingDirectory);
    configPath = mcpPaths.new;
    configKey = 'servers';
  }

  return persistMcpServerConfigToPath(configPath, configKey, serverConfig);
}

export async function persistMcpServerConfigToPath(
  configPath: string,
  configKey: McpSettingsConfigKey,
  serverConfig: MCPServerConfig,
): Promise<{ filePath: string }> {
  let config: Record<string, unknown>;
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    config = JSON.parse(content) as Record<string, unknown>;
  } catch {
    config = {};
  }

  const servers = Array.isArray(config[configKey])
    ? [...(config[configKey] as MCPServerConfig[])]
    : [];
  if (servers.some((server) => server.name === serverConfig.name)) {
    throw new Error(`MCP server "${serverConfig.name}" already exists`);
  }

  servers.push(serverConfig);
  config[configKey] = servers;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  return { filePath: configPath };
}

async function persistUserMcpSettingsServerConfig(
  serverConfig: MCPServerConfig,
): Promise<{ filePath: string }> {
  const configPath = getMcpScopedConfigPaths().user;
  await ensureUserConfigDir();
  return persistMcpServerConfigToPath(configPath, 'servers', serverConfig);
}

/**
 * 把「启用/禁用」持久化到承载该 server 的 scoped 配置文件。
 * setServerEnabled 只改内存，不落盘，重启后读回旧 enabled 值——飞书连接器启用后重启
 * 变回 disabled、报 Tool not found（真机 dogfood 2026-07-24 实证）就是这个断链。
 * 扫 user（连接器默认落这，见 ADR-051）+ 可选 project/local，命中即改 enabled 字段回写。
 * 返回是否在任一文件里改到（builtin/cloud server 不在文件里，返回 false 不算错）。
 */
export async function updateMcpServerEnabledInConfigFiles(
  serverName: string,
  enabled: boolean,
  workingDirectory?: string,
): Promise<boolean> {
  const paths = getMcpScopedConfigPaths(workingDirectory);
  const candidates = [paths.user, paths.project, paths.local].filter(
    (p): p is string => Boolean(p),
  );
  let updated = false;
  for (const configPath of candidates) {
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(await fs.readFile(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      continue; // 文件不存在/不可读/非法 JSON → 跳过该 scope
    }
    let dirty = false;
    for (const key of ['servers', 'mcpServers'] as const) {
      const servers = config[key];
      if (!Array.isArray(servers)) continue;
      for (const server of servers) {
        if (server && typeof server === 'object' && (server as { name?: unknown }).name === serverName) {
          updated = true;
          if ((server as { enabled?: unknown }).enabled !== enabled) {
            (server as { enabled?: boolean }).enabled = enabled;
            dirty = true;
          }
        }
      }
    }
    if (dirty) {
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    }
  }
  return updated;
}

export async function removeMcpSettingsServerDraftConfig(
  workingDirectory: string,
  serverName: string,
  capabilityId: string,
): Promise<{ filePath: string }> {
  const mcpPaths = getMcpConfigPath(workingDirectory);
  const candidates: Array<{ filePath: string; configKey: 'servers' | 'mcpServers' }> = [
    { filePath: mcpPaths.new, configKey: 'servers' },
    { filePath: mcpPaths.legacy, configKey: 'mcpServers' },
  ];

  for (const candidate of candidates) {
    if (!await pathExists(candidate.filePath)) {
      continue;
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(await fs.readFile(candidate.filePath, 'utf-8')) as Record<string, unknown>;
    } catch {
      continue;
    }

    const servers = Array.isArray(config[candidate.configKey])
      ? [...(config[candidate.configKey] as MCPServerConfig[])]
      : [];
    const index = servers.findIndex((server) => {
      return server.name === serverName
        && server.enabled === false
        && server.capabilityDraft?.origin === 'capability_center'
        && server.capabilityDraft.capabilityId === capabilityId;
    });
    if (index < 0) {
      continue;
    }

    servers.splice(index, 1);
    config[candidate.configKey] = servers;
    await fs.writeFile(candidate.filePath, JSON.stringify(config, null, 2));
    return { filePath: candidate.filePath };
  }

  throw new Error(`Disabled MCP draft "${serverName}" was not found in MCP config`);
}

/** 从一个已知配置文件里按名字摘掉一条 server 记录（找不到则原样返回 false，不算错）。 */
async function removeMcpServerConfigFromPath(filePath: string, serverName: string): Promise<boolean> {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(await fs.readFile(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return false;
  }
  let dirty = false;
  for (const key of ['servers', 'mcpServers'] as const) {
    const servers = config[key];
    if (!Array.isArray(servers)) continue;
    const filtered = (servers as MCPServerConfig[]).filter((server) => server.name !== serverName);
    if (filtered.length !== servers.length) {
      config[key] = filtered;
      dirty = true;
    }
  }
  if (dirty) {
    await fs.writeFile(filePath, JSON.stringify(config, null, 2));
  }
  return dirty;
}

/**
 * 撤销一次 addServer：扫 user/project/local 全部候选配置文件摘除该条目 + 让运行时
 * MCPClient 忘掉它。用于渲染层"取消"竞态下——旧的 addServer promise 在用户已取消后
 * 才 resolve 成功，须把静默完成的写入连本带利地回滚，而不是留一个幽灵 server。
 */
async function handleRemoveServer(serverName: string, workingDirectory?: string): Promise<void> {
  const paths = getMcpScopedConfigPaths(workingDirectory);
  const candidates = [paths.user, paths.project, paths.local].filter((p): p is string => Boolean(p));
  for (const configPath of candidates) {
    await removeMcpServerConfigFromPath(configPath, serverName);
  }
  await getMCPClient().removeServer(serverName);
}

async function handleAddServer(
  payload: unknown,
  workingDirectory: string | undefined,
  scope: McpSettingsServerScope,
  signal?: AbortSignal,
): Promise<unknown> {
  const payloadRecord = asRecord(payload, 'payload');
  let serverConfig = normalizeMcpSettingsServerConfig(payloadRecord.config ?? payloadRecord);
  const existing = getMCPClient().getServerState(serverConfig.name);
  if (existing) {
    throw new Error(`MCP server "${serverConfig.name}" already exists`);
  }

  const secretEnvKeys = optionalStringArray(payloadRecord.secretEnvKeys, 'secretEnvKeys') || [];
  const secretHeaderKeys = optionalStringArray(payloadRecord.secretHeaderKeys, 'secretHeaderKeys') || [];
  const integrationId = `mcp_${serverConfig.name}`;
  const extractedSecrets: Record<string, string> = {};
  const configService = getConfigService();
  const previousIntegration = configService.getIntegration(integrationId);

  if ((serverConfig.type === undefined || serverConfig.type === 'stdio') && serverConfig.env) {
    const { sanitized, extracted } = extractSecrets(
      serverConfig.env,
      secretEnvKeys,
      integrationId,
    );
    if (sanitized !== serverConfig.env) {
      serverConfig = { ...serverConfig, env: sanitized };
    }
    Object.assign(extractedSecrets, extracted);
  } else if (
    (serverConfig.type === 'sse' || serverConfig.type === 'http-streamable')
    && serverConfig.headers
  ) {
    const { sanitized, extracted } = extractSecrets(
      serverConfig.headers,
      secretHeaderKeys,
      integrationId,
    );
    if (sanitized !== serverConfig.headers) {
      serverConfig = { ...serverConfig, headers: sanitized };
    }
    Object.assign(extractedSecrets, extracted);
  }

  let persisted: { filePath: string };
  if (scope === 'user') {
    persisted = await persistUserMcpSettingsServerConfig(serverConfig);
  } else {
    // project scope 必须有工作目录（调用点已挡一次，这里再守一次做类型收窄，避免非空断言）
    if (!workingDirectory) {
      throw new Error('Working directory is unavailable');
    }
    persisted = await persistMcpSettingsServerConfig(workingDirectory, serverConfig);
  }

  let integrationWritten = false;
  let runtimeAdded = false;
  try {
    signal?.throwIfAborted();
    if (Object.keys(extractedSecrets).length > 0) {
      await configService.setIntegration(integrationId, extractedSecrets);
      integrationWritten = true;
      signal?.throwIfAborted();
    }
    getMCPClient().addServer({ ...serverConfig, scope: 'runtime' });
    runtimeAdded = true;
    signal?.throwIfAborted();
  } catch (err) {
    // 失败回滚（A5）：配置文件已经写入了这一条，但凭证/运行时注册没跟上——
    // 留着就是"配置里有、MCPClient 不认得"的孤儿条目。回滚删掉刚写入的那条。
    await removeMcpServerConfigFromPath(persisted.filePath, serverConfig.name).catch((rollbackErr) => {
      logger.warn(`Failed to roll back MCP server config for "${serverConfig.name}" after add failure:`, rollbackErr);
    });
    if (runtimeAdded || signal?.aborted) {
      await getMCPClient().removeServer(serverConfig.name).catch((rollbackErr) => {
        logger.warn(`Failed to remove MCP server "${serverConfig.name}" after add rollback:`, rollbackErr);
      });
    }
    if (integrationWritten) {
      if (previousIntegration) {
        await configService.setIntegration(integrationId, previousIntegration).catch((rollbackErr) => {
          logger.warn(`Failed to restore credentials for "${serverConfig.name}" after add rollback:`, rollbackErr);
        });
      } else {
        getSecureStorage().delete(`integration.${integrationId}` as `integration.${string}`);
      }
    }
    throw err;
  }

  return {
    serverName: serverConfig.name,
    enabled: false,
    persisted: true,
    configPath: persisted.filePath,
  };
}

async function handleGetStatus(): Promise<unknown> {
  return getMCPClient().getStatus();
}

async function handleListTools(): Promise<unknown> {
  return getMCPClient().getTools();
}

async function handleListResources(): Promise<unknown> {
  return getMCPClient().getResources();
}

async function handleGetServerStates(): Promise<unknown> {
  return getMCPClient().getServerStates().map(summarizeMcpServerState);
}

async function handleSetServerEnabled(
  serverName: string,
  enabled: boolean,
  workingDirectory?: string,
  signal?: AbortSignal,
): Promise<void> {
  const client = getMCPClient();
  try {
    await client.setServerEnabled(serverName, enabled, signal);
    signal?.throwIfAborted();
    // 持久化 enabled，否则重启读回旧值（飞书启用后重启变回 disabled → Tool not found）。
    await updateMcpServerEnabledInConfigFiles(serverName, enabled, workingDirectory);
    signal?.throwIfAborted();
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      await client.disconnect(serverName).catch(() => {});
      await Promise.resolve(client.setServerEnabled(serverName, false)).catch(() => {});
      await updateMcpServerEnabledInConfigFiles(serverName, false, workingDirectory);
      getContextHealthService().clearMcpServerAcrossSessions(serverName);
    }
    throw error;
  }
  // 被禁用后跨 session 清掉 bySource.mcp[serverName] 占用，让 ContextPanel UI 立即反映
  if (!enabled) {
    getContextHealthService().clearMcpServerAcrossSessions(serverName);
  }
}

async function handleReconnectServer(serverName: string): Promise<{ success: boolean; error?: string }> {
  return getMCPClient().reconnect(serverName);
}

async function handleSignOutServer(serverName: string): Promise<{
  success: true;
  serverName: string;
  hadOAuthTokens: boolean;
  cancelledFlow: boolean;
}> {
  const client = getMCPClient();
  const state = client.getServerState(serverName);
  if (!state) {
    throw new Error(`MCP server "${serverName}" not found`);
  }
  if (!isHttpStreamableConfig(state.config) || state.config.auth !== 'oauth') {
    throw new Error(`MCP server "${serverName}" is not configured for OAuth`);
  }

  const serverIdentity = client.getServerIdentity(serverName);
  if (!serverIdentity) {
    throw new Error(`MCP server "${serverName}" identity is unavailable`);
  }

  const provider = createOAuthManagementProvider(serverName, serverIdentity);
  const hadOAuthTokens = Boolean(provider.tokens());
  provider.invalidateCredentials('all');
  const cancelledFlow = getMcpOAuthCoordinator().cancelFlowForServerIdentity(serverIdentity);
  await client.disconnect(serverName);

  return {
    success: true,
    serverName,
    hadOAuthTokens,
    cancelledFlow,
  };
}

async function handleRefreshFromCloud(): Promise<void> {
  await refreshMCPServersFromCloud();
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 MCP 相关 IPC handlers
 */
export function registerMcpHandlers(ipcMain: IpcMain, options: RegisterMcpHandlersOptions = {}): void {
  // ========== New Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.MCP, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action } = request;

    try {
      let data: unknown;

      switch (action) {
        case 'getStatus':
          data = await handleGetStatus();
          break;
        case 'getCatalog':
          // MCP 推荐目录（云端下发优先，内置兜底）
          data = getCloudConfigService().getMcpCatalog();
          break;
        case 'listTools':
          data = await handleListTools();
          break;
        case 'listResources':
          data = await handleListResources();
          break;
        case 'getServerStates':
          data = await handleGetServerStates();
          break;
        case 'addServer': {
          const payload = asRecord(request.payload, 'payload');
          const scope = readMcpSettingsServerScope(payload.scope);
          const workingDirectory = options.getWorkingDirectory?.();
          if (scope === 'project' && !workingDirectory) {
            throw new Error('Working directory is unavailable');
          }
          const config = asRecord(payload.config ?? payload, 'config');
          const serverName = readRequiredString(config, 'name', 'Server name is required');
          data = await runMcpInstall(
            serverName,
            (signal) => handleAddServer(payload, workingDirectory, scope, signal),
          );
          break;
        }
        case 'cancelServerInstall': {
          const payload = request.payload as { serverName: string };
          const controller = activeMcpInstalls.get(payload.serverName);
          if (controller) {
            controller.abort(new DOMException('MCP server installation cancelled', 'AbortError'));
          }
          data = { cancelled: Boolean(controller) };
          break;
        }
        case 'removeServer': {
          const payload = request.payload as { serverName: string };
          await handleRemoveServer(payload.serverName, options.getWorkingDirectory?.());
          data = { success: true };
          break;
        }
        case 'setServerEnabled': {
          const payload = request.payload as { serverName: string; enabled: boolean };
          if (payload.enabled) {
            await runMcpInstall(
              payload.serverName,
              (signal) => handleSetServerEnabled(
                payload.serverName,
                true,
                options.getWorkingDirectory?.(),
                signal,
              ),
            );
          } else {
            await handleSetServerEnabled(
              payload.serverName,
              false,
              options.getWorkingDirectory?.(),
            );
          }
          data = { success: true };
          break;
        }
        case 'reconnectServer': {
          const payload = request.payload as { serverName: string };
          data = await handleReconnectServer(payload.serverName);
          break;
        }
        case 'signOutServer': {
          const payload = request.payload as { serverName: string };
          data = await handleSignOutServer(payload.serverName);
          break;
        }
        case 'refreshFromCloud':
          await handleRefreshFromCloud();
          data = { success: true };
          break;
        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` } };
      }

      return { success: true, data };
    } catch (error) {
      const code = error instanceof McpInstallInProgressError
        ? error.code
        : isAbortError(error)
          ? 'CANCELLED'
          : 'INTERNAL_ERROR';
      return { success: false, error: { code, message: error instanceof Error ? error.message : String(error) } };
    }
  });

  // ========== Legacy Handlers (Deprecated) ==========

}
