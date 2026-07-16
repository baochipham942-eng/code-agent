// ============================================================================
// Settings IPC Handlers - settings:* 通道
// ============================================================================

import type { IpcMain } from '../platform';
import { app, broadcastToRenderer } from '../platform';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { AppSettings, ModelEntrySettings, ModelProvider, ModelProviderSettings } from '../../shared/contract';
import type { ServiceApiKey } from '../../shared/contract/configService';
import type { ConfigService } from '../services';
import { MODEL_API_ENDPOINTS, API_VERSIONS } from '../../shared/constants';
import { assertAdminAccess, getAdminAccessIpcError, isCurrentUserAdmin } from './adminGuard';
import { resolveConnectionTestModel } from '../model/providerConnectionTest';
import { isRuntimeProviderConfigured } from '../../shared/modelRuntime';
import { resolveProviderIconAsset, saveProviderIconAsset } from '../services/providerIconAssets';
import { handleDiscoverModels, type DiscoveredProviderModel, type DiscoverModelsResult } from './provider.ipc';
import { extractDocxParagraphsFromBuffer } from '../tools/artifacts/docxParagraphLocator';
import {
  resolveSheetCoordinate,
  type SheetRangeStart,
} from '../../shared/livePreview/sheetCoords';

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

const LOCAL_PROVIDER_DISCOVERY_TTL_MS = 10_000;
const LOCAL_PROVIDER_DISCOVERY_TIMEOUT_MS = 1_200;

let localProviderDiscoveryCache: {
  baseUrl: string;
  protocol: ModelProviderSettings['protocol'];
  expiresAt: number;
  result?: DiscoverModelsResult;
  promise?: Promise<DiscoverModelsResult>;
} | null = null;

async function handleGet(getConfigService: () => ConfigService | null): Promise<AppSettings> {
  const configService = getConfigService();
  if (!configService) throw new Error('Config service not initialized');
  const settings = configService.getSettings();
  return decorateSettingsWithLocalProviderDiscovery(settings);
}

function cloneSettings(settings: AppSettings): AppSettings {
  return JSON.parse(JSON.stringify(settings)) as AppSettings;
}

function buildLocalDiscoveryUnavailableResult(message = '本地 Ollama 服务不可达'): DiscoverModelsResult {
  return {
    success: false,
    models: [],
    latencyMs: 0,
    error: {
      code: 'LOCAL_PROVIDER_UNAVAILABLE',
      message,
      suggestion: '启动 Ollama 后重新打开模型选择器或进入设置页发现模型',
    },
  };
}

function getLocalProviderDiscoveryBaseUrl(providerConfig?: Partial<ModelProviderSettings> | null): string {
  return providerConfig?.baseUrl || MODEL_API_ENDPOINTS.ollama;
}

function mergeLocalDiscoveredModelEntry(
  existing: ModelEntrySettings | undefined,
  discovered: DiscoveredProviderModel,
  shouldEnable: boolean,
  discoveredAt: number,
): ModelEntrySettings {
  return {
    ...existing,
    label: existing?.label || discovered.label,
    enabled: shouldEnable,
    capabilities: existing?.capabilities || discovered.capabilities,
    maxTokens: existing?.maxTokens ?? discovered.maxTokens,
    contextWindow: existing?.contextWindow ?? discovered.contextWindow,
    supportsTool: existing?.supportsTool ?? discovered.supportsTool,
    supportsVision: existing?.supportsVision ?? discovered.supportsVision,
    supportsStreaming: existing?.supportsStreaming ?? discovered.supportsStreaming,
    discoveredAt,
  };
}

