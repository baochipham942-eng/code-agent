// ============================================================================
// Service Mocks for Integration Testing
// ============================================================================
//
// Provides mock implementations of application services for testing
// without external dependencies.
// ============================================================================

import { vi } from 'vitest';

// ----------------------------------------------------------------------------
// Auth Service Mock
// ----------------------------------------------------------------------------

export interface MockUser {
  id: string;
  email: string;
  name?: string;
  isAdmin?: boolean;
}

export function createMockAuthService() {
  let currentUser: MockUser | null = null;
  let isAuthenticated = false;

  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    login: vi.fn(async (email: string, password: string) => {
      if (email && password) {
        currentUser = {
          id: `user_${Date.now()}`,
          email,
          name: email.split('@')[0],
          isAdmin: email.includes('admin'),
        };
        isAuthenticated = true;
        return currentUser;
      }
      throw new Error('Invalid credentials');
    }),
    logout: vi.fn(async () => {
      currentUser = null;
      isAuthenticated = false;
    }),
    getUser: vi.fn(() => currentUser),
    isAuthenticated: vi.fn(() => isAuthenticated),
    refreshToken: vi.fn().mockResolvedValue(true),
    getAccessToken: vi.fn().mockResolvedValue('mock_access_token'),

    // Test helpers
    _setUser: (user: MockUser | null) => {
      currentUser = user;
      isAuthenticated = !!user;
    },
    _clear: () => {
      currentUser = null;
      isAuthenticated = false;
    },
  };
}

// ----------------------------------------------------------------------------
// Cloud Config Service Mock
// ----------------------------------------------------------------------------

export function createMockCloudConfigService() {
  const config = new Map<string, unknown>();

  // Default config values
  config.set('features.mcp', true);
  config.set('features.webSearch', true);
  config.set('features.imageGeneration', true);
  config.set('limits.maxTokens', 100000);

  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    fetchConfig: vi.fn().mockResolvedValue(Object.fromEntries(config)),
    get: vi.fn((key: string, defaultValue?: unknown) => config.get(key) ?? defaultValue),
    isFeatureEnabled: vi.fn((feature: string) => config.get(`features.${feature}`) === true),
    getLimit: vi.fn((limitName: string) => config.get(`limits.${limitName}`)),

    // Test helpers
    _setConfig: (key: string, value: unknown) => config.set(key, value),
    _clear: () => config.clear(),
  };
}

// ----------------------------------------------------------------------------
// Prompt Service Mock
// ----------------------------------------------------------------------------

export function createMockPromptService() {
  const prompts = new Map<string, string>();

  // Default prompts
  prompts.set('gen1', 'You are a coding assistant with gen1 capabilities.');
  prompts.set('gen2', 'You are a coding assistant with gen2 capabilities.');
  prompts.set('gen3', 'You are a coding assistant with gen3 capabilities.');
  prompts.set('gen4', 'You are a coding assistant with gen4 capabilities.');

  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    fetchPrompts: vi.fn().mockResolvedValue(Object.fromEntries(prompts)),
    getPrompt: vi.fn((genId: string) => prompts.get(genId) ?? ''),
    getVersion: vi.fn().mockReturnValue('1.0.0'),

    // Test helpers
    _setPrompt: (genId: string, prompt: string) => prompts.set(genId, prompt),
    _clear: () => prompts.clear(),
  };
}

// ----------------------------------------------------------------------------
// Sync Service Mock
// ----------------------------------------------------------------------------

