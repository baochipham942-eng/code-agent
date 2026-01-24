// ============================================================================
// Settings IPC Handlers - settings:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { app } from 'electron';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { AppSettings } from '../../shared/types';
import type { ConfigService } from '../services';

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

async function handleGet(getConfigService: () => ConfigService | null): Promise<AppSettings> {
  const configService = getConfigService();
  if (!configService) throw new Error('Config service not initialized');
  return configService.getSettings();
}

async function handleSet(
  getConfigService: () => ConfigService | null,
  payload: { settings: Partial<AppSettings> }
): Promise<void> {
  const configService = getConfigService();
  if (!configService) throw new Error('Config service not initialized');
  await configService.updateSettings(payload.settings);
}

async function handleTestApiKey(payload: { provider: string; apiKey: string }): Promise<{ success: boolean; error?: string }> {
  const testEndpoints: Record<string, { url: string; headers: Record<string, string>; body: unknown }> = {
    deepseek: { url: 'https://api.deepseek.com/v1/models', headers: { Authorization: `Bearer ${payload.apiKey}` }, body: null },
    openai: { url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${payload.apiKey}` }, body: null },
    claude: {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': payload.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: { model: 'claude-3-haiku-20240307', max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] },
    },
    groq: { url: 'https://api.groq.com/openai/v1/models', headers: { Authorization: `Bearer ${payload.apiKey}` }, body: null },
  };

  const config = testEndpoints[payload.provider];
  if (!config) return { success: false, error: `不支持测试的 provider: ${payload.provider}` };

  try {
    const response = await fetch(config.url, {
      method: config.body ? 'POST' : 'GET',
      headers: config.headers,
      body: config.body ? JSON.stringify(config.body) : undefined,
    });
    if (response.ok) return { success: true };
    const errorText = await response.text();
    return { success: false, error: `API 错误 (${response.status}): ${errorText.substring(0, 200)}` };
  } catch (error) {
    return { success: false, error: `连接失败: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function handleGetDevMode(): Promise<boolean> {
  const { getSecureStorage } = await import('../services/core/secureStorage');
  const value = getSecureStorage().get('settings.devModeAutoApprove');
  return value === undefined ? true : value === 'true';
}

async function handleSetDevMode(
  getConfigService: () => ConfigService | null,
  payload: { enabled: boolean }
): Promise<void> {
  const { getSecureStorage } = await import('../services/core/secureStorage');
  getSecureStorage().set('settings.devModeAutoApprove', payload.enabled ? 'true' : 'false');

  const configService = getConfigService();
  if (configService) {
    const settings = configService.getSettings();
    await configService.updateSettings({
      permissions: { ...settings.permissions, devModeAutoApprove: payload.enabled },
    });
  }
}

async function handleCheckApiKeyConfigured(): Promise<boolean> {
  const { getSecureStorage } = await import('../services/core/secureStorage');
  return getSecureStorage().getStoredApiKeyProviders().length > 0;
}

async function handleSetServiceApiKey(
  getConfigService: () => ConfigService | null,
  payload: { service: 'brave' | 'langfuse_public' | 'langfuse_secret' | 'github' | 'openrouter'; apiKey: string }
): Promise<void> {
  const configService = getConfigService();
  if (!configService) throw new Error('Config service not initialized');
  await configService.setServiceApiKey(payload.service as 'brave' | 'langfuse_public' | 'langfuse_secret' | 'github', payload.apiKey);
}

async function handleGetServiceApiKey(
  getConfigService: () => ConfigService | null,
  payload: { service: 'brave' | 'langfuse_public' | 'langfuse_secret' | 'github' | 'openrouter' }
): Promise<string | undefined> {
  const configService = getConfigService();
  if (!configService) throw new Error('Config service not initialized');
  return configService.getServiceApiKey(payload.service as 'brave' | 'langfuse_public' | 'langfuse_secret' | 'github');
}

async function handleGetAllServiceKeys(
  getConfigService: () => ConfigService | null
): Promise<{
  brave?: string;
  github?: string;
  openrouter?: string;
  langfuse_public?: string;
  langfuse_secret?: string;
}> {
  const configService = getConfigService();
  if (!configService) throw new Error('Config service not initialized');

  const services = ['brave', 'github', 'openrouter', 'langfuse_public', 'langfuse_secret'] as const;
  const result: Record<string, string | undefined> = {};

  for (const service of services) {
    const key = configService.getServiceApiKey(service);
    if (key) {
      // Mask API key for display (show first 8 chars only)
      result[service] = key.length > 8 ? key.substring(0, 8) + '...' : key;
    }
  }

  return result;
}

async function handleSyncApiKeysFromCloud(
  getConfigService: () => ConfigService | null,
  payload: { authToken: string }
): Promise<{ success: boolean; syncedKeys: string[]; error?: string }> {
  const configService = getConfigService();
  if (!configService) throw new Error('Config service not initialized');
  return configService.syncApiKeysFromCloud(payload.authToken);
}

async function handleGetIntegration(
  getConfigService: () => ConfigService | null,
  integration: string
): Promise<Record<string, string> | null> {
  const configService = getConfigService();
  if (!configService) throw new Error('Config service not initialized');
  return configService.getIntegration(integration);
}

async function handleSetIntegration(
  getConfigService: () => ConfigService | null,
  payload: { integration: string; config: Record<string, string> }
): Promise<void> {
  const configService = getConfigService();
  if (!configService) throw new Error('Config service not initialized');
  await configService.setIntegration(payload.integration, payload.config);
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Settings 相关 IPC handlers
 */
export function registerSettingsHandlers(
  ipcMain: IpcMain,
  getConfigService: () => ConfigService | null
): void {
  // ========== New Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.SETTINGS, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;

    try {
      let data: unknown;

      switch (action) {
        case 'get':
          data = await handleGet(getConfigService);
          break;
        case 'set':
          await handleSet(getConfigService, payload as { settings: Partial<AppSettings> });
          data = null;
          break;
        case 'testApiKey':
          data = await handleTestApiKey(payload as { provider: string; apiKey: string });
          break;
        case 'getDevMode':
          data = await handleGetDevMode();
          break;
        case 'setDevMode':
          await handleSetDevMode(getConfigService, payload as { enabled: boolean });
          data = null;
          break;
        case 'checkApiKeyConfigured':
          data = await handleCheckApiKeyConfigured();
          break;
        case 'syncApiKeysFromCloud':
          data = await handleSyncApiKeysFromCloud(getConfigService, payload as { authToken: string });
          break;
        case 'setServiceApiKey':
          await handleSetServiceApiKey(getConfigService, payload as { service: 'brave' | 'langfuse_public' | 'langfuse_secret' | 'github' | 'openrouter'; apiKey: string });
          data = null;
          break;
        case 'getServiceApiKey':
          data = await handleGetServiceApiKey(getConfigService, payload as { service: 'brave' | 'langfuse_public' | 'langfuse_secret' | 'github' | 'openrouter' });
          break;
        case 'getAllServiceKeys':
          data = await handleGetAllServiceKeys(getConfigService);
          break;
        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` } };
      }

      return { success: true, data };
    } catch (error) {
      return { success: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } };
    }
  });

  // ========== Window Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.WINDOW, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action } = request;
    const { BrowserWindow } = await import('electron');
    const mainWindow = BrowserWindow.getFocusedWindow();

    try {
      switch (action) {
        case 'minimize':
          mainWindow?.minimize();
          break;
        case 'maximize':
          if (mainWindow?.isMaximized()) mainWindow.unmaximize();
          else mainWindow?.maximize();
          break;
        case 'close':
          mainWindow?.close();
          break;
        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` } };
      }
      return { success: true, data: null };
    } catch (error) {
      return { success: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } };
    }
  });

  // ========== Legacy Handlers (Deprecated) ==========

  /** @deprecated Use IPC_DOMAINS.SETTINGS with action: 'get' */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async () => handleGet(getConfigService));

  /** @deprecated Use IPC_DOMAINS.SETTINGS with action: 'set' */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_, settings) => handleSet(getConfigService, { settings }));

  /** @deprecated Use IPC_DOMAINS.SETTINGS with action: 'testApiKey' */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_TEST_API_KEY, async (_, provider: string, apiKey: string) =>
    handleTestApiKey({ provider, apiKey })
  );

  /** @deprecated Use IPC_DOMAINS.SETTINGS with action: 'getAllServiceKeys' */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_SERVICE_KEYS, async () =>
    handleGetAllServiceKeys(getConfigService)
  );

  /** @deprecated Use IPC_DOMAINS.SETTINGS with action: 'setServiceApiKey' */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET_SERVICE_KEY, async (_, payload: { service: 'brave' | 'github' | 'openrouter' | 'langfuse_public' | 'langfuse_secret'; apiKey: string }) =>
    handleSetServiceApiKey(getConfigService, payload)
  );

  /** Integration config handlers */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_INTEGRATION, async (_, integration: string) =>
    handleGetIntegration(getConfigService, integration)
  );

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET_INTEGRATION, async (_, payload: { integration: string; config: Record<string, string> }) =>
    handleSetIntegration(getConfigService, payload)
  );

  /** @deprecated Use IPC_DOMAINS.WINDOW with action: 'minimize' */
  ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, async () => {
    const { BrowserWindow } = await import('electron');
    BrowserWindow.getFocusedWindow()?.minimize();
  });

  /** @deprecated Use IPC_DOMAINS.WINDOW with action: 'maximize' */
  ipcMain.handle(IPC_CHANNELS.WINDOW_MAXIMIZE, async () => {
    const { BrowserWindow } = await import('electron');
    const mainWindow = BrowserWindow.getFocusedWindow();
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });

  /** @deprecated Use IPC_DOMAINS.WINDOW with action: 'close' */
  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, async () => {
    const { BrowserWindow } = await import('electron');
    BrowserWindow.getFocusedWindow()?.close();
  });

  ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, async (): Promise<string> => app.getVersion());

  ipcMain.handle('extract-pdf-text', async (_, filePath: string) => ({
    text: `[PDF 文件将由 AI 模型解析: ${filePath}]`,
    pageCount: 0,
  }));

  // Excel 文件解析
  ipcMain.handle('extract-excel-text', async (_, filePath: string): Promise<{ text: string; sheetCount: number; rowCount: number }> => {
    try {
      const fs = await import('fs');
      const XLSX = await import('xlsx');

      const buffer = fs.readFileSync(filePath);
      const workbook = XLSX.read(buffer, { type: 'buffer' });

      const sheets: string[] = [];
      let totalRows = 0;

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        // 转换为 CSV 格式（AI 更容易理解）
        const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
        const rows = csv.split('\n').filter((r: string) => r.trim()).length;
        totalRows += rows;

        // 添加 sheet 标题
        sheets.push(`=== Sheet: ${sheetName} (${rows} 行) ===\n${csv}`);
      }

      return {
        text: sheets.join('\n\n'),
        sheetCount: workbook.SheetNames.length,
        rowCount: totalRows,
      };
    } catch (error) {
      return {
        text: `[Excel 解析失败: ${error instanceof Error ? error.message : String(error)}]`,
        sheetCount: 0,
        rowCount: 0,
      };
    }
  });

  /** @deprecated Use IPC_DOMAINS.SETTINGS with action: 'checkApiKeyConfigured' */
  ipcMain.handle(IPC_CHANNELS.SECURITY_CHECK_API_KEY_CONFIGURED, async () => handleCheckApiKeyConfigured());

  ipcMain.handle(IPC_CHANNELS.SECURITY_TOOL_CREATE_RESPONSE, async (_, requestId: string, allowed: boolean) => {
    const { handleToolCreateResponse } = await import('../tools/evolution/toolCreate');
    handleToolCreateResponse(requestId, allowed);
  });

  /** @deprecated Use IPC_DOMAINS.SETTINGS with action: 'getDevMode' */
  ipcMain.handle(IPC_CHANNELS.PERSISTENT_GET_DEV_MODE, async () => handleGetDevMode());

  /** @deprecated Use IPC_DOMAINS.SETTINGS with action: 'setDevMode' */
  ipcMain.handle(IPC_CHANNELS.PERSISTENT_SET_DEV_MODE, async (_, enabled: boolean) =>
    handleSetDevMode(getConfigService, { enabled })
  );

  // Permission mode handlers
  ipcMain.handle(IPC_CHANNELS.PERMISSION_GET_MODE, async () => {
    const { getPermissionModeManager } = await import('../permissions/modes');
    return getPermissionModeManager().getMode();
  });

  ipcMain.handle(IPC_CHANNELS.PERMISSION_SET_MODE, async (_, mode: string) => {
    const { getPermissionModeManager } = await import('../permissions/modes');
    const validModes = ['default', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'plan', 'delegate'];
    if (!validModes.includes(mode)) {
      return false;
    }
    // bypassPermissions 需要用户审批
    const approved = mode === 'bypassPermissions';
    return getPermissionModeManager().setMode(mode as 'default' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'plan' | 'delegate', approved);
  });
}