export function applyLocalProviderDiscoverySnapshot(
  settings: AppSettings,
  discovery: DiscoverModelsResult | null | undefined,
  discoveredAt = Date.now(),
): AppSettings {
  const next = cloneSettings(settings);
  const local = next.models?.providers?.local;
  if (!local || local.enabled === false) return next;

  if (!discovery?.success || discovery.models.length === 0) {
    local.available = false;
    local.discoveredAt = discoveredAt;
    local.unavailableReason = discovery?.error?.message || '本地 Ollama 服务不可达';
    local.apiKeyConfigured = false;
    local.models = {};
    return next;
  }

  const existingModels = local.models ?? {};
  const nextModels: Record<string, ModelEntrySettings> = {};
  for (const discovered of discovery.models) {
    const existing = existingModels[discovered.id];
    nextModels[discovered.id] = mergeLocalDiscoveredModelEntry(
      existing,
      discovered,
      existing?.enabled ?? true,
      discoveredAt,
    );
  }

  local.enabled = true;
  local.available = true;
  local.discoveredAt = discoveredAt;
  delete local.unavailableReason;
  local.apiKeyConfigured = Boolean(local.apiKey);
  local.baseUrl = getLocalProviderDiscoveryBaseUrl(local);
  local.protocol = local.protocol ?? 'openai';
  local.models = nextModels;
  if (!local.model || !nextModels[local.model]) {
    local.model = discovery.models[0]?.id;
  }

  return next;
}

async function getLocalProviderDiscoverySnapshot(
  providerConfig: Partial<ModelProviderSettings>,
): Promise<DiscoverModelsResult> {
  const baseUrl = getLocalProviderDiscoveryBaseUrl(providerConfig);
  const protocol = providerConfig.protocol ?? 'openai';
  const now = Date.now();

  if (
    localProviderDiscoveryCache?.baseUrl === baseUrl
    && localProviderDiscoveryCache.protocol === protocol
    && localProviderDiscoveryCache.expiresAt > now
  ) {
    if (localProviderDiscoveryCache.result) return localProviderDiscoveryCache.result;
    if (localProviderDiscoveryCache.promise) return localProviderDiscoveryCache.promise;
  }

  const promise = handleDiscoverModels({
    provider: 'local',
    baseUrl,
    apiKey: '',
    protocol,
    timeoutMs: LOCAL_PROVIDER_DISCOVERY_TIMEOUT_MS,
  }).catch((error: unknown) => buildLocalDiscoveryUnavailableResult(
    error instanceof Error ? error.message : String(error),
  ));

  localProviderDiscoveryCache = {
    baseUrl,
    protocol,
    expiresAt: now + LOCAL_PROVIDER_DISCOVERY_TTL_MS,
    promise,
  };

  const result = await promise;
  localProviderDiscoveryCache = {
    baseUrl,
    protocol,
    expiresAt: Date.now() + LOCAL_PROVIDER_DISCOVERY_TTL_MS,
    result,
  };
  return result;
}

async function decorateSettingsWithLocalProviderDiscovery(settings: AppSettings): Promise<AppSettings> {
  const local = settings.models?.providers?.local;
  if (!local || local.enabled === false) return settings;
  const discovery = await getLocalProviderDiscoverySnapshot(local);
  return applyLocalProviderDiscoverySnapshot(settings, discovery);
}

function sanitizeSettingsForUser(settings: AppSettings): AppSettings {
  const sanitized = cloneSettings(settings);

  if (sanitized.models?.providers) {
    for (const providerConfig of Object.values(sanitized.models.providers)) {
      providerConfig.apiKeyConfigured = Boolean(
        providerConfig.apiKey
        || providerConfig.apiKeyConfigured
        || providerConfig.managedByCloud,
      );
      delete providerConfig.apiKey;
    }
  }

  if (sanitized.cloud) {
    delete sanitized.cloud.apiKey;
  }
  if (sanitized.langfuse) {
    delete (sanitized.langfuse as Partial<NonNullable<AppSettings['langfuse']>>).secretKey;
  }

  delete sanitized.mcp;
  delete sanitized.budget;
  delete sanitized.sanitization;
  delete sanitized.confirmationGate;

  if (sanitized.permissions) {
    sanitized.permissions.devModeAutoApprove = false;
    if (sanitized.permissions.permissionMode === 'bypassPermissions') {
      sanitized.permissions.permissionMode = 'default';
    }
    sanitized.permissions.blockedCommands = [];
    delete sanitized.permissions.deny;
    delete sanitized.permissions.ask;
    delete sanitized.permissions.allow;
    delete sanitized.permissions._legacyPermissions;
  }

  return sanitized;
}

