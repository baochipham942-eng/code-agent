// ============================================================================
// Settings IPC Handlers - settings:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { app } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { ConfigService } from '../services';

/**
 * 注册 Settings 相关 IPC handlers
 */
export function registerSettingsHandlers(
  ipcMain: IpcMain,
  getConfigService: () => ConfigService | null
): void {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async () => {
    const configService = getConfigService();
    if (!configService) throw new Error('Config service not initialized');
    return configService.getSettings();
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_, settings) => {
    const configService = getConfigService();
    if (!configService) throw new Error('Config service not initialized');
    await configService.updateSettings(settings);
  });

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_TEST_API_KEY,
    async (_, provider: string, apiKey: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const testEndpoints: Record<
          string,
          { url: string; headers: Record<string, string>; body: unknown }
        > = {
          deepseek: {
            url: 'https://api.deepseek.com/v1/models',
            headers: { Authorization: `Bearer ${apiKey}` },
            body: null,
          },
          openai: {
            url: 'https://api.openai.com/v1/models',
            headers: { Authorization: `Bearer ${apiKey}` },
            body: null,
          },
          claude: {
            url: 'https://api.anthropic.com/v1/messages',
            headers: {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            body: {
              model: 'claude-3-haiku-20240307',
              max_tokens: 1,
              messages: [{ role: 'user', content: 'Hi' }],
            },
          },
          groq: {
            url: 'https://api.groq.com/openai/v1/models',
            headers: { Authorization: `Bearer ${apiKey}` },
            body: null,
          },
        };

        const config = testEndpoints[provider];
        if (!config) {
          return { success: false, error: `不支持测试的 provider: ${provider}` };
        }

        const response = await fetch(config.url, {
          method: config.body ? 'POST' : 'GET',
          headers: config.headers,
          body: config.body ? JSON.stringify(config.body) : undefined,
        });

        if (response.ok || response.status === 200) {
          return { success: true };
        }

        const errorText = await response.text();
        return {
          success: false,
          error: `API 错误 (${response.status}): ${errorText.substring(0, 200)}`,
        };
      } catch (error) {
        return {
          success: false,
          error: `连接失败: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
  );

  // Window handlers
  ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, async () => {
    const { BrowserWindow } = await import('electron');
    const mainWindow = BrowserWindow.getFocusedWindow();
    mainWindow?.minimize();
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_MAXIMIZE, async () => {
    const { BrowserWindow } = await import('electron');
    const mainWindow = BrowserWindow.getFocusedWindow();
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, async () => {
    const { BrowserWindow } = await import('electron');
    const mainWindow = BrowserWindow.getFocusedWindow();
    mainWindow?.close();
  });

  // App version handler
  ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, async (): Promise<string> => {
    return app.getVersion();
  });

  // PDF extraction handler (deprecated)
  ipcMain.handle('extract-pdf-text', async (_, filePath: string) => {
    return {
      text: `[PDF 文件将由 AI 模型解析: ${filePath}]`,
      pageCount: 0,
    };
  });

  // Security handlers
  ipcMain.handle(
    IPC_CHANNELS.SECURITY_CHECK_API_KEY_CONFIGURED,
    async (): Promise<boolean> => {
      const { getSecureStorage } = await import('../services/core/SecureStorage');
      const storage = getSecureStorage();
      const providers = storage.getStoredApiKeyProviders();
      return providers.length > 0;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SECURITY_TOOL_CREATE_RESPONSE,
    async (_, requestId: string, allowed: boolean) => {
      const { handleToolCreateResponse } = await import('../tools/evolution/toolCreate');
      handleToolCreateResponse(requestId, allowed);
    }
  );

  // Persistent settings handlers
  ipcMain.handle(IPC_CHANNELS.PERSISTENT_GET_DEV_MODE, async () => {
    const { getSecureStorage } = await import('../services/core/SecureStorage');
    const storage = getSecureStorage();
    const value = storage.get('settings.devModeAutoApprove');
    return value === undefined ? true : value === 'true';
  });

  ipcMain.handle(IPC_CHANNELS.PERSISTENT_SET_DEV_MODE, async (_, enabled: boolean) => {
    const { getSecureStorage } = await import('../services/core/SecureStorage');
    const storage = getSecureStorage();
    storage.set('settings.devModeAutoApprove', enabled ? 'true' : 'false');

    const configService = getConfigService();
    if (configService) {
      const settings = configService.getSettings();
      await configService.updateSettings({
        permissions: {
          ...settings.permissions,
          devModeAutoApprove: enabled,
        },
      });
    }
  });
}
