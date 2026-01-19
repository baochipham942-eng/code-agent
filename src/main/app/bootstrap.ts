// ============================================================================
// Bootstrap - 服务初始化
// ============================================================================

import { app } from 'electron';
import path from 'path';
import {
  ConfigService,
  initDatabase,
  initSupabase,
  isSupabaseInitialized,
  getAuthService,
  getSyncService,
  initLangfuse,
} from '../services';
import { initUpdateService } from '../services/cloud/UpdateService';
import { initMemoryService } from '../memory/MemoryService';
import { initMCPClient, getMCPClient, type MCPServerConfig } from '../mcp/MCPClient';
import { initPromptService, getPromptsInfo } from '../services/cloud/PromptService';
import { initCloudConfigService, getCloudConfigService } from '../services/cloud';
import { initCloudTaskService } from '../cloud/CloudTaskService';
import { initUnifiedOrchestrator } from '../orchestrator';
import { logBridge } from '../mcp/LogBridge.js';
import { getMainWindow } from './window';
import { IPC_CHANNELS } from '../../shared/ipc';

// Global state
let configService: ConfigService | null = null;

/**
 * 获取配置服务实例
 */
export function getConfigServiceInstance(): ConfigService | null {
  return configService;
}

/**
 * 核心服务初始化 - 必须在窗口创建前完成
 * 只包含 IPC handlers 依赖的最小服务集
 */
export async function initializeCoreServices(): Promise<ConfigService> {
  // Initialize config service
  configService = new ConfigService();
  await configService.initialize();

  // Initialize database (SQLite persistence)
  await initDatabase();
  const userDataPath = app.getPath('userData');
  console.log('Database initialized at:', path.join(userDataPath, 'code-agent.db'));

  // Initialize memory service (needed for session management)
  initMemoryService({
    maxRecentMessages: 10,
    toolCacheTTL: 5 * 60 * 1000,
    maxSessionMessages: 100,
    maxRAGResults: 5,
    ragTokenLimit: 2000,
  });
  console.log('Memory service initialized');

  console.log('[Init] Core services initialized');
  return configService;
}

/**
 * 后台服务初始化 - 窗口创建后异步执行
 * 不阻塞用户交互
 */
export async function initializeBackgroundServices(): Promise<void> {
  if (!configService) {
    throw new Error('Core services not initialized');
  }

  console.log('[Init] Starting background services...');

  const settings = configService.getSettings();

  // Restore devModeAutoApprove from persistent storage
  try {
    const { getSecureStorage } = await import('../services/core/SecureStorage');
    const storage = getSecureStorage();
    const persistedValue = storage.get('settings.devModeAutoApprove');
    if (persistedValue !== undefined) {
      const enabled = persistedValue === 'true';
      const currentSettings = configService.getSettings();
      if (currentSettings.permissions.devModeAutoApprove !== enabled) {
        await configService.updateSettings({
          permissions: {
            ...currentSettings.permissions,
            devModeAutoApprove: enabled,
          },
        });
        console.log('[Init] Restored devModeAutoApprove from persistent storage:', enabled);
      }
    }
  } catch (error) {
    console.warn('[Init] Failed to restore devModeAutoApprove from persistent storage:', error);
  }

  // Initialize the rest of services
  await initializeServices();
}

/**
 * 完整服务初始化（后台执行）
 */
