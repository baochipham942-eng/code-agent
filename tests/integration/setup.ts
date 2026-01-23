// ============================================================================
// Integration Test Framework Setup
// ============================================================================
//
// This module provides utilities for integration testing including:
// - Test environment initialization
// - Mock service configurations
// - Database setup/teardown
// - Helper utilities for common test patterns
// ============================================================================

import { vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ----------------------------------------------------------------------------
// Test Environment Configuration
// ----------------------------------------------------------------------------

export interface TestEnvironment {
  /** Temporary directory for test artifacts */
  tempDir: string;
  /** Test database path */
  dbPath: string;
  /** Mock working directory */
  workingDirectory: string;
  /** Cleanup function */
  cleanup: () => Promise<void>;
}

/**
 * Creates an isolated test environment with temporary directories
 */
export async function createTestEnvironment(): Promise<TestEnvironment> {
  const tempDir = path.join(os.tmpdir(), `code-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dbPath = path.join(tempDir, 'test.db');
  const workingDirectory = path.join(tempDir, 'workspace');

  // Create directories
  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(workingDirectory, { recursive: true });

  const cleanup = async () => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  };

  return {
    tempDir,
    dbPath,
    workingDirectory,
    cleanup,
  };
}

// ----------------------------------------------------------------------------
// Service Mocks
// ----------------------------------------------------------------------------

/**
 * Mock logger factory that captures log calls
 */
export function createMockLogger() {
  const logs: Array<{ level: string; message: string; args: unknown[] }> = [];

  const mockLogger = {
    info: vi.fn((...args: unknown[]) => logs.push({ level: 'info', message: String(args[0]), args })),
    debug: vi.fn((...args: unknown[]) => logs.push({ level: 'debug', message: String(args[0]), args })),
    warn: vi.fn((...args: unknown[]) => logs.push({ level: 'warn', message: String(args[0]), args })),
    error: vi.fn((...args: unknown[]) => logs.push({ level: 'error', message: String(args[0]), args })),
    getLogs: () => [...logs],
    clear: () => logs.length = 0,
  };

  return mockLogger;
}

/**
 * Mock tool cache for testing
 */
export function createMockToolCache() {
  const cache = new Map<string, { value: unknown; expiresAt: number }>();

  return {
    isCacheable: vi.fn().mockReturnValue(true),
    get: vi.fn((key: string) => {
      const entry = cache.get(key);
      if (!entry) return null;
      if (entry.expiresAt && entry.expiresAt < Date.now()) {
        cache.delete(key);
        return null;
      }
      return entry.value;
    }),
    set: vi.fn((key: string, value: unknown, ttl?: number) => {
      cache.set(key, {
        value,
        expiresAt: ttl ? Date.now() + ttl : 0,
      });
    }),
    delete: vi.fn((key: string) => cache.delete(key)),
    clear: vi.fn(() => cache.clear()),
    size: () => cache.size,
  };
}

/**
 * Mock config service
 */
export function createMockConfigService() {
  const config = new Map<string, unknown>();

  return {
    get: vi.fn((key: string, defaultValue?: unknown) => config.get(key) ?? defaultValue),
    set: vi.fn((key: string, value: unknown) => config.set(key, value)),
    delete: vi.fn((key: string) => config.delete(key)),
    has: vi.fn((key: string) => config.has(key)),
    getAll: vi.fn(() => Object.fromEntries(config)),
    clear: () => config.clear(),
  };
}

/**
 * Mock notification service
 */
export function createMockNotificationService() {
  const notifications: Array<{ type: string; title: string; body?: string }> = [];

  return {
    show: vi.fn((type: string, title: string, body?: string) => {
      notifications.push({ type, title, body });
    }),
    getNotifications: () => [...notifications],
    clear: () => notifications.length = 0,
  };
}

// ----------------------------------------------------------------------------
// Database Mocks
// ----------------------------------------------------------------------------

/**
 * In-memory database mock for testing
 * Mimics the DatabaseService interface without SQLite dependency
 */
export function createMockDatabaseService() {
  const sessions = new Map<string, Record<string, unknown>>();
  const messages = new Map<string, Array<Record<string, unknown>>>();
  const toolExecutions = new Map<string, Record<string, unknown>>();
  const preferences = new Map<string, unknown>();
  const projectKnowledge = new Map<string, Array<Record<string, unknown>>>();
  const todos = new Map<string, Array<Record<string, unknown>>>();
  const auditLog: Array<Record<string, unknown>> = [];

  return {
    // Initialization
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),

    // Sessions
    createSession: vi.fn((session: Record<string, unknown>) => {
      sessions.set(session.id as string, session);
      messages.set(session.id as string, []);
    }),
    getSession: vi.fn((id: string) => sessions.get(id) ?? null),
    listSessions: vi.fn(() => Array.from(sessions.values())),
    updateSession: vi.fn((id: string, updates: Record<string, unknown>) => {
      const session = sessions.get(id);
      if (session) {
        sessions.set(id, { ...session, ...updates, updatedAt: Date.now() });
      }
    }),
    deleteSession: vi.fn((id: string) => {
      sessions.delete(id);
      messages.delete(id);
    }),
    clearAllSessions: vi.fn(() => {
      const count = sessions.size;
      sessions.clear();
      messages.clear();
      return count;
    }),

    // Messages
    addMessage: vi.fn((sessionId: string, message: Record<string, unknown>) => {
      const sessionMessages = messages.get(sessionId) ?? [];
      sessionMessages.push(message);
      messages.set(sessionId, sessionMessages);
    }),
    getMessages: vi.fn((sessionId: string) => messages.get(sessionId) ?? []),
    updateMessage: vi.fn((messageId: string, updates: Record<string, unknown>) => {
      for (const sessionMessages of messages.values()) {
        const index = sessionMessages.findIndex((m) => m.id === messageId);
        if (index !== -1) {
          sessionMessages[index] = { ...sessionMessages[index], ...updates };
          break;
        }
      }
    }),
    getMessageCount: vi.fn((sessionId: string) => (messages.get(sessionId) ?? []).length),

    // Tool Executions
    saveToolExecution: vi.fn((
      sessionId: string,
      messageId: string | null,
      toolName: string,
      args: Record<string, unknown>,
      result: Record<string, unknown>,
      ttlMs?: number
    ) => {
      const key = `${toolName}:${JSON.stringify(args)}`;
      toolExecutions.set(key, {
        sessionId,
        messageId,
        toolName,
        args,
        result,
        expiresAt: ttlMs ? Date.now() + ttlMs : null,
        createdAt: Date.now(),
      });
    }),
    getCachedToolResult: vi.fn((toolName: string, args: Record<string, unknown>) => {
      const key = `${toolName}:${JSON.stringify(args)}`;
      const entry = toolExecutions.get(key) as Record<string, unknown> | undefined;
      if (!entry) return null;
      if (entry.expiresAt && (entry.expiresAt as number) < Date.now()) {
        toolExecutions.delete(key);
        return null;
      }
      return entry.result;
    }),
    clearToolCache: vi.fn(() => {
      const count = toolExecutions.size;
      toolExecutions.clear();
      return count;
    }),

    // Preferences
    setPreference: vi.fn((key: string, value: unknown) => preferences.set(key, value)),
    getPreference: vi.fn((key: string, defaultValue?: unknown) => preferences.get(key) ?? defaultValue),
    getAllPreferences: vi.fn(() => Object.fromEntries(preferences)),

    // Project Knowledge
    saveProjectKnowledge: vi.fn((
      projectPath: string,
      key: string,
      value: unknown,
      source: string = 'learned',
      confidence: number = 1.0
    ) => {
      const knowledgeList = projectKnowledge.get(projectPath) ?? [];
      const existingIndex = knowledgeList.findIndex((k) => k.key === key);
      const knowledge = {
        id: `pk_${Date.now()}`,
        projectPath,
        key,
        value,
        source,
        confidence,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      if (existingIndex !== -1) {
        knowledgeList[existingIndex] = knowledge;
      } else {
        knowledgeList.push(knowledge);
      }
      projectKnowledge.set(projectPath, knowledgeList);
    }),
    getProjectKnowledge: vi.fn((projectPath: string, key?: string) => {
      const knowledgeList = projectKnowledge.get(projectPath) ?? [];
      if (key) {
        return knowledgeList.filter((k) => k.key === key);
      }
      return knowledgeList;
    }),

    // Todos
    saveTodos: vi.fn((sessionId: string, todoList: Array<Record<string, unknown>>) => {
      todos.set(sessionId, todoList);
    }),
    getTodos: vi.fn((sessionId: string) => todos.get(sessionId) ?? []),

    // Audit Log
    logAuditEvent: vi.fn((eventType: string, eventData: Record<string, unknown>, sessionId?: string) => {
      auditLog.push({
        id: auditLog.length + 1,
        sessionId: sessionId ?? null,
        eventType,
        eventData,
        createdAt: Date.now(),
      });
    }),
    getAuditLog: vi.fn((options: { sessionId?: string; eventType?: string; limit?: number; since?: number } = {}) => {
      let result = [...auditLog];
      if (options.sessionId) {
        result = result.filter((e) => e.sessionId === options.sessionId);
      }
      if (options.eventType) {
        result = result.filter((e) => e.eventType === options.eventType);
      }
      if (options.since) {
        result = result.filter((e) => (e.createdAt as number) > options.since!);
      }
      result.sort((a, b) => (b.createdAt as number) - (a.createdAt as number));
      if (options.limit) {
        result = result.slice(0, options.limit);
      }
      return result;
    }),

    // Stats
    getStats: vi.fn(() => ({
      sessionCount: sessions.size,
      messageCount: Array.from(messages.values()).reduce((acc, m) => acc + m.length, 0),
      toolExecutionCount: toolExecutions.size,
      knowledgeCount: Array.from(projectKnowledge.values()).reduce((acc, k) => acc + k.length, 0),
    })),

    // Test helpers
    _clear: () => {
      sessions.clear();
      messages.clear();
      toolExecutions.clear();
      preferences.clear();
      projectKnowledge.clear();
      todos.clear();
      auditLog.length = 0;
    },
    _getInternals: () => ({
      sessions,
      messages,
      toolExecutions,
      preferences,
      projectKnowledge,
      todos,
      auditLog,
    }),
  };
}

// ----------------------------------------------------------------------------
// Electron Mocks
// ----------------------------------------------------------------------------

/**
 * Mock Electron APIs for testing
 */
export function mockElectronAPIs(tempDir: string) {
  return {
    app: {
      getPath: vi.fn((name: string) => {
        switch (name) {
          case 'userData': return tempDir;
          case 'temp': return path.join(tempDir, 'temp');
          case 'home': return tempDir;
          default: return tempDir;
        }
      }),
      getName: vi.fn(() => 'Code Agent Test'),
      getVersion: vi.fn(() => '0.0.0-test'),
      isPackaged: false,
      quit: vi.fn(),
    },
    dialog: {
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: [] }),
      showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath: '' }),
      showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
    },
    shell: {
      openExternal: vi.fn().mockResolvedValue(undefined),
      openPath: vi.fn().mockResolvedValue(''),
      showItemInFolder: vi.fn(),
    },
    clipboard: {
      readText: vi.fn().mockReturnValue(''),
      writeText: vi.fn(),
      readImage: vi.fn().mockReturnValue({ isEmpty: () => true }),
    },
    BrowserWindow: vi.fn().mockImplementation(() => ({
      loadURL: vi.fn(),
      loadFile: vi.fn(),
      webContents: {
        send: vi.fn(),
        on: vi.fn(),
      },
      on: vi.fn(),
      show: vi.fn(),
      close: vi.fn(),
    })),
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn(),
      removeHandler: vi.fn(),
    },
  };
}

// ----------------------------------------------------------------------------
// Test Helpers
// ----------------------------------------------------------------------------

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const { timeout = 5000, interval = 50 } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`Condition not met within ${timeout}ms`);
}

/**
 * Create a mock message
 */
export function createMockMessage(overrides: Partial<{
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  toolCalls?: unknown[];
  toolResults?: unknown[];
}> = {}) {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    role: 'user' as const,
    content: 'Test message',
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Create a mock session
 */
export function createMockSession(overrides: Partial<{
  id: string;
  title: string;
  generationId: string;
  modelConfig: { provider: string; model: string };
  workingDirectory?: string;
  createdAt: number;
  updatedAt: number;
}> = {}) {
  const now = Date.now();
  return {
    id: `session_${now}_${Math.random().toString(36).slice(2)}`,
    title: 'Test Session',
    generationId: 'gen4',
    modelConfig: {
      provider: 'openai',
      model: 'gpt-4',
    },
    workingDirectory: '/test/workspace',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Create a mock tool result
 */
export function createMockToolResult(overrides: Partial<{
  success: boolean;
  output: string;
  error?: string;
  duration?: number;
}> = {}) {
  return {
    success: true,
    output: 'Tool executed successfully',
    duration: 100,
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// Test Lifecycle Helpers
// ----------------------------------------------------------------------------

/**
 * Setup function for integration tests
 * Call this in beforeAll or beforeEach
 */
export function setupIntegrationTest() {
  let env: TestEnvironment | null = null;
  let mockDb: ReturnType<typeof createMockDatabaseService> | null = null;
  let mockLogger: ReturnType<typeof createMockLogger> | null = null;

  beforeAll(async () => {
    env = await createTestEnvironment();
  });

  beforeEach(() => {
    mockDb = createMockDatabaseService();
    mockLogger = createMockLogger();

    // Setup common mocks
    vi.mock('../../src/main/services', () => ({
      getDatabase: () => mockDb,
      getToolCache: () => createMockToolCache(),
    }));

    vi.mock('../../src/main/services/infra/logger', () => ({
      createLogger: () => mockLogger,
    }));
  });

  afterEach(() => {
    mockDb?._clear();
    mockLogger?.clear();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await env?.cleanup();
    vi.resetModules();
  });

  return {
    getEnv: () => env!,
    getDb: () => mockDb!,
    getLogger: () => mockLogger!,
  };
}

// ----------------------------------------------------------------------------
// Exports
// ----------------------------------------------------------------------------

export {
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
