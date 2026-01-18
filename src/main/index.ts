// ============================================================================
// Code Agent - Main Process Entry
// ============================================================================

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import { AgentOrchestrator } from './agent/AgentOrchestrator';
import { GenerationManager } from './generation/GenerationManager';
import { ConfigService } from './services/ConfigService';
import { initDatabase, getDatabase } from './services/DatabaseService';
import { getSessionManager, type SessionCreateOptions } from './services/SessionManager';
import { initMemoryService, getMemoryService } from './memory/MemoryService';
import { initMCPClient, getMCPClient, type MCPServerConfig } from './mcp/MCPClient';
import { logBridge } from './mcp/LogBridge.js';
import { initSupabase, isSupabaseInitialized } from './services/SupabaseService';
import { getAuthService } from './services/AuthService';
import { getSyncService } from './services/SyncService';
import { initUpdateService, getUpdateService, isUpdateServiceInitialized } from './services/UpdateService';
import { initLangfuse, getLangfuseService } from './services/LangfuseService';
import { IPC_CHANNELS } from '../shared/ipc';
import type { GenerationId, PermissionResponse, PlanningState, AuthUser, UpdateInfo } from '../shared/types';
import type {
  CloudTask,
  CreateCloudTaskRequest,
  CloudTaskFilter,
  TaskSyncState,
  CloudExecutionStats,
} from '../shared/types/cloud';
import { createPlanningService, type PlanningService } from './planning';
import { CloudTaskService, getCloudTaskService, initCloudTaskService, isCloudTaskServiceInitialized } from './cloud/CloudTaskService';

// ----------------------------------------------------------------------------
// Global State
// ----------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let agentOrchestrator: AgentOrchestrator | null = null;
let generationManager: GenerationManager | null = null;
let configService: ConfigService | null = null;
let currentSessionId: string | null = null;
let planningService: PlanningService | null = null;

// ----------------------------------------------------------------------------
// Window Creation
// ----------------------------------------------------------------------------

async function createWindow(): Promise<void> {
  console.log('[Main] Creating window...');
  console.log('[Main] __dirname:', __dirname);
  console.log('[Main] preload path:', path.join(__dirname, '../preload/index.cjs'));
  console.log('[Main] renderer path:', path.join(__dirname, '../renderer/index.html'));

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#18181b',
    show: false, // Don't show until ready
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Show window when ready to prevent flicker
  mainWindow.once('ready-to-show', () => {
    console.log('[Main] Window ready to show');
    mainWindow?.show();
  });

  // Log web contents events
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('[Main] Failed to load:', errorCode, errorDescription);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Main] Page finished loading');
  });

  // Load the app
  if (process.env.NODE_ENV === 'development') {
    console.log('[Main] Loading development URL...');
    await mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    console.log('[Main] Loading production file...');
    const htmlPath = path.join(__dirname, '../renderer/index.html');
    console.log('[Main] HTML path:', htmlPath);
    await mainWindow.loadFile(htmlPath);
  }

  console.log('[Main] Window created successfully');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ----------------------------------------------------------------------------
// Initialize Services
// ----------------------------------------------------------------------------

