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
import { IPC_CHANNELS } from '../shared/ipc';
import type { GenerationId, PermissionResponse, PlanningState } from '../shared/types';
import { createPlanningService, type PlanningService } from './planning';

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
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#18181b',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Load the app
  if (process.env.NODE_ENV === 'development') {
    await mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

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

  // Initialize generation manager
  generationManager = new GenerationManager();

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
        try {
          const sessionManager = getSessionManager();
          await sessionManager.addMessage(event.data);
        } catch (error) {
          console.error('Failed to save assistant message:', error);
        }
      }
    },
  });

  // Set default generation
  const defaultGenId = settings.generation.default || 'gen3';
  generationManager.switchGeneration(defaultGenId);

  // Auto-restore or create session
  await initializeSession(settings);

  // Initialize planning service for Gen 3+
  await initializePlanningService();
}

async function initializePlanningService(): Promise<void> {
  if (!agentOrchestrator || !currentSessionId) return;

  const workingDir = agentOrchestrator.getWorkingDirectory();
  if (!workingDir) return;

  planningService = createPlanningService(workingDir, currentSessionId);
  console.log('Planning service initialized');

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
}

// ----------------------------------------------------------------------------
// App Lifecycle
// ----------------------------------------------------------------------------

app.whenReady().then(async () => {
  await initializeServices();
  setupIpcHandlers();
  await createWindow();

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
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
