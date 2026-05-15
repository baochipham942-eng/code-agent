// ============================================================================
// MCP IPC Handlers - mcp:* 通道
// ============================================================================

import fs from 'fs/promises';
import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import {
  getMCPClient,
  refreshMCPServersFromCloud,
  type MCPServerConfig,
} from '../mcp/mcpClient';
import { ensureConfigDir, getMcpConfigPath, pathExists } from '../config';
import { getContextHealthService } from '../context/contextHealthService';

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
    const serverConfig = {
      name,
      type: type === 'sse' ? 'sse' as const : 'http-streamable' as const,
      serverUrl,
      enabled: false,
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
  let configKey: 'servers' | 'mcpServers';

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

  let config: Record<string, unknown> = {};
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

    let config: Record<string, unknown> = {};
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

async function handleAddServer(payload: unknown, workingDirectory: string): Promise<unknown> {
  const payloadRecord = asRecord(payload, 'payload');
  const serverConfig = normalizeMcpSettingsServerConfig(payloadRecord.config ?? payloadRecord);
  const existing = getMCPClient().getServerState(serverConfig.name);
  if (existing) {
    throw new Error(`MCP server "${serverConfig.name}" already exists`);
  }

  const persisted = await persistMcpSettingsServerConfig(workingDirectory, serverConfig);
  getMCPClient().addServer({ ...serverConfig, scope: 'runtime' });
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
  return getMCPClient().getServerStates();
}

async function handleSetServerEnabled(serverName: string, enabled: boolean): Promise<void> {
  await getMCPClient().setServerEnabled(serverName, enabled);
  // 被禁用后跨 session 清掉 bySource.mcp[serverName] 占用，让 ContextPanel UI 立即反映
  if (!enabled) {
    getContextHealthService().clearMcpServerAcrossSessions(serverName);
  }
}

async function handleReconnectServer(serverName: string): Promise<{ success: boolean; error?: string }> {
  return getMCPClient().reconnect(serverName);
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
          const workingDirectory = options.getWorkingDirectory?.();
          if (!workingDirectory) {
            throw new Error('Working directory is unavailable');
          }
          data = await handleAddServer(request.payload, workingDirectory);
          break;
        }
        case 'setServerEnabled': {
          const payload = request.payload as { serverName: string; enabled: boolean };
          await handleSetServerEnabled(payload.serverName, payload.enabled);
          data = { success: true };
          break;
        }
        case 'reconnectServer': {
          const payload = request.payload as { serverName: string };
          data = await handleReconnectServer(payload.serverName);
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
      return { success: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } };
    }
  });

  // ========== Legacy Handlers (Deprecated) ==========

}