async function initializeServices(): Promise<void> {
  // Initialize config service
  configService = new ConfigService();
  await configService.initialize();

  // Restore devModeAutoApprove from persistent storage (SecureStorage)
  // This ensures the setting survives data clear operations
  try {
    const { getSecureStorage } = await import('./services/SecureStorage');
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

  const settings = configService.getSettings();

  // Initialize database (SQLite persistence)
  await initDatabase();
  const userDataPath = app.getPath('userData');
  console.log('Database initialized at:', path.join(userDataPath, 'code-agent.db'));

  // Initialize memory service
  initMemoryService({
    maxRecentMessages: 10,
    toolCacheTTL: 5 * 60 * 1000, // 5 minutes
    maxSessionMessages: 100,
    maxRAGResults: 5,
    ragTokenLimit: 2000,
  });
  console.log('Memory service initialized');

  // Initialize MCP client (if configured)
  const mcpConfigs: MCPServerConfig[] = settings.mcp?.servers || [];
  if (mcpConfigs.length > 0) {
    try {
      await initMCPClient(mcpConfigs);
      console.log('MCP client initialized with', mcpConfigs.length, 'server(s)');
    } catch (error) {
      console.error('Failed to initialize MCP client:', error);
    }
  }

  // Start Log Bridge HTTP server for MCP server access
  try {
    await logBridge.start();
    console.log('Log Bridge started on port', logBridge.getPort());

    // Register command handler for remote execution
    logBridge.setCommandHandler(async (command, params) => {
      console.log(`[LogBridge] Executing command: ${command}`, params);

      // Import browser service dynamically to avoid circular dependencies
      const { browserService } = await import('./services/BrowserService.js');

      switch (command) {
        case 'browser_action': {
          // Execute browser action
          const action = params.action as string;
          if (!action) {
            return { success: false, error: 'Missing action parameter' };
          }

          try {
            // Map common actions to browser service methods
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

        case 'run_test': {
          // Run a predefined test script
          const testName = params.name as string;
          if (!testName) {
            return { success: false, error: 'Missing test name' };
          }

          try {
            // Execute test based on name
            switch (testName) {
              case 'self_test': {
                // Test the Code Agent client itself
                await browserService.launch();
                const tabId = await browserService.newTab('http://localhost:5173');
                await browserService.waitForTimeout(2000);
                const content = await browserService.getPageContent(tabId);
                const screenshot = await browserService.screenshot({ tabId });

                return {
                  success: true,
                  output: `Self-test completed:\n- URL: ${content.url}\n- Title: ${content.title}\n- Screenshot: ${screenshot.path}\n\nPage content preview:\n${content.text.substring(0, 500)}...`,
                };
              }

              case 'generation_selector': {
                // Test the generation selector
                await browserService.launch();
                const tabId = await browserService.newTab('http://localhost:5173');
                await browserService.waitForTimeout(2000);

                // Find and click the generation badge
                const elements = await browserService.findElements('[class*="rounded-full"]', tabId);
                if (elements.length > 0) {
                  // Click the first rounded element (likely the generation badge)
                  await browserService.click('[class*="rounded-full"]', tabId);
                  await browserService.waitForTimeout(500);
                }

                const screenshot = await browserService.screenshot({ tabId });
                return {
                  success: true,
                  output: `Generation selector test completed.\nScreenshot: ${screenshot.path}`,
                };
              }

              default:
                return { success: false, error: `Unknown test: ${testName}` };
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
  } catch (error) {
    console.error('Failed to start Log Bridge:', error);
  }

  // Initialize Supabase (if configured)
  // NOTE: Auth initialization is NON-BLOCKING to prevent startup issues
  const supabaseUrl = process.env.SUPABASE_URL || settings.supabase?.url;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || settings.supabase?.anonKey;

  if (supabaseUrl && supabaseAnonKey) {
    try {
      initSupabase(supabaseUrl, supabaseAnonKey);
      console.log('Supabase initialized');

      // Set up auth change callback BEFORE initialization
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
          });
        } else {
          syncService.stopAutoSync();
        }
      });

      // Initialize auth service ASYNC (non-blocking)
      // This prevents network issues from blocking window creation
      authService.initialize()
        .then(() => {
          console.log('Auth service initialized (async)');
        })
        .catch((error) => {
          console.error('Auth service initialization failed (non-blocking):', error);
        });
    } catch (error) {
      console.error('Failed to initialize Supabase:', error);
    }
  } else {
    console.log('Supabase not configured, skipping initialization');
  }

  // Initialize Langfuse (observability)
  const langfusePublicKey = process.env.LANGFUSE_PUBLIC_KEY || settings.langfuse?.publicKey;
  const langfuseSecretKey = process.env.LANGFUSE_SECRET_KEY || settings.langfuse?.secretKey;
  const langfuseBaseUrl = process.env.LANGFUSE_BASE_URL || settings.langfuse?.baseUrl;

  if (langfusePublicKey && langfuseSecretKey) {
    try {
      initLangfuse({
        publicKey: langfusePublicKey,
        secretKey: langfuseSecretKey,
        baseUrl: langfuseBaseUrl,
        enabled: settings.langfuse?.enabled !== false,
      });
      console.log('Langfuse initialized');
    } catch (error) {
      console.error('Failed to initialize Langfuse:', error);
    }
  } else {
    console.log('Langfuse not configured, tracing disabled');
  }

  // Initialize generation manager
  generationManager = new GenerationManager();

  // Track current assistant message for updating tool results
  let currentAssistantMessageId: string | null = null;

  // Initialize agent orchestrator
  agentOrchestrator = new AgentOrchestrator({
    generationManager,
    configService,
    onEvent: async (event) => {
      // 转发事件到渲染进程
      console.log('[Main] onEvent called:', event.type);
      if (mainWindow) {
        console.log('[Main] Sending event to renderer:', event.type);
        mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, event);
      } else {
        console.log('[Main] WARNING: mainWindow is null, cannot send event');
      }

      // 持久化保存 assistant 消息
      if (event.type === 'message' && event.data?.role === 'assistant') {
        currentAssistantMessageId = event.data.id;
        try {
          const sessionManager = getSessionManager();
          await sessionManager.addMessage(event.data);
        } catch (error) {
          console.error('Failed to save assistant message:', error);
        }
      }

      // 更新工具调用结果
      if (event.type === 'tool_call_end' && currentAssistantMessageId && event.data) {
        try {
          const sessionManager = getSessionManager();
          const session = await sessionManager.getCurrentSession();
          if (session) {
            // 找到当前消息并更新 toolCalls
            const currentMessage = session.messages.find((m) => m.id === currentAssistantMessageId);
            if (currentMessage && currentMessage.toolCalls) {
              const updatedToolCalls = currentMessage.toolCalls.map((tc) =>
                tc.id === event.data.toolCallId
                  ? { ...tc, result: event.data }
                  : tc
              );
              await sessionManager.updateMessage(currentAssistantMessageId, { toolCalls: updatedToolCalls });
            }
          }
        } catch (error) {
          console.error('Failed to update tool call result:', error);
        }
      }

      // 清理当前消息引用
      if (event.type === 'agent_complete') {
        currentAssistantMessageId = null;
      }
    },
  });

  // Set default generation
  const defaultGenId = settings.generation.default || 'gen3';
  generationManager.switchGeneration(defaultGenId);
  console.log('[Init] Generation set to:', defaultGenId);

  // Auto-restore or create session
  console.log('[Init] Initializing session...');
  await initializeSession(settings);
  console.log('[Init] Session initialized');

  // Initialize planning service for Gen 3+
  console.log('[Init] Initializing planning service...');
  await initializePlanningService();
  console.log('[Init] Planning service initialized');

  // Initialize update service
  console.log('[Init] Initializing update service...');
  const updateServerUrl = process.env.CLOUD_API_URL || settings.cloudApi?.url || 'https://code-agent-beta.vercel.app';
  initUpdateService({
    updateServerUrl,
    checkInterval: 60 * 60 * 1000, // Check every hour
    autoDownload: false,
  });

  // Set up update event callbacks
  const updateService = getUpdateService();
  updateService.setProgressCallback((progress) => {
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.UPDATE_EVENT, {
        type: 'download_progress',
        data: progress,
      });
    }
  });

  updateService.setCompleteCallback((filePath) => {
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.UPDATE_EVENT, {
        type: 'download_complete',
        data: { filePath },
      });
    }
  });

  updateService.setErrorCallback((error) => {
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.UPDATE_EVENT, {
        type: 'download_error',
        data: { error: error.message },
      });
    }
  });

  // Start auto-check for updates (after a delay to not block startup)
  setTimeout(() => {
    updateService.checkForUpdates().then((info) => {
      if (info.hasUpdate && mainWindow) {
        mainWindow.webContents.send(IPC_CHANNELS.UPDATE_EVENT, {
          type: 'update_available',
          data: info,
        });
      }
    }).catch((err) => {
      console.error('[Main] Update check failed:', err);
    });
  }, 5000); // Check 5 seconds after startup

  console.log('Update service initialized, server:', updateServerUrl);
  console.log('[Init] initializeServices completed');
}

