// ============================================================================
// Settings IPC Handlers - settings:* 通道
// ============================================================================

import type { IpcMain } from '../platform';
import { app } from '../platform';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { AppSettings } from '../../shared/types';
import type { ConfigService } from '../services';
import { MODEL_API_ENDPOINTS, API_VERSIONS } from '../../shared/constants';

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
    deepseek: { url: `${MODEL_API_ENDPOINTS.deepseek}/models`, headers: { Authorization: `Bearer ${payload.apiKey}` }, body: null },
    openai: { url: `${MODEL_API_ENDPOINTS.openai}/models`, headers: { Authorization: `Bearer ${payload.apiKey}` }, body: null },
    claude: {
      url: `${MODEL_API_ENDPOINTS.claude}/messages`,
      headers: { 'x-api-key': payload.apiKey, 'anthropic-version': API_VERSIONS.ANTHROPIC, 'content-type': 'application/json' },
      body: { model: 'claude-3-haiku-20240307', max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] },
    },
    groq: { url: `${MODEL_API_ENDPOINTS.groq}/models`, headers: { Authorization: `Bearer ${payload.apiKey}` }, body: null },
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
  // 1. 检查 secureStorage（Electron 模式）
  const { getSecureStorage } = await import('../services/core/secureStorage');
  if (getSecureStorage().getStoredApiKeyProviders().length > 0) {
    return true;
  }

  // 2. 检查环境变量（Web 模式 / .env 配置）
  const envKeyNames = [
    'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'ZHIPU_API_KEY',
    'GROQ_API_KEY', 'QWEN_API_KEY', 'MINIMAX_API_KEY',
    'OPENROUTER_API_KEY', 'PERPLEXITY_API_KEY',
  ];
  return envKeyNames.some(name => !!process.env[name]);
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
    const { BrowserWindow } = await import('../platform');
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

  /** Integration config handlers */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_INTEGRATION, async (_, integration: string) =>
    handleGetIntegration(getConfigService, integration)
  );

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET_INTEGRATION, async (_, payload: { integration: string; config: Record<string, string> }) =>
    handleSetIntegration(getConfigService, payload)
  );

  /** @deprecated Use IPC_DOMAINS.WINDOW with action: 'minimize' */
  ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, async () => {
    const { BrowserWindow } = await import('../platform');
    BrowserWindow.getFocusedWindow()?.minimize();
  });

  /** @deprecated Use IPC_DOMAINS.WINDOW with action: 'maximize' */
  ipcMain.handle(IPC_CHANNELS.WINDOW_MAXIMIZE, async () => {
    const { BrowserWindow } = await import('../platform');
    const mainWindow = BrowserWindow.getFocusedWindow();
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });

  /** @deprecated Use IPC_DOMAINS.WINDOW with action: 'close' */
  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, async () => {
    const { BrowserWindow } = await import('../platform');
    BrowserWindow.getFocusedWindow()?.close();
  });

  ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, async (): Promise<string> => app.getVersion());

  ipcMain.handle('extract-pdf-text', async (_, filePath: string) => {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    // 尝试 pdftotext（poppler，brew install poppler）
    for (const bin of ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext']) {
      try {
        const { stdout } = await execFileAsync(bin, [filePath, '-'], { maxBuffer: 50 * 1024 * 1024 });
        const pageCount = (stdout.match(/\f/g) || []).length + 1;
        return { text: stdout, pageCount };
      } catch { /* 未安装，继续尝试 */ }
    }

    // 尝试 python3 + PyPDF2
    try {
      const script = [
        'import sys',
        'try:',
        '    from PyPDF2 import PdfReader',
        '    r = PdfReader(sys.argv[1])',
        '    print(f"PAGES:{len(r.pages)}")',
        '    for p in r.pages:',
        '        t = p.extract_text()',
        '        if t: print(t)',
        'except Exception as e:',
        '    print(f"PAGES:0")',
        '    print(f"[PyPDF2 error: {e}]")',
      ].join('\n');
      const { stdout } = await execFileAsync('python3', ['-c', script, filePath], { maxBuffer: 50 * 1024 * 1024 });
      const m = stdout.match(/^PAGES:(\d+)/);
      const pageCount = m ? parseInt(m[1]) : 0;
      const text = stdout.replace(/^PAGES:\d+\n/, '');
      return { text, pageCount };
    } catch { /* python3 或 PyPDF2 不可用 */ }

    // 兜底：返回文件路径，由 AI 模型通过工具读取
    return {
      text: `[PDF 文件: ${filePath}]\n请使用 read_pdf 工具读取此文件内容。`,
      pageCount: 0,
    };
  });

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

  // Excel → JSON (for SpreadsheetBlock interactive rendering)
  ipcMain.handle('extract-excel-json', async (_, filePath: string): Promise<{
    sheets: Array<{ name: string; headers: string[]; rows: unknown[][]; rowCount: number }>;
    sheetCount: number;
  }> => {
    try {
      const fs = await import('fs');
      const XLSX = await import('xlsx');

      const buffer = fs.readFileSync(filePath);
      const workbook = XLSX.read(buffer, { type: 'buffer' });

      const sheets = workbook.SheetNames.map((sheetName: string) => {
        const sheet = workbook.Sheets[sheetName];
        const json: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
        const headers = (json[0] || []) as string[];
        const rows = json.slice(1, 501); // Cap at 500 rows for UI performance
        return { name: sheetName, headers, rows, rowCount: json.length - 1 };
      });

      return { sheets, sheetCount: workbook.SheetNames.length };
    } catch (error) {
      return { sheets: [], sheetCount: 0 };
    }
  });

  // Word (.docx) → structured HTML + paragraphs (for DocumentBlock interactive rendering)
  ipcMain.handle('extract-docx-html', async (_, filePath: string): Promise<{
    html: string;
    paragraphs: Array<{ index: number; type: string; text: string; level?: number }>;
    text: string;
    wordCount: number;
  }> => {
    try {
      const fs = await import('fs');
      const mammoth = await import('mammoth');

      const buffer = fs.readFileSync(filePath);
      const result = await mammoth.convertToHtml({ buffer });
      const html = result.value;

      // Extract paragraph structure from raw text
      const textResult = await mammoth.extractRawText({ buffer });
      const rawText = textResult.value;

      // Parse HTML to extract paragraph structure
      const paragraphs: Array<{ index: number; type: string; text: string; level?: number }> = [];
      // Simple HTML parsing for paragraphs and headings
      const tagRegex = /<(h[1-6]|p|li)[^>]*>([\s\S]*?)<\/\1>/gi;
      let match;
      let idx = 0;
      while ((match = tagRegex.exec(html)) !== null) {
        const tag = match[1].toLowerCase();
        // Strip HTML tags from content for plain text
        const text = match[2].replace(/<[^>]+>/g, '').trim();
        if (!text) continue;

        let type = 'paragraph';
        let level: number | undefined;
        if (tag.startsWith('h')) {
          type = 'heading';
          level = parseInt(tag[1], 10);
        } else if (tag === 'li') {
          type = 'list-item';
        }

        paragraphs.push({ index: idx++, type, text, level });
      }

      const wordCount = rawText.split(/\s+/).filter(Boolean).length;

      return { html, paragraphs, text: rawText, wordCount };
    } catch (error) {
      return { html: '', paragraphs: [], text: '', wordCount: 0 };
    }
  });

  // Tool create response handler removed (evolution module deleted)

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
    const result = getPermissionModeManager().setMode(mode as 'default' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'plan' | 'delegate', approved);

    // 持久化权限模式到 config（重启/重装后恢复）
    if (result) {
      const configService = getConfigService();
      if (configService) {
        await configService.updateSettings({
          permissions: { permissionMode: mode as AppSettings['permissions']['permissionMode'] },
        } as Partial<AppSettings>);
      }
    }

    return result;
  });
}