function extractSettingsUpdate(
  payload: { settings?: Partial<AppSettings> } | Partial<AppSettings> | unknown,
): Partial<AppSettings> {
  if (payload && typeof payload === 'object' && 'settings' in payload) {
    return ((payload as { settings?: Partial<AppSettings> }).settings ?? {}) as Partial<AppSettings>;
  }
  return ((payload ?? {}) as Partial<AppSettings>);
}

function settingsUpdateRequiresAdmin(updates: Partial<AppSettings>): boolean {
  const adminOnlyKeys: Array<keyof AppSettings> = [
    'permissions',
    'cloud',
    'mcp',
    'supabase',
    'cloudApi',
    'langfuse',
    'sanitization',
    'confirmationGate',
    'budget',
  ];

  return adminOnlyKeys.some((key) => Object.prototype.hasOwnProperty.call(updates, key));
}

function settingsActionRequiresAdmin(action: string, payload: unknown): boolean {
  if (action === 'set') {
    return settingsUpdateRequiresAdmin(extractSettingsUpdate(payload));
  }

  return action === 'getDevMode'
    || action === 'setDevMode'
    || action === 'setServiceApiKey'
    || action === 'getServiceApiKey'
    || action === 'getAllServiceKeys';
}

async function handleSet(
  getConfigService: () => ConfigService | null,
  payload: { settings?: Partial<AppSettings> } | Partial<AppSettings>
): Promise<void> {
  const configService = getConfigService();
  if (!configService) throw new Error('Config service not initialized');
  const updates = extractSettingsUpdate(payload);
  await configService.updateSettings((updates ?? {}) as Partial<AppSettings>);
}