async function initializeServices(): Promise<void> {
  if (!configService) {
    throw new Error('Config service not initialized');
  }

  const settings = configService.getSettings();
  const mainWindow = getMainWindow();

  // Initialize CloudConfigService ASYNC (non-blocking)
  initCloudConfigService()
    .then(() => {
      const info = getCloudConfigService().getInfo();
      console.log(`[CloudConfig] Source: ${info.fromCloud ? 'cloud' : 'builtin'}, version: ${info.version}`);
    })
    .catch((error) => {
      console.warn('[CloudConfig] Init failed (using builtin):', error);
    });

  // Initialize PromptService ASYNC (non-blocking)
  initPromptService()
    .then(() => {
      const info = getPromptsInfo();
      console.log(`[PromptService] Source: ${info.source}, version: ${info.version || 'builtin'}`);
    })
    .catch((error) => {
      console.warn('[PromptService] Init failed (using builtin):', error);
    });

  // Initialize MCP client ASYNC (non-blocking)
  const mcpConfigs: MCPServerConfig[] = settings.mcp?.servers || [];
  console.log(`[MCP] Initializing ${mcpConfigs.length} custom server(s) in background...`);
  initMCPClient(mcpConfigs)
    .then(() => {
      const mcpClient = getMCPClient();
      const status = mcpClient.getStatus();
      console.log(`[MCP] Connected: ${status.connectedServers.join(', ') || 'none'}`);
      console.log(`[MCP] Available: ${status.toolCount} tools, ${status.resourceCount} resources`);
    })
    .catch((error) => {
      console.error('[MCP] Failed to initialize (non-blocking):', error);
    });

  // Setup LogBridge command handler
  await setupLogBridge();

  // Initialize Supabase (if configured)
  const supabaseUrl = process.env.SUPABASE_URL || settings.supabase?.url;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || settings.supabase?.anonKey;

  if (supabaseUrl && supabaseAnonKey) {
    try {
      initSupabase(supabaseUrl, supabaseAnonKey);
      console.log('Supabase initialized');

      // Set up auth change callback
      const authService = getAuthService();
      authService.addAuthChangeCallback((user) => {
        if (mainWindow) {
          mainWindow.webContents.send(IPC_CHANNELS.AUTH_EVENT, {
            type: user ? 'signed_in' : 'signed_out',
            user,
          });
        }

        // Start/stop sync based on auth state
        const syncService = getSyncService();
        if (user) {
          syncService.initialize().then(() => {
            syncService.startAutoSync(5 * 60 * 1000); // 5 minutes
            console.log('Auto-sync started');
          });
        } else {
          syncService.stopAutoSync();
          console.log('Auto-sync stopped');
        }
      });

      // Initialize auth (restore session) - NON-BLOCKING
      authService.initialize()
        .then(() => {
          console.log('Auth service initialized');
        })
        .catch((error) => {
          console.error('Failed to initialize auth (non-blocking):', error);
        });

      // Initialize unified orchestrator (cloud task execution)
      try {
        const updateServerUrl = process.env.CLOUD_API_URL || settings.cloudApi?.url || 'https://code-agent-beta.vercel.app';
        initUnifiedOrchestrator({
          cloudExecutor: {
            maxConcurrent: 3,
            defaultTimeout: 120000,
            maxIterations: 20,
            apiEndpoint: updateServerUrl,
          },
        });
        console.log('Unified orchestrator initialized');
      } catch (error: unknown) {
        console.error('Failed to initialize unified orchestrator:', error);
      }

      // Initialize cloud task service
      try {
        initCloudTaskService({});
        console.log('CloudTaskService initialized');
      } catch (error: unknown) {
        console.error('Failed to initialize CloudTaskService:', error);
      }
    } catch (error) {
      console.error('Failed to initialize Supabase:', error);
    }
  } else {
    console.log('Supabase not configured (offline mode)');
  }

  // Initialize Langfuse (analytics, if configured)
  const langfusePublicKey = process.env.LANGFUSE_PUBLIC_KEY || settings.langfuse?.publicKey;
  const langfuseSecretKey = process.env.LANGFUSE_SECRET_KEY || settings.langfuse?.secretKey;
  if (langfusePublicKey && langfuseSecretKey) {
    initLangfuse({
      publicKey: langfusePublicKey,
      secretKey: langfuseSecretKey,
      baseUrl: process.env.LANGFUSE_BASE_URL || settings.langfuse?.baseUrl || 'https://cloud.langfuse.com',
    });
    console.log('Langfuse initialized');
  }

  // Initialize update service
  try {
    const updateServerUrl = process.env.CLOUD_API_URL || settings.cloudApi?.url || 'https://code-agent-beta.vercel.app';
    initUpdateService({
      updateServerUrl,
      checkInterval: 60 * 60 * 1000, // Check every hour
      autoDownload: false,
    });
    console.log('Update service initialized, server:', updateServerUrl);
  } catch (error: unknown) {
    console.error('Failed to initialize update service:', error);
  }

  console.log('[Init] Background services initialization complete');
}

/**
 * 设置 LogBridge 命令处理器
 */
async function setupLogBridge(): Promise<void> {
  logBridge.setCommandHandler(async (command, params) => {
    console.log(`[LogBridge] Executing command: ${command}`, params);

    // Import browser service dynamically to avoid circular dependencies
    const { browserService } = await import('../services/infra/BrowserService.js');

    switch (command) {
      case 'browser_action': {
        const action = params.action as string;
        if (!action) {
          return { success: false, error: 'Missing action parameter' };
        }

        try {
          switch (action) {
            case 'launch':
              await browserService.launch();
              return { success: true, output: 'Browser launched' };

            case 'close':
              await browserService.close();
              return { success: true, output: 'Browser closed' };

            case 'new_tab':
              const tabId = await browserService.newTab(params.url as string);
              return { success: true, output: `New tab created: ${tabId}` };

            case 'navigate':
              await browserService.navigate(params.url as string, params.tabId as string);
              return { success: true, output: `Navigated to ${params.url}` };

            case 'screenshot':
              const result = await browserService.screenshot({
                fullPage: params.fullPage as boolean,
                tabId: params.tabId as string,
              });
              return {
                success: result.success,
                output: result.path ? `Screenshot saved: ${result.path}` : undefined,
                error: result.error,
              };

            case 'get_content':
              const content = await browserService.getPageContent(params.tabId as string);
              return {
                success: true,
                output: `URL: ${content.url}\nTitle: ${content.title}\n\n${content.text.substring(0, 2000)}...`,
              };

            case 'click':
              await browserService.click(params.selector as string, params.tabId as string);
              return { success: true, output: `Clicked: ${params.selector}` };

            case 'type':
              await browserService.type(
                params.selector as string,
                params.text as string,
                params.tabId as string
              );
              return { success: true, output: `Typed into: ${params.selector}` };

            case 'get_logs':
              const logs = browserService.logger.getLogsAsString(params.count as number || 20);
              return { success: true, output: logs };

            case 'press_key':
              await browserService.pressKey(params.key as string, params.tabId as string);
              return { success: true, output: `Pressed key: ${params.key}` };

            case 'scroll':
              await browserService.scroll(
                params.direction as 'up' | 'down',
                params.amount as number,
                params.tabId as string
              );
              return { success: true, output: `Scrolled ${params.direction}` };

            default:
              return { success: false, error: `Unknown browser action: ${action}` };
          }
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      case 'ping':
        return { success: true, output: 'pong' };

      default:
        return { success: false, error: `Unknown command: ${command}` };
    }
  });

  // Start Log Bridge server in background
  logBridge.start()
    .then(() => {
      console.log('[LogBridge] Started on port', logBridge.getPort());
    })
    .catch((error) => {
      console.error('[LogBridge] Failed to start (non-blocking):', error);
    });
}
