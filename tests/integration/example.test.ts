// ============================================================================
// Integration Test Framework Example
// ============================================================================
//
// This test demonstrates how to use the integration test framework.
// It also serves as a validation that the framework is properly configured.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  createTestEnvironment,
  createMockDatabaseService,
  createMockLogger,
  createMockToolCache,
  createMockConfigService,
  createMockSession,
  createMockMessage,
  createMockToolResult,
  waitFor,
  type TestEnvironment,
} from './setup';
import {
  createMockElectron,
  createMockServices,
  clearAllMockServices,
  type MockServices,
} from './mocks';

describe('Integration Test Framework', () => {
  let env: TestEnvironment;
  let mockDb: ReturnType<typeof createMockDatabaseService>;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockServices: MockServices;

  beforeAll(async () => {
    env = await createTestEnvironment();
  });

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(() => {
    mockDb = createMockDatabaseService();
    mockLogger = createMockLogger();
    mockServices = createMockServices();
  });

  // --------------------------------------------------------------------------
  // Test Environment Tests
  // --------------------------------------------------------------------------
  describe('Test Environment', () => {
    it('should create isolated temporary directories', () => {
      expect(env.tempDir).toBeTruthy();
      expect(env.dbPath).toContain('test.db');
      expect(env.workingDirectory).toBeTruthy();
    });

    it('should provide cleanup function', () => {
      expect(typeof env.cleanup).toBe('function');
    });
  });

  // --------------------------------------------------------------------------
  // Mock Database Tests
  // --------------------------------------------------------------------------
  describe('Mock Database Service', () => {
    it('should store and retrieve sessions', () => {
      const session = createMockSession({ title: 'Test Session' });
      mockDb.createSession(session);

      const retrieved = mockDb.getSession(session.id);
      expect(retrieved).toEqual(session);
    });

    it('should store and retrieve messages', () => {
      const session = createMockSession();
      mockDb.createSession(session);

      const message = createMockMessage({ content: 'Hello, world!' });
      mockDb.addMessage(session.id, message);

      const messages = mockDb.getMessages(session.id);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Hello, world!');
    });

    it('should handle tool execution cache', () => {
      const toolName = 'test_tool';
      const args = { param: 'value' };
      const result = createMockToolResult();

      mockDb.saveToolExecution('session1', null, toolName, args, result, 60000);

      const cached = mockDb.getCachedToolResult(toolName, args);
      expect(cached).toEqual(result);
    });

    it('should log audit events', () => {
      mockDb.logAuditEvent('test_event', { key: 'value' }, 'session1');

      const logs = mockDb.getAuditLog({ eventType: 'test_event' });
      expect(logs).toHaveLength(1);
      expect(logs[0].eventData).toEqual({ key: 'value' });
    });

    it('should clear all data', () => {
      const session = createMockSession();
      mockDb.createSession(session);
      mockDb.addMessage(session.id, createMockMessage());

      mockDb._clear();

      expect(mockDb.listSessions()).toHaveLength(0);
      expect(mockDb.getStats().sessionCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Mock Logger Tests
  // --------------------------------------------------------------------------
  describe('Mock Logger', () => {
    it('should capture log messages', () => {
      mockLogger.info('Test info message');
      mockLogger.warn('Test warning', { extra: 'data' });
      mockLogger.error('Test error');

      const logs = mockLogger.getLogs();
      expect(logs).toHaveLength(3);
      expect(logs[0].level).toBe('info');
      expect(logs[1].level).toBe('warn');
      expect(logs[2].level).toBe('error');
    });

    it('should clear logs', () => {
      mockLogger.info('Message 1');
      mockLogger.info('Message 2');

      mockLogger.clear();

      expect(mockLogger.getLogs()).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Mock Tool Cache Tests
  // --------------------------------------------------------------------------
  describe('Mock Tool Cache', () => {
    it('should store and retrieve cached values', () => {
      const cache = createMockToolCache();

      cache.set('key1', { data: 'value' });
      expect(cache.get('key1')).toEqual({ data: 'value' });
    });

    it('should handle TTL expiration', async () => {
      const cache = createMockToolCache();

      cache.set('expiring', 'value', 10); // 10ms TTL

      await new Promise((r) => setTimeout(r, 20));
      expect(cache.get('expiring')).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Mock Config Service Tests
  // --------------------------------------------------------------------------
  describe('Mock Config Service', () => {
    it('should store and retrieve config values', () => {
      const config = createMockConfigService();

      config.set('setting1', 'value1');
      expect(config.get('setting1')).toBe('value1');
    });

    it('should return default value for missing keys', () => {
      const config = createMockConfigService();

      expect(config.get('missing', 'default')).toBe('default');
    });
  });

  // --------------------------------------------------------------------------
  // Mock Services Tests
  // --------------------------------------------------------------------------
  describe('Mock Services', () => {
    it('should provide auth service', async () => {
      await mockServices.auth.login('test@example.com', 'password');
      expect(mockServices.auth.isAuthenticated()).toBe(true);
      expect(mockServices.auth.getUser()?.email).toBe('test@example.com');
    });

    it('should provide cloud config service', () => {
      expect(mockServices.cloudConfig.isFeatureEnabled('mcp')).toBe(true);
    });

    it('should provide session manager', () => {
      const session = mockServices.sessionManager.createSession({
        title: 'New Session',
        generationId: 'gen4',
      });

      expect(session.title).toBe('New Session');
      expect(mockServices.sessionManager.getActiveSession()).toBeTruthy();
    });

    it('should provide MCP client', async () => {
      await mockServices.mcp.connectServer('test-server', {});
      expect(mockServices.mcp.getServerStatus('test-server')).toBe('connected');
    });

    it('should clear all services', () => {
      mockServices.auth._setUser({ id: '1', email: 'test@test.com' });
      mockServices.sessionManager.createSession({ title: 'Session' });

      clearAllMockServices(mockServices);

      expect(mockServices.auth.isAuthenticated()).toBe(false);
      expect(mockServices.sessionManager.listSessions()).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Mock Electron Tests
  // --------------------------------------------------------------------------
  describe('Mock Electron', () => {
    it('should provide app paths', () => {
      const electron = createMockElectron(env.tempDir);

      expect(electron.app.getPath('userData')).toContain(env.tempDir);
      expect(electron.app.getName()).toBe('Code Agent Test');
    });

    it('should provide dialog functions', async () => {
      const electron = createMockElectron(env.tempDir);

      const result = await electron.dialog.showOpenDialog();
      expect(result.canceled).toBe(false);
    });

    it('should provide clipboard functions', () => {
      const electron = createMockElectron(env.tempDir);

      electron.clipboard.writeText('test');
      expect(electron.clipboard.readText()).toBe('test');
    });
  });

  // --------------------------------------------------------------------------
  // Helper Function Tests
  // --------------------------------------------------------------------------
  describe('Helper Functions', () => {
    it('waitFor should resolve when condition is met', async () => {
      let value = 0;
      setTimeout(() => { value = 1; }, 50);

      await waitFor(() => value === 1);
      expect(value).toBe(1);
    });

    it('waitFor should timeout if condition is never met', async () => {
      await expect(waitFor(() => false, { timeout: 100 })).rejects.toThrow('Condition not met');
    });

    it('createMockSession should generate valid session', () => {
      const session = createMockSession({ title: 'Custom Title' });

      expect(session.id).toMatch(/^session_/);
      expect(session.title).toBe('Custom Title');
      expect(session.generationId).toBe('gen4');
    });

    it('createMockMessage should generate valid message', () => {
      const message = createMockMessage({ role: 'assistant', content: 'Hello!' });

      expect(message.id).toMatch(/^msg_/);
      expect(message.role).toBe('assistant');
      expect(message.content).toBe('Hello!');
    });

    it('createMockToolResult should generate valid result', () => {
      const result = createMockToolResult({ success: false, error: 'Failed' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed');
    });
  });
});
