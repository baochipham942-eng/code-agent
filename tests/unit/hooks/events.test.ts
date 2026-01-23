// ============================================================================
// Hook Events Tests
// ============================================================================
//
// Tests for the hook events module.
// Tests cover:
// - Event type definitions
// - Event descriptions
// - Environment variable creation
// - Hook context types
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  type HookEvent,
  type HookActionResult,
  type ToolHookContext,
  type UserPromptContext,
  type StopContext,
  type SessionContext,
  type CompactContext,
  type NotificationContext,
  HOOK_EVENT_DESCRIPTIONS,
  HOOK_ENV_VARS,
  createHookEnvVars,
} from '../../../src/main/hooks/events';

describe('Hook Events', () => {
  // --------------------------------------------------------------------------
  // HOOK_EVENT_DESCRIPTIONS
  // --------------------------------------------------------------------------
  describe('HOOK_EVENT_DESCRIPTIONS', () => {
    it('should have descriptions for all event types', () => {
      const events: HookEvent[] = [
        'PreToolUse',
        'PostToolUse',
        'PostToolUseFailure',
        'UserPromptSubmit',
        'Stop',
        'SubagentStop',
        'PreCompact',
        'Setup',
        'SessionStart',
        'SessionEnd',
        'Notification',
      ];

      for (const event of events) {
        expect(HOOK_EVENT_DESCRIPTIONS[event]).toBeDefined();
        expect(typeof HOOK_EVENT_DESCRIPTIONS[event]).toBe('string');
        expect(HOOK_EVENT_DESCRIPTIONS[event].length).toBeGreaterThan(0);
      }
    });

    it('should have 11 event types', () => {
      expect(Object.keys(HOOK_EVENT_DESCRIPTIONS)).toHaveLength(11);
    });
  });

  // --------------------------------------------------------------------------
  // HOOK_ENV_VARS
  // --------------------------------------------------------------------------
  describe('HOOK_ENV_VARS', () => {
    it('should define all required environment variable names', () => {
      expect(HOOK_ENV_VARS.SESSION_ID).toBe('HOOK_SESSION_ID');
      expect(HOOK_ENV_VARS.EVENT).toBe('HOOK_EVENT');
      expect(HOOK_ENV_VARS.TOOL_NAME).toBe('HOOK_TOOL_NAME');
      expect(HOOK_ENV_VARS.TOOL_INPUT).toBe('HOOK_TOOL_INPUT');
      expect(HOOK_ENV_VARS.TOOL_OUTPUT).toBe('HOOK_TOOL_OUTPUT');
      expect(HOOK_ENV_VARS.ERROR_MESSAGE).toBe('HOOK_ERROR_MESSAGE');
      expect(HOOK_ENV_VARS.WORKING_DIR).toBe('HOOK_WORKING_DIR');
      expect(HOOK_ENV_VARS.USER_PROMPT).toBe('HOOK_USER_PROMPT');
    });
  });

  // --------------------------------------------------------------------------
  // createHookEnvVars
  // --------------------------------------------------------------------------
  describe('createHookEnvVars', () => {
    it('should create base env vars for any context', () => {
      const context: SessionContext = {
        event: 'SessionStart',
        sessionId: 'test-session-123',
        timestamp: Date.now(),
        workingDirectory: '/test/dir',
      };

      const env = createHookEnvVars(context);

      expect(env.HOOK_SESSION_ID).toBe('test-session-123');
      expect(env.HOOK_EVENT).toBe('SessionStart');
      expect(env.HOOK_WORKING_DIR).toBe('/test/dir');
    });

    it('should include tool-specific vars for tool contexts', () => {
      const context: ToolHookContext = {
        event: 'PreToolUse',
        sessionId: 'test-session',
        timestamp: Date.now(),
        workingDirectory: '/test',
        toolName: 'bash',
        toolInput: '{"command": "ls"}',
      };

      const env = createHookEnvVars(context);

      expect(env.HOOK_TOOL_NAME).toBe('bash');
      expect(env.HOOK_TOOL_INPUT).toBe('{"command": "ls"}');
    });

    it('should include tool output for PostToolUse context', () => {
      const context: ToolHookContext = {
        event: 'PostToolUse',
        sessionId: 'test-session',
        timestamp: Date.now(),
        workingDirectory: '/test',
        toolName: 'bash',
        toolInput: '{"command": "ls"}',
        toolOutput: 'file1.txt\nfile2.txt',
      };

      const env = createHookEnvVars(context);

      expect(env.HOOK_TOOL_OUTPUT).toBe('file1.txt\nfile2.txt');
    });

    it('should include error message for PostToolUseFailure context', () => {
      const context: ToolHookContext = {
        event: 'PostToolUseFailure',
        sessionId: 'test-session',
        timestamp: Date.now(),
        workingDirectory: '/test',
        toolName: 'bash',
        toolInput: '{"command": "invalid"}',
        errorMessage: 'Command not found',
      };

      const env = createHookEnvVars(context);

      expect(env.HOOK_ERROR_MESSAGE).toBe('Command not found');
    });

    it('should include user prompt for UserPromptSubmit context', () => {
      const context: UserPromptContext = {
        event: 'UserPromptSubmit',
        sessionId: 'test-session',
        timestamp: Date.now(),
        workingDirectory: '/test',
        prompt: 'Help me with this code',
      };

      const env = createHookEnvVars(context);

      expect(env.HOOK_USER_PROMPT).toBe('Help me with this code');
    });

    it('should handle stop context', () => {
      const context: StopContext = {
        event: 'Stop',
        sessionId: 'test-session',
        timestamp: Date.now(),
        workingDirectory: '/test',
        response: 'Task completed',
      };

      const env = createHookEnvVars(context);

      expect(env.HOOK_EVENT).toBe('Stop');
      expect(env.HOOK_SESSION_ID).toBe('test-session');
    });

    it('should handle compact context', () => {
      const context: CompactContext = {
        event: 'PreCompact',
        sessionId: 'test-session',
        timestamp: Date.now(),
        workingDirectory: '/test',
        tokenCount: 50000,
        targetTokenCount: 30000,
      };

      const env = createHookEnvVars(context);

      expect(env.HOOK_EVENT).toBe('PreCompact');
    });

    it('should handle notification context', () => {
      const context: NotificationContext = {
        event: 'Notification',
        sessionId: 'test-session',
        timestamp: Date.now(),
        workingDirectory: '/test',
        notificationType: 'info',
        message: 'Task completed successfully',
      };

      const env = createHookEnvVars(context);

      expect(env.HOOK_EVENT).toBe('Notification');
    });
  });
});