async function handleTestApiKey(payload: { provider: string; apiKey: string }): Promise<{ success: boolean; error?: string }> {
  const testEndpoints: Record<string, { url: string; headers: Record<string, string>; body: unknown }> = {
    deepseek: { url: `${MODEL_API_ENDPOINTS.deepseek}/models`, headers: { Authorization: `Bearer ${payload.apiKey}` }, body: null },
    openai: { url: `${MODEL_API_ENDPOINTS.openai}/models`, headers: { Authorization: `Bearer ${payload.apiKey}` }, body: null },
    claude: {
      url: `${MODEL_API_ENDPOINTS.claude}/messages`,
      headers: { 'x-api-key': payload.apiKey, 'anthropic-version': API_VERSIONS.ANTHROPIC, 'content-type': 'application/json' },
      body: { model: resolveConnectionTestModel('claude'), max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] },
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

async function handleCheckApiKeyConfigured(getConfigService: () => ConfigService | null): Promise<boolean> {
  const configService = getConfigService();
  const settings = configService ? await handleGet(getConfigService) : undefined;
  if (settings?.models?.providers) {
    for (const [provider, providerConfig] of Object.entries(settings.models.providers)) {
      if (providerConfig?.enabled !== false && isRuntimeProviderConfigured(provider as ModelProvider, providerConfig)) {
        return true;
      }
    }
  }

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
    'OPENROUTER_API_KEY', 'PERPLEXITY_API_KEY', 'LONGCAT_API_KEY',
    'XIAOMI_API_KEY',
  ];
  return envKeyNames.some(name => !!process.env[name]);
}

async function handleSetServiceApiKey(
  getConfigService: () => ConfigService | null,
  payload: { service: ServiceApiKey; apiKey: string }
): Promise<void> {
  const configService = getConfigService();
  if (!configService) throw new Error('Config service not initialized');
  await configService.setServiceApiKey(payload.service, payload.apiKey);
}

async function handleGetServiceApiKey(
  getConfigService: () => ConfigService | null,
  payload: { service: ServiceApiKey }
): Promise<string | undefined> {
  const configService = getConfigService();
  if (!configService) throw new Error('Config service not initialized');
  return configService.getServiceApiKey(payload.service);
}

async function handleGetAllServiceKeys(
  getConfigService: () => ConfigService | null
): Promise<{
  brave?: string;
  firecrawl?: string;
  github?: string;
  openrouter?: string;
  langfuse_public?: string;
  langfuse_secret?: string;
  exa?: string;
  perplexity?: string;
  tavily?: string;
}> {
  const configService = getConfigService();
  if (!configService) throw new Error('Config service not initialized');

  const services = [
    'brave',
    'firecrawl',
    'github',
    'openrouter',
    'langfuse_public',
    'langfuse_secret',
    'exa',
    'perplexity',
    'tavily',
  ] as const;
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

async function handleGetBudgetStatus(): Promise<unknown> {
  const { getBudgetService } = await import('../services/core/budgetService');
  const service = getBudgetService();
  // 状态（含用量百分比/告警级别）+ 配置（enabled/上限）+ 缓存节省 + token 用量汇总一并回给 UI
  return {
    ...service.checkBudget(),
    config: service.getConfig(),
    cacheSavings: service.getCacheSavingsSummary(),
    tokenUsage: service.getTokenUsageSummary(),
  };
}

async function handleSetBudgetConfig(
  getConfigService: () => ConfigService | null,
  payload: { budget?: Partial<NonNullable<AppSettings['budget']>> } | Partial<NonNullable<AppSettings['budget']>>,
): Promise<void> {
  const configService = getConfigService();
  if (!configService) throw new Error('Config service not initialized');
  // Codex audit F3：先确认 payload 是对象再用 'in'，否则 null/数字等畸形 payload 会抛。
  const obj = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const budget = (obj.budget && typeof obj.budget === 'object' ? obj.budget : obj) as Partial<NonNullable<AppSettings['budget']>>;
  await configService.setBudgetConfig(budget);
  // Item4①：持久化后同步运行时单例，否则单例还跑旧配置（启动期硬编码默认）。
  const { syncBudgetServiceFromConfig } = await import('../services/core/budgetService');
  syncBudgetServiceFromConfig(configService.getBudgetConfig());
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
      if (settingsActionRequiresAdmin(action, payload)) {
        const accessError = getAdminAccessIpcError('Settings');
        if (accessError) return accessError;
      }

      let data: unknown;

      switch (action) {
        case 'get':
          data = await handleGet(getConfigService);
          if (!isCurrentUserAdmin()) {
            data = sanitizeSettingsForUser(data as AppSettings);
          }
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
          data = await handleCheckApiKeyConfigured(getConfigService);
          break;
        case 'saveProviderIconAsset':
          {
            const iconPayload = payload as { provider?: string; dataUrl?: string };
            data = await saveProviderIconAsset({
              provider: iconPayload.provider ?? '',
              dataUrl: iconPayload.dataUrl ?? '',
            });
          }
          break;
        case 'resolveProviderIconAsset':
          data = await resolveProviderIconAsset((payload as { icon?: string })?.icon ?? '');
          break;
        case 'setServiceApiKey':
          await handleSetServiceApiKey(getConfigService, payload as { service: ServiceApiKey; apiKey: string });
          data = null;
          break;
        case 'getServiceApiKey':
          data = await handleGetServiceApiKey(getConfigService, payload as { service: ServiceApiKey });
          break;
        case 'getAllServiceKeys':
          data = await handleGetAllServiceKeys(getConfigService);
          break;
        case 'getBudgetStatus':
          data = await handleGetBudgetStatus();
          break;
        case 'setBudgetConfig':
          await handleSetBudgetConfig(getConfigService, payload as Parameters<typeof handleSetBudgetConfig>[1]);
          data = null;
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
    const { AppWindow } = await import('../platform');
    const mainWindow = AppWindow.getFocusedWindow();

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
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_INTEGRATION, async (_, integration: string) => {
    assertAdminAccess('Integration settings');
    return handleGetIntegration(getConfigService, integration);
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET_INTEGRATION, async (_, payload: { integration: string; config: Record<string, string> }) => {
    assertAdminAccess('Integration settings');
    return handleSetIntegration(getConfigService, payload);
  });

  /** @deprecated Use IPC_DOMAINS.WINDOW with action: 'minimize' */
  ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, async () => {
    const { AppWindow } = await import('../platform');
    AppWindow.getFocusedWindow()?.minimize();
  });

  /** @deprecated Use IPC_DOMAINS.WINDOW with action: 'maximize' */
  ipcMain.handle(IPC_CHANNELS.WINDOW_MAXIMIZE, async () => {
    const { AppWindow } = await import('../platform');
    const mainWindow = AppWindow.getFocusedWindow();
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });

  /** @deprecated Use IPC_DOMAINS.WINDOW with action: 'close' */
  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, async () => {
    const { AppWindow } = await import('../platform');
    AppWindow.getFocusedWindow()?.close();
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

  // ── Excel 行号：两个 extract handler 的唯一共用谓词 ──────────────────────
  //
  // extract-excel-json（预览）和 extract-excel-text（喂模型）必须从**同一个**
  // 谓词推行号，否则就是 ADR-040 那个故事重演：预览算出的 A1 和模型推出的 A1
  // 是两套坐标系，谁也不知道对方错了。`6ac3d8530` 修了预览这侧，text 这侧却在
  // 26 行之外继续用 blankrows:false——同一个文件、同一个左移、漏了一半。

  const isBlankRow = (row: unknown[] | undefined): boolean =>
    !row || row.length === 0 || row.every((cell) => cell === null || cell === undefined || cell === '');

  /**
   * xlsx sheet → 保留真实行号对齐的行数组：`结果[i]` 就是 xlsx 第 `i+1` 行。
   *
   * blankrows 必须为 true——中间空行是行号对齐的一部分，丢掉会让后面每行都左移。
   * 但 `!ref` 常被文件虚标（几行数据声明到几百行），所以尾部空行要裁掉：只裁尾巴。
   */
  const sheetRowsWithRealNumbers = (
    XLSX: typeof import('xlsx'),
    sheet: import('xlsx').WorkSheet,
    options: { raw?: boolean } = {},
  ): { rows: unknown[][]; rangeStart: SheetRangeStart } => {
    // sheet_to_json 会把 used range 左上角归一成数组 [0][0]；真实起点必须从同一份
    // !ref 解一次后随结果向下传，不能让 text / preview 各自猜 A1。
    const decodedStart = sheet['!ref']
      ? XLSX.utils.decode_range(sheet['!ref']).s
      : { r: 0, c: 0 };
    const rangeStart = { row: decodedStart.r, column: decodedStart.c };
    const json: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      blankrows: true,
      ...options,
    });
    let end = json.length;
    while (end > 0 && isBlankRow(json[end - 1])) end--;
    return { rows: json.slice(0, end), rangeStart };
  };

  const SHEET_ROWNUM_LEGEND = '第 1 列是 xlsx 真实行号，可直接用于 A1 引用（行号 4 + B 列 = B4）；行号跳号处是空行';

  /**
   * 行数组 → 带真实行号的 CSV。
   *
   * 行号塞进每行的第 0 列、再让 XLSX 自己序列化，而不是对 sheet_to_csv 的输出
   * 按行加前缀——后者看着更省事，实则会重新引入本工单要修的那个错位：单元格里
   * 含换行符时 sheet_to_csv 对 4 行 xlsx 吐 5 行文本，按行下标推出来的行号从那
   * 一行起全错（实测：「四月」会被标成 R5）。把行号绑进数据就不受文本换行影响，
   * 转义也全部归 XLSX，不用手搓 CSV quoting。
   */
  const rowsToNumberedCsv = (
    XLSX: typeof import('xlsx'),
    trimmed: unknown[][],
    rangeStart: SheetRangeStart,
  ): string => {
    const numbered = trimmed
      .map((row, index) => [resolveSheetCoordinate(index, 0, rangeStart).row, ...(row || [])])
      .filter((row) => !isBlankRow(row.slice(1)));
    return XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(numbered));
  };

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
        // 模型上下文需要单元格展示文本（w），否则日期/百分比会退化成序列号；
        // preview 不传此选项，继续保留 raw 数值供交互渲染和定位使用。
        const { rows: trimmed, rangeStart } = sheetRowsWithRealNumbers(
          XLSX,
          workbook.Sheets[sheetName],
          { raw: false },
        );
        const csv = rowsToNumberedCsv(XLSX, trimmed, rangeStart);
        totalRows += Math.max(trimmed.length - 1, 0);

        sheets.push(`=== Sheet: ${sheetName} (${SHEET_ROWNUM_LEGEND}) ===\n${csv}`);
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
    sheets: Array<{
      name: string;
      headers: string[];
      rows: unknown[][];
      rowCount: number;
      rangeStart?: SheetRangeStart;
    }>;
    sheetCount: number;
  }> => {
    try {
      const fs = await import('fs');
      const XLSX = await import('xlsx');

      const buffer = fs.readFileSync(filePath);
      const workbook = XLSX.read(buffer, { type: 'buffer' });

      const sheets = workbook.SheetNames.map((sheetName: string) => {
        // 行号谓词与 extract-excel-text 共用（见 sheetRowsWithRealNumbers）：预览里的
        // 数组下标是 UI 算 A1（B7）的依据，而定点反馈把这个 A1 交给 DocEdit 直接改
        // 源文件；模型侧看到的行号必须是同一套，否则两侧各错各的谁也照不出来。
        const { rows: trimmed, rangeStart } = sheetRowsWithRealNumbers(XLSX, workbook.Sheets[sheetName]);
        const headers = (trimmed[0] || []) as string[];
        const rows = trimmed.slice(1, 501); // Cap at 500 rows for UI performance
        return {
          name: sheetName,
          headers,
          rows,
          rowCount: Math.max(trimmed.length - 1, 0),
          // A1 是主路径，保持 JSON 逐字节不变；只有真实存在偏移时才扩展契约。
          ...(rangeStart.row !== 0 || rangeStart.column !== 0 ? { rangeStart } : {}),
        };
      });

      return { sheets, sheetCount: workbook.SheetNames.length };
    } catch (error) {
      return { sheets: [], sheetCount: 0 };
    }
  });

  // Word (.docx) → structured HTML + paragraphs (for DocumentBlock interactive rendering)
  ipcMain.handle('extract-docx-html', async (_, filePath: string): Promise<{
    html: string;
    paragraphs: Array<{
      index: number;
      type: string;
      text: string;
      level?: number;
      textFingerprint: string;
      previousTextFingerprint?: string;
      nextTextFingerprint?: string;
    }>;
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

      // mammoth 只负责富文本 HTML / raw text；可执行坐标必须来自 document.xml 全量
      // `<w:p>` 序列，否则空段落与表格段落会把后续 index 静默左移。
      const paragraphs = await extractDocxParagraphsFromBuffer(buffer);

      const wordCount = rawText.split(/\s+/).filter(Boolean).length;

      return { html, paragraphs, text: rawText, wordCount };
    } catch (error) {
      return { html: '', paragraphs: [], text: '', wordCount: 0 };
    }
  });

  // Tool create response handler removed (evolution module deleted)

  // Permission mode handlers
  ipcMain.handle(IPC_CHANNELS.PERMISSION_GET_MODE, async () => {
    assertAdminAccess('Permission mode');
    const { getPermissionModeManager } = await import('../permissions/modes');
    return getPermissionModeManager().getMode();
  });

  ipcMain.handle(IPC_CHANNELS.PERMISSION_SET_MODE, async (_, mode: string) => {
    assertAdminAccess('Permission mode');
    const { getPermissionModeManager } = await import('../permissions/modes');
    const validModes = ['default', 'readOnly', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'plan', 'delegate'];
    if (!validModes.includes(mode)) {
      return false;
    }
    // bypassPermissions 需要用户审批
    const approved = mode === 'bypassPermissions';
    const result = getPermissionModeManager().setMode(mode as 'default' | 'readOnly' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'plan' | 'delegate', approved);

    // 持久化权限模式到 config（重启/重装后恢复）——直接写 settings 并广播，
    // 不经任何 pending 中转 state（单一真源纪律）。
    if (result) {
      const configService = getConfigService();
      if (configService) {
        await configService.updateSettings({
          permissions: { permissionMode: mode as AppSettings['permissions']['permissionMode'] },
        } as Partial<AppSettings>);
      }
      broadcastToRenderer(IPC_CHANNELS.PERMISSION_MODE_CHANGED, { scope: 'default', mode });
    }

    return result;
  });
}