async function initializePlanningService(): Promise<void> {
  if (!agentOrchestrator || !currentSessionId) return;

  const workingDir = agentOrchestrator.getWorkingDirectory();
  console.log('[Main] initializePlanningService - workingDir:', workingDir);

  // Fallback to app userData if workingDir is '/' (packaged Electron app issue)
  const effectiveWorkingDir = workingDir && workingDir !== '/'
    ? workingDir
    : app.getPath('userData');

  console.log('[Main] initializePlanningService - effectiveWorkingDir:', effectiveWorkingDir);

  if (!effectiveWorkingDir) return;

  planningService = createPlanningService(effectiveWorkingDir, currentSessionId);
  console.log('Planning service initialized at:', effectiveWorkingDir);

  // Pass planning service to agent orchestrator
  agentOrchestrator.setPlanningService(planningService);

  // Send initial planning state to renderer
  sendPlanningStateToRenderer();
}

async function sendPlanningStateToRenderer(): Promise<void> {
  if (!planningService || !mainWindow) return;

  try {
    const plan = await planningService.plan.read();
    const findings = await planningService.findings.getAll();
    const errors = await planningService.errors.getAll();

    const state: PlanningState = {
      plan,
      findings,
      errors,
    };

    mainWindow.webContents.send(IPC_CHANNELS.PLANNING_EVENT, {
      type: 'plan_updated',
      data: state,
    });
  } catch (error) {
    console.error('Failed to send planning state:', error);
  }
}

async function initializeSession(settings: any): Promise<void> {
  const sessionManager = getSessionManager();
  const memoryService = getMemoryService();

  // Try to restore most recent session or create new one
  const recentSession = await sessionManager.getMostRecentSession();

  if (recentSession && settings.session?.autoRestore !== false) {
    // Restore existing session
    await sessionManager.restoreSession(recentSession.id);
    currentSessionId = recentSession.id;
    console.log('Restored session:', recentSession.id);
  } else {
    // Create new session
    const session = await sessionManager.createSession({
      title: 'New Session',
      generationId: settings.generation.default || 'gen3',
      modelConfig: {
        provider: settings.model?.provider || 'deepseek',
        model: settings.model?.model || 'deepseek-chat',
        temperature: settings.model?.temperature || 0.7,
        maxTokens: settings.model?.maxTokens || 4096,
      },
      workingDirectory: agentOrchestrator?.getWorkingDirectory(),
    });
    sessionManager.setCurrentSession(session.id);
    currentSessionId = session.id;
    console.log('Created new session:', session.id);
  }

  // Set memory service context
  memoryService.setContext(
    currentSessionId!,
    agentOrchestrator?.getWorkingDirectory() || undefined
  );
}

// ----------------------------------------------------------------------------
// IPC Handlers
// ----------------------------------------------------------------------------