export function createMockSyncService() {
  let syncEnabled = false;
  const syncQueue: Array<{ type: string; data: unknown }> = [];
  const syncedItems = new Map<string, unknown>();

  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    enable: vi.fn(() => { syncEnabled = true; }),
    disable: vi.fn(() => { syncEnabled = false; }),
    isEnabled: vi.fn(() => syncEnabled),
    sync: vi.fn(async (type: string, data: unknown) => {
      if (syncEnabled) {
        const id = `${type}_${Date.now()}`;
        syncQueue.push({ type, data });
        syncedItems.set(id, data);
        return id;
      }
      return null;
    }),
    pull: vi.fn().mockResolvedValue([]),
    push: vi.fn().mockResolvedValue(true),
    getStatus: vi.fn(() => ({
      enabled: syncEnabled,
      pendingCount: syncQueue.length,
      lastSync: Date.now(),
    })),

    // Test helpers
    _getSyncQueue: () => [...syncQueue],
    _getSyncedItems: () => new Map(syncedItems),
    _clear: () => {
      syncEnabled = false;
      syncQueue.length = 0;
      syncedItems.clear();
    },
  };
}

// ----------------------------------------------------------------------------
// Session Manager Mock
// ----------------------------------------------------------------------------

export function createMockSessionManager() {
  const sessions = new Map<string, Record<string, unknown>>();
  let activeSessionId: string | null = null;

  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn((config: Record<string, unknown>) => {
      const id = `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const session = {
        id,
        ...config,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };
      sessions.set(id, session);
      activeSessionId = id;
      return session;
    }),
    getSession: vi.fn((id: string) => sessions.get(id) ?? null),
    getActiveSession: vi.fn(() => activeSessionId ? sessions.get(activeSessionId) : null),
    setActiveSession: vi.fn((id: string) => {
      if (sessions.has(id)) {
        activeSessionId = id;
        return true;
      }
      return false;
    }),
    updateSession: vi.fn((id: string, updates: Record<string, unknown>) => {
      const session = sessions.get(id);
      if (session) {
        sessions.set(id, { ...session, ...updates, updatedAt: Date.now() });
        return true;
      }
      return false;
    }),
    deleteSession: vi.fn((id: string) => {
      if (sessions.has(id)) {
        sessions.delete(id);
        if (activeSessionId === id) {
          activeSessionId = sessions.size > 0 ? Array.from(sessions.keys())[0] : null;
        }
        return true;
      }
      return false;
    }),
    listSessions: vi.fn(() => Array.from(sessions.values())),

    // Test helpers
    _getInternals: () => ({ sessions, activeSessionId }),
    _clear: () => {
      sessions.clear();
      activeSessionId = null;
    },
  };
}

// ----------------------------------------------------------------------------
// Langfuse Service Mock
// ----------------------------------------------------------------------------

export function createMockLangfuseService() {
  const traces: Array<Record<string, unknown>> = [];
  const spans: Array<Record<string, unknown>> = [];
  let enabled = false;

  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    isEnabled: vi.fn(() => enabled),
    enable: vi.fn(() => { enabled = true; }),
    disable: vi.fn(() => { enabled = false; }),
    startTrace: vi.fn((name: string, metadata?: Record<string, unknown>) => {
      const trace = {
        id: `trace_${Date.now()}`,
        name,
        metadata,
        startTime: Date.now(),
        spans: [],
      };
      traces.push(trace);
      return trace.id;
    }),
    endTrace: vi.fn((traceId: string) => {
      const trace = traces.find((t) => t.id === traceId);
      if (trace) {
        trace.endTime = Date.now();
      }
    }),
    startSpan: vi.fn((traceId: string, name: string, metadata?: Record<string, unknown>) => {
      const span = {
        id: `span_${Date.now()}`,
        traceId,
        name,
        metadata,
        startTime: Date.now(),
      };
      spans.push(span);
      return span.id;
    }),
    endSpan: vi.fn((spanId: string) => {
      const span = spans.find((s) => s.id === spanId);
      if (span) {
        span.endTime = Date.now();
      }
    }),
    logEvent: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),

    // Test helpers
    _getTraces: () => [...traces],
    _getSpans: () => [...spans],
    _clear: () => {
      traces.length = 0;
      spans.length = 0;
      enabled = false;
    },
  };
}

// ----------------------------------------------------------------------------
// Browser Service Mock
// ----------------------------------------------------------------------------

export function createMockBrowserService() {
  let isInitialized = false;
  const pages: Array<{ url: string; content: string }> = [];

  return {
    initialize: vi.fn(async () => {
      isInitialized = true;
    }),
    isInitialized: vi.fn(() => isInitialized),
    navigateTo: vi.fn(async (url: string) => {
      const page = { url, content: `<html><body>Mock page for ${url}</body></html>` };
      pages.push(page);
      return page;
    }),
    getPageContent: vi.fn(async (url: string) => {
      const page = pages.find((p) => p.url === url);
      return page?.content ?? null;
    }),
    screenshot: vi.fn(async () => Buffer.from('mock-screenshot-data')),
    close: vi.fn(async () => {
      isInitialized = false;
    }),

    // Test helpers
    _getPages: () => [...pages],
    _clear: () => {
      isInitialized = false;
      pages.length = 0;
    },
  };
}

// ----------------------------------------------------------------------------
// MCP Client Mock
// ----------------------------------------------------------------------------

export interface MockMcpServer {
  name: string;
  status: 'connected' | 'disconnected' | 'error';
  tools: Array<{ name: string; description: string }>;
  resources: Array<{ uri: string; name: string }>;
}

export function createMockMcpClient() {
  const servers = new Map<string, MockMcpServer>();

  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    connectServer: vi.fn(async (name: string, config: Record<string, unknown>) => {
      servers.set(name, {
        name,
        status: 'connected',
        tools: [],
        resources: [],
      });
      return true;
    }),
    disconnectServer: vi.fn(async (name: string) => {
      const server = servers.get(name);
      if (server) {
        server.status = 'disconnected';
      }
    }),
    getServerStatus: vi.fn((name: string) => servers.get(name)?.status ?? 'disconnected'),
    listServers: vi.fn(() => Array.from(servers.values())),
    listTools: vi.fn((serverName: string) => servers.get(serverName)?.tools ?? []),
    listResources: vi.fn((serverName: string) => servers.get(serverName)?.resources ?? []),
    callTool: vi.fn(async (serverName: string, toolName: string, args: Record<string, unknown>) => {
      const server = servers.get(serverName);
      if (!server || server.status !== 'connected') {
        throw new Error(`Server ${serverName} not connected`);
      }
      return { success: true, output: `Mock result for ${toolName}` };
    }),
    readResource: vi.fn(async (serverName: string, uri: string) => {
      const server = servers.get(serverName);
      if (!server || server.status !== 'connected') {
        throw new Error(`Server ${serverName} not connected`);
      }
      return { content: `Mock content for ${uri}` };
    }),

    // Test helpers
    _addServer: (server: MockMcpServer) => servers.set(server.name, server),
    _getServers: () => new Map(servers),
    _clear: () => servers.clear(),
  };
}

// ----------------------------------------------------------------------------
// Complete Services Mock
// ----------------------------------------------------------------------------

export interface MockServices {
  auth: ReturnType<typeof createMockAuthService>;
  cloudConfig: ReturnType<typeof createMockCloudConfigService>;
  prompt: ReturnType<typeof createMockPromptService>;
  sync: ReturnType<typeof createMockSyncService>;
  sessionManager: ReturnType<typeof createMockSessionManager>;
  langfuse: ReturnType<typeof createMockLangfuseService>;
  browser: ReturnType<typeof createMockBrowserService>;
  mcp: ReturnType<typeof createMockMcpClient>;
}

/**
 * Creates a complete set of mock services
 */
export function createMockServices(): MockServices {
  return {
    auth: createMockAuthService(),
    cloudConfig: createMockCloudConfigService(),
    prompt: createMockPromptService(),
    sync: createMockSyncService(),
    sessionManager: createMockSessionManager(),
    langfuse: createMockLangfuseService(),
    browser: createMockBrowserService(),
    mcp: createMockMcpClient(),
  };
}

/**
 * Clears all mock services
 */
export function clearAllMockServices(services: MockServices) {
  services.auth._clear();
  services.cloudConfig._clear();
  services.prompt._clear();
  services.sync._clear();
  services.sessionManager._clear();
  services.langfuse._clear();
  services.browser._clear();
  services.mcp._clear();
}