function setupIpcHandlers(): void {
  // -------------------------------------------------------------------------
  // Agent Handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.AGENT_SEND_MESSAGE, async (_, content: string) => {
    console.log('[IPC] AGENT_SEND_MESSAGE received:', content.substring(0, 50));
    if (!agentOrchestrator) throw new Error('Agent not initialized');
    try {
      await agentOrchestrator.sendMessage(content);
      console.log('[IPC] AGENT_SEND_MESSAGE completed');
    } catch (error) {
      console.error('[IPC] AGENT_SEND_MESSAGE error:', error);
      throw error;
    }
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_CANCEL, async () => {
    if (!agentOrchestrator) throw new Error('Agent not initialized');
    await agentOrchestrator.cancel();
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
    async (_, requestId: string, response: PermissionResponse) => {
      if (!agentOrchestrator) throw new Error('Agent not initialized');
      agentOrchestrator.handlePermissionResponse(requestId, response);
    }
  );

  // -------------------------------------------------------------------------
  // Generation Handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.GENERATION_LIST, async () => {
    if (!generationManager) throw new Error('Generation manager not initialized');
    return generationManager.getAllGenerations();
  });

  ipcMain.handle(IPC_CHANNELS.GENERATION_SWITCH, async (_, id: GenerationId) => {
    if (!generationManager) throw new Error('Generation manager not initialized');
    return generationManager.switchGeneration(id);
  });

  ipcMain.handle(IPC_CHANNELS.GENERATION_GET_PROMPT, async (_, id: GenerationId) => {
    if (!generationManager) throw new Error('Generation manager not initialized');
    return generationManager.getPrompt(id);
  });

  ipcMain.handle(
    IPC_CHANNELS.GENERATION_COMPARE,
    async (_, id1: GenerationId, id2: GenerationId) => {
      if (!generationManager) throw new Error('Generation manager not initialized');
      return generationManager.compareGenerations(id1, id2);
    }
  );

  ipcMain.handle(IPC_CHANNELS.GENERATION_GET_CURRENT, async () => {
    if (!generationManager) throw new Error('Generation manager not initialized');
    return generationManager.getCurrentGeneration();
  });

  // -------------------------------------------------------------------------
  // Session Handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => {
    const sessionManager = getSessionManager();
    return sessionManager.listSessions();
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, async (_, title?: string) => {
    if (!configService || !generationManager) {
      throw new Error('Services not initialized');
    }

    const sessionManager = getSessionManager();
    const memoryService = getMemoryService();
    const settings = configService.getSettings();
    const currentGen = generationManager.getCurrentGeneration();

    const session = await sessionManager.createSession({
      title: title || 'New Session',
      generationId: currentGen.id,
      modelConfig: {
        provider: settings.model?.provider || 'deepseek',
        model: settings.model?.model || 'deepseek-chat',
        temperature: settings.model?.temperature || 0.7,
        maxTokens: settings.model?.maxTokens || 4096,
      },
      workingDirectory: agentOrchestrator?.getWorkingDirectory(),
    });

    sessionManager.setCurrentSession(session.id);
    currentSessionId = session.id;

    // Update memory service context
    memoryService.setContext(
      session.id,
      agentOrchestrator?.getWorkingDirectory() || undefined
    );

    return session;
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_LOAD, async (_, sessionId: string) => {
    const sessionManager = getSessionManager();
    const memoryService = getMemoryService();

    const session = await sessionManager.restoreSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    currentSessionId = sessionId;

    // Update memory service context
    memoryService.setContext(
      sessionId,
      session.workingDirectory || undefined
    );

    // Update working directory if session has one
    if (session.workingDirectory && agentOrchestrator) {
      agentOrchestrator.setWorkingDirectory(session.workingDirectory);
    }

    return session;
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_, sessionId: string) => {
    const sessionManager = getSessionManager();
    await sessionManager.deleteSession(sessionId);

    // If deleted current session, create a new one
    if (sessionId === currentSessionId) {
      const settings = configService!.getSettings();
      const currentGen = generationManager!.getCurrentGeneration();

      const newSession = await sessionManager.createSession({
        title: 'New Session',
        generationId: currentGen.id,
        modelConfig: {
          provider: settings.model?.provider || 'deepseek',
          model: settings.model?.model || 'deepseek-chat',
          temperature: settings.model?.temperature || 0.7,
          maxTokens: settings.model?.maxTokens || 4096,
        },
      });

      sessionManager.setCurrentSession(newSession.id);
      currentSessionId = newSession.id;

      const memoryService = getMemoryService();
      memoryService.setContext(newSession.id);
    }
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_GET_MESSAGES, async (_, sessionId: string) => {
    const sessionManager = getSessionManager();
    return sessionManager.getMessages(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_EXPORT, async (_, sessionId: string) => {
    const sessionManager = getSessionManager();
    return sessionManager.exportSession(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_IMPORT, async (_, data: any) => {
    const sessionManager = getSessionManager();
    return sessionManager.importSession(data);
  });

  // -------------------------------------------------------------------------
  // Memory Handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.MEMORY_GET_CONTEXT, async (_, query: string) => {
    const memoryService = getMemoryService();
    const ragContext = memoryService.getRAGContext(query);
    const projectKnowledge = memoryService.getProjectKnowledge();
    const relevantCode = memoryService.searchRelevantCode(query);
    const relevantConversations = memoryService.searchRelevantConversations(query);

    return {
      ragContext,
      projectKnowledge: projectKnowledge.map(k => ({ key: k.key, value: k.value })),
      relevantCode,
      relevantConversations,
    };
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_SEARCH_CODE, async (_, query: string, topK?: number) => {
    const memoryService = getMemoryService();
    return memoryService.searchRelevantCode(query, topK);
  });

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_SEARCH_CONVERSATIONS,
    async (_, query: string, topK?: number) => {
      const memoryService = getMemoryService();
      return memoryService.searchRelevantConversations(query, topK);
    }
  );

  ipcMain.handle(IPC_CHANNELS.MEMORY_GET_STATS, async () => {
    const db = getDatabase();
    const sessionManager = getSessionManager();
    const mcpClient = getMCPClient();

    const sessions = await sessionManager.listSessions();
    const mcpStatus = mcpClient.getStatus();

    return {
      sessionCount: sessions.length,
      messageCount: sessions.reduce((sum, s) => sum + s.messageCount, 0),
      toolCacheSize: 0, // Would need to expose this from ToolCache
      vectorStoreSize: 0, // Would need to expose this from VectorStore
      projectKnowledgeCount: 0, // Would need to aggregate across all projects
    };
  });

  // -------------------------------------------------------------------------
  // MCP Handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.MCP_GET_STATUS, async () => {
    const mcpClient = getMCPClient();
    return mcpClient.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.MCP_LIST_TOOLS, async () => {
    const mcpClient = getMCPClient();
    return mcpClient.getTools();
  });

  ipcMain.handle(IPC_CHANNELS.MCP_LIST_RESOURCES, async () => {
    const mcpClient = getMCPClient();
    return mcpClient.getResources();
  });

  // -------------------------------------------------------------------------
  // Workspace Handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SELECT_DIRECTORY, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: 'Select Working Directory',
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const selectedPath = result.filePaths[0];

    // Update agent working directory
    if (agentOrchestrator) {
      agentOrchestrator.setWorkingDirectory(selectedPath);
    }

    return selectedPath;
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_GET_CURRENT, async () => {
    if (!agentOrchestrator) return null;
    return agentOrchestrator.getWorkingDirectory();
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST_FILES, async (_, dirPath: string) => {
    const fs = await import('fs/promises');
    const pathModule = await import('path');

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries.map(entry => ({
        name: entry.name,
        path: pathModule.join(dirPath, entry.name),
        isDirectory: entry.isDirectory(),
      }));
    } catch (error) {
      console.error('Failed to list files:', error);
      return [];
    }
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_READ_FILE, async (_, filePath: string) => {
    const fs = await import('fs/promises');

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content;
    } catch (error) {
      console.error('Failed to read file:', error);
      throw error;
    }
  });

  // -------------------------------------------------------------------------
  // Shell Handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.SHELL_OPEN_PATH, async (_, filePath: string) => {
    const { shell } = await import('electron');
    return shell.openPath(filePath);
  });

  // -------------------------------------------------------------------------
  // Settings Handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async () => {
    if (!configService) throw new Error('Config service not initialized');
    return configService.getSettings();
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_, settings) => {
    if (!configService) throw new Error('Config service not initialized');
    await configService.updateSettings(settings);
  });

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_TEST_API_KEY,
    async (_, provider: string, apiKey: string) => {
      // TODO: Implement API key testing
      return true;
    }
  );

  // -------------------------------------------------------------------------
  // Window Handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, async () => {
    mainWindow?.minimize();
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_MAXIMIZE, async () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, async () => {
    mainWindow?.close();
  });

  // -------------------------------------------------------------------------
  // App Handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, async (): Promise<string> => {
    return app.getVersion();
  });

  // -------------------------------------------------------------------------
  // Planning Handlers (Gen 3+ persistent planning)
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.PLANNING_GET_STATE, async (): Promise<PlanningState> => {
    if (!planningService) {
      return { plan: null, findings: [], errors: [] };
    }

    try {
      const plan = await planningService.plan.read();
      const findings = await planningService.findings.getAll();
      const errors = await planningService.errors.getAll();

      return { plan, findings, errors };
    } catch (error) {
      console.error('Failed to get planning state:', error);
      return { plan: null, findings: [], errors: [] };
    }
  });

  ipcMain.handle(IPC_CHANNELS.PLANNING_GET_PLAN, async () => {
    if (!planningService) return null;
    try {
      return await planningService.plan.read();
    } catch (error) {
      console.error('Failed to get plan:', error);
      return null;
    }
  });

  ipcMain.handle(IPC_CHANNELS.PLANNING_GET_FINDINGS, async () => {
    if (!planningService) return [];
    try {
      return await planningService.findings.getAll();
    } catch (error) {
      console.error('Failed to get findings:', error);
      return [];
    }
  });

  ipcMain.handle(IPC_CHANNELS.PLANNING_GET_ERRORS, async () => {
    if (!planningService) return [];
    return await planningService.errors.getAll();
  });

  // -------------------------------------------------------------------------
  // Auth Handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.AUTH_GET_STATUS, async () => {
    const authService = getAuthService();
    return authService.getStatus();
  });

  ipcMain.handle(
    IPC_CHANNELS.AUTH_SIGN_IN_EMAIL,
    async (_, email: string, password: string) => {
      const authService = getAuthService();
      return authService.signInWithEmail(email, password);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AUTH_SIGN_UP_EMAIL,
    async (_, email: string, password: string, inviteCode?: string) => {
      const authService = getAuthService();
      return authService.signUpWithEmail(email, password, inviteCode);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AUTH_SIGN_IN_OAUTH,
    async (_, provider: 'github' | 'google') => {
      const authService = getAuthService();
      await authService.signInWithOAuth(provider);
    }
  );

  ipcMain.handle(IPC_CHANNELS.AUTH_SIGN_IN_TOKEN, async (_, token: string) => {
    const authService = getAuthService();
    return authService.signInWithQuickToken(token);
  });

  ipcMain.handle(IPC_CHANNELS.AUTH_SIGN_OUT, async () => {
    const authService = getAuthService();
    await authService.signOut();
  });

  ipcMain.handle(IPC_CHANNELS.AUTH_GET_USER, async () => {
    const authService = getAuthService();
    return authService.getCurrentUser();
  });

  ipcMain.handle(
    IPC_CHANNELS.AUTH_UPDATE_PROFILE,
    async (_, updates: Partial<AuthUser>) => {
      const authService = getAuthService();
      return authService.updateProfile(updates);
    }
  );

  ipcMain.handle(IPC_CHANNELS.AUTH_GENERATE_QUICK_TOKEN, async () => {
    const authService = getAuthService();
    return authService.generateQuickLoginToken();
  });

  // -------------------------------------------------------------------------
  // Sync Handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.SYNC_GET_STATUS, async () => {
    const syncService = getSyncService();
    return syncService.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.SYNC_START, async () => {
    const syncService = getSyncService();
    await syncService.startAutoSync();
  });

  ipcMain.handle(IPC_CHANNELS.SYNC_STOP, async () => {
    const syncService = getSyncService();
    syncService.stopAutoSync();
  });

  ipcMain.handle(IPC_CHANNELS.SYNC_FORCE_FULL, async () => {
    const syncService = getSyncService();
    const result = await syncService.forceFullSync();
    return { success: result.success, error: result.error };
  });

  ipcMain.handle(
    IPC_CHANNELS.SYNC_RESOLVE_CONFLICT,
    async (_, conflictId: string, resolution: 'local' | 'remote' | 'merge') => {
      const syncService = getSyncService();
      await syncService.resolveConflict(conflictId, resolution);
    }
  );

  // -------------------------------------------------------------------------
  // Device Handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.DEVICE_REGISTER, async () => {
    const authService = getAuthService();
    const syncService = getSyncService();
    const user = authService.getCurrentUser();
    if (!user) {
      throw new Error('Not authenticated');
    }
    return syncService.registerDevice(user.id);
  });

  ipcMain.handle(IPC_CHANNELS.DEVICE_LIST, async () => {
    const syncService = getSyncService();
    return syncService.listDevices();
  });

  ipcMain.handle(IPC_CHANNELS.DEVICE_REMOVE, async (_, deviceId: string) => {
    const syncService = getSyncService();
    await syncService.removeDevice(deviceId);
  });

  // -------------------------------------------------------------------------
  // Update Handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async (): Promise<UpdateInfo> => {
    if (!isUpdateServiceInitialized()) {
      return {
        hasUpdate: false,
        currentVersion: app.getVersion(),
      };
    }
    const updateService = getUpdateService();
    return updateService.checkForUpdates();
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_GET_INFO, async (): Promise<UpdateInfo | null> => {
    if (!isUpdateServiceInitialized()) {
      return null;
    }
    const updateService = getUpdateService();
    return updateService.getCachedUpdateInfo();
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, async (_, downloadUrl: string): Promise<string> => {
    if (!isUpdateServiceInitialized()) {
      throw new Error('Update service not initialized');
    }
    const updateService = getUpdateService();
    return updateService.downloadUpdate(downloadUrl);
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_OPEN_FILE, async (_, filePath: string): Promise<void> => {
    if (!isUpdateServiceInitialized()) {
      throw new Error('Update service not initialized');
    }
    const updateService = getUpdateService();
    await updateService.openDownloadedFile(filePath);
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_OPEN_URL, async (_, url: string): Promise<void> => {
    if (!isUpdateServiceInitialized()) {
      throw new Error('Update service not initialized');
    }
    const updateService = getUpdateService();
    await updateService.openDownloadUrl(url);
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_START_AUTO_CHECK, async (): Promise<void> => {
    if (!isUpdateServiceInitialized()) {
      return;
    }
    const updateService = getUpdateService();
    updateService.startAutoCheck();
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_STOP_AUTO_CHECK, async (): Promise<void> => {
    if (!isUpdateServiceInitialized()) {
      return;
    }
    const updateService = getUpdateService();
    updateService.stopAutoCheck();
  });

  // -------------------------------------------------------------------------
  // Cache Handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.CACHE_GET_STATS, async () => {
    const { getToolCache } = await import('./services/ToolCache');
    const cache = getToolCache();
    return cache.getStats();
  });

  ipcMain.handle(IPC_CHANNELS.CACHE_CLEAR, async () => {
    const { getToolCache } = await import('./services/ToolCache');
    const cache = getToolCache();
    cache.clear();
  });

  ipcMain.handle(IPC_CHANNELS.CACHE_CLEAN_EXPIRED, async () => {
    const { getToolCache } = await import('./services/ToolCache');
    const cache = getToolCache();
    return cache.cleanExpired();
  });

  // -------------------------------------------------------------------------
  // Data Management Handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.DATA_GET_STATS, async () => {
    const { getDatabase } = await import('./services/DatabaseService');
    const { getToolCache } = await import('./services/ToolCache');
    const fs = await import('fs');
    const path = await import('path');

    const db = getDatabase();
    const cache = getToolCache();
    const dbStats = db.getStats();
    const cacheStats = cache.getStats();

    // 获取数据库工具缓存条目数
    const dbCacheCount = db.getToolCacheCount();

    // 获取本地会话和消息缓存统计
    const localCacheStats = db.getLocalCacheStats();

    // 获取数据库文件大小
    const userDataPath = app.getPath('userData');
    const dbPath = path.join(userDataPath, 'code-agent.db');
    let databaseSize = 0;
    try {
      const stat = fs.statSync(dbPath);
      databaseSize = stat.size;
    } catch {
      // 数据库文件可能不存在
    }

    return {
      ...dbStats,
      databaseSize,
      // 可清空的缓存条目数 = 内存缓存 + 工具执行缓存 + 会话缓存 + 消息缓存
      cacheEntries: cacheStats.totalEntries + dbCacheCount + localCacheStats.sessionCount + localCacheStats.messageCount,
    };
  });

  ipcMain.handle(IPC_CHANNELS.DATA_CLEAR_TOOL_CACHE, async () => {
    const { getToolCache } = await import('./services/ToolCache');
    const { getDatabase } = await import('./services/DatabaseService');
    const { getSessionManager } = await import('./services/SessionManager');

    const cache = getToolCache();
    const db = getDatabase();
    const sessionManager = getSessionManager();

    // Level 0: 清理内存缓存
    const cacheStats = cache.getStats();
    const clearedMemory = cacheStats.totalEntries;
    cache.clear();

    // 清理 SessionManager 内存缓存
    sessionManager.clearCache();

    // Level 1: 清理数据库中所有工具执行缓存
    const clearedToolCache = db.clearToolCache();

    // Level 1: 清理本地会话和消息缓存（可从云端重新拉取）
    const clearedMessages = db.clearAllMessages();
    const clearedSessions = db.clearAllSessions();

    const totalCleared = clearedMemory + clearedToolCache + clearedMessages + clearedSessions;
    console.log(`[DataClear] Cleared: memory=${clearedMemory}, toolCache=${clearedToolCache}, messages=${clearedMessages}, sessions=${clearedSessions}`);

    // 注意：不清除认证状态，保留登录
    // 会话和消息可从云端重新拉取
    return totalCleared;
  });

  // Persistent settings (stored in secure storage, survive data clear)
  ipcMain.handle(IPC_CHANNELS.PERSISTENT_GET_DEV_MODE, async () => {
    const { getSecureStorage } = await import('./services/SecureStorage');
    const storage = getSecureStorage();
    const value = storage.get('settings.devModeAutoApprove');
    // Default to true if not set
    return value === undefined ? true : value === 'true';
  });

  ipcMain.handle(IPC_CHANNELS.PERSISTENT_SET_DEV_MODE, async (_, enabled: boolean) => {
    const { getSecureStorage } = await import('./services/SecureStorage');
    const storage = getSecureStorage();
    storage.set('settings.devModeAutoApprove', enabled ? 'true' : 'false');

    // Also update ConfigService for runtime use
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

  // -------------------------------------------------------------------------
  // Cloud Task Handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.CLOUD_TASK_CREATE, async (_, request: CreateCloudTaskRequest): Promise<CloudTask | null> => {
    if (!isCloudTaskServiceInitialized()) {
      console.warn('[IPC] Cloud task service not initialized');
      return null;
    }
    const cloudTaskService = getCloudTaskService();
    return cloudTaskService.createTask(request);
  });

  ipcMain.handle(IPC_CHANNELS.CLOUD_TASK_GET, async (_, taskId: string): Promise<CloudTask | null> => {
    if (!isCloudTaskServiceInitialized()) {
      return null;
    }
    const cloudTaskService = getCloudTaskService();
    return cloudTaskService.getTask(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.CLOUD_TASK_LIST, async (_, filter?: CloudTaskFilter): Promise<CloudTask[]> => {
    if (!isCloudTaskServiceInitialized()) {
      return [];
    }
    const cloudTaskService = getCloudTaskService();
    return cloudTaskService.listTasks(filter);
  });

  ipcMain.handle(IPC_CHANNELS.CLOUD_TASK_START, async (_, taskId: string): Promise<boolean> => {
    if (!isCloudTaskServiceInitialized()) {
      return false;
    }
    const cloudTaskService = getCloudTaskService();
    return cloudTaskService.startTask(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.CLOUD_TASK_PAUSE, async (_, taskId: string): Promise<boolean> => {
    if (!isCloudTaskServiceInitialized()) {
      return false;
    }
    const cloudTaskService = getCloudTaskService();
    return cloudTaskService.pauseTask(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.CLOUD_TASK_CANCEL, async (_, taskId: string): Promise<boolean> => {
    if (!isCloudTaskServiceInitialized()) {
      return false;
    }
    const cloudTaskService = getCloudTaskService();
    return cloudTaskService.cancelTask(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.CLOUD_TASK_RETRY, async (_, taskId: string): Promise<boolean> => {
    if (!isCloudTaskServiceInitialized()) {
      return false;
    }
    const cloudTaskService = getCloudTaskService();
    return cloudTaskService.retryTask(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.CLOUD_TASK_DELETE, async (_, taskId: string): Promise<boolean> => {
    if (!isCloudTaskServiceInitialized()) {
      return false;
    }
    const cloudTaskService = getCloudTaskService();
    return cloudTaskService.deleteTask(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.CLOUD_TASK_SYNC_STATE, async (): Promise<TaskSyncState | null> => {
    if (!isCloudTaskServiceInitialized()) {
      return null;
    }
    const cloudTaskService = getCloudTaskService();
    return cloudTaskService.getSyncState();
  });

  ipcMain.handle(IPC_CHANNELS.CLOUD_TASK_STATS, async (): Promise<CloudExecutionStats | null> => {
    if (!isCloudTaskServiceInitialized()) {
      return null;
    }
    const cloudTaskService = getCloudTaskService();
    return cloudTaskService.getStats();
  });
}

// ----------------------------------------------------------------------------
// App Lifecycle
// ----------------------------------------------------------------------------

app.whenReady().then(async () => {
  try {
    console.log('[App] Starting initialization...');
    await initializeServices();
    console.log('[App] Services initialized, setting up IPC...');
    setupIpcHandlers();
    console.log('[App] IPC handlers set up, creating window...');
    await createWindow();
    console.log('[App] Window created successfully');
  } catch (error) {
    console.error('[App] FATAL ERROR during startup:', error);
    app.quit();
    return;
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });

  // Auto-test mode: send a test message if AUTO_TEST env is set
  if (process.env.AUTO_TEST) {
    console.log('\n=== AUTO TEST MODE ===');
    console.log('Sending test message in 2 seconds...\n');

    setTimeout(async () => {
      if (!agentOrchestrator) {
        console.error('Agent not initialized for auto-test');
        app.quit();
        return;
      }

      const testMessage = process.env.AUTO_TEST_MESSAGE || '列出当前目录的文件';
      console.log(`[AUTO_TEST] Sending: "${testMessage}"`);

      try {
        await agentOrchestrator.sendMessage(testMessage);
        console.log('\n[AUTO_TEST] ✅ Agent completed successfully!');
      } catch (error) {
        console.error('\n[AUTO_TEST] ❌ Agent failed:', error);
      }

      // Quit after test completes
      setTimeout(() => {
        console.log('\n[AUTO_TEST] Exiting...');
        app.quit();
      }, 1000);
    }, 2000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Cleanup before quitting
app.on('before-quit', async () => {
  console.log('Cleaning up before quit...');

  // Cleanup memory service (saves vector store, clears caches)
  try {
    const memoryService = getMemoryService();
    await memoryService.cleanup();
    console.log('Memory service cleaned up');
  } catch (error) {
    console.error('Error cleaning up memory service:', error);
  }

  // Disconnect MCP clients
  try {
    const mcpClient = getMCPClient();
    await mcpClient.disconnectAll();
    console.log('MCP clients disconnected');
  } catch (error) {
    console.error('Error disconnecting MCP clients:', error);
  }

  // Close database
  try {
    const db = getDatabase();
    db.close();
    console.log('Database closed');
  } catch (error) {
    console.error('Error closing database:', error);
  }

  // Cleanup Langfuse (flush remaining events)
  try {
    const langfuseService = getLangfuseService();
    await langfuseService.cleanupAll();
    await langfuseService.shutdown();
    console.log('Langfuse cleaned up');
  } catch (error) {
    console.error('Error cleaning up Langfuse:', error);
  }
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
