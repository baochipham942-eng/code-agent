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
} from '../../../src/host/hooks';

const MAX_HOOK_ENV_ENTRY_BYTES = 128 * 1024;
const HOOK_ENV_TRUNCATED_MARKER = '[truncated]';

function envEntryByteLength(name: string, value: string): number {
  return Buffer.byteLength(`${name}=${value}`) + 1;
}

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
        'SubagentStart',
        'PermissionRequest',
        'PostExecution',
        'PreCompact',
        'Setup',
        'SessionStart',
        'SessionEnd',
        'Notification',
        'TaskCreated',
        'TaskCompleted',
        'PermissionDenied',
        'PostCompact',
        'StopFailure',
      ];

      for (const event of events) {
        expect(HOOK_EVENT_DESCRIPTIONS[event]).toBeDefined();
        expect(typeof HOOK_EVENT_DESCRIPTIONS[event]).toBe('string');
        expect(HOOK_EVENT_DESCRIPTIONS[event].length).toBeGreaterThan(0);
      }
    });

    it('should have 20 event types', () => {
      // 19 + RoleWake（角色主动性醒来，docs/designs/role-proactivity.md §2.3）
      expect(Object.keys(HOOK_EVENT_DESCRIPTIONS)).toHaveLength(20);
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

    it('should preserve hook env payloads below the entry byte limit', () => {
      const toolInput = 'input'.repeat(100);
      const toolOutput = 'output'.repeat(100);
      const errorMessage = 'error'.repeat(100);
      const prompt = 'prompt'.repeat(100);

      const toolEnv = createHookEnvVars({
        event: 'PostToolUseFailure',
        sessionId: 'test-session',
        timestamp: Date.now(),
        workingDirectory: '/test',
        toolName: 'bash',
        toolInput,
        toolOutput,
        errorMessage,
      });
      const promptEnv = createHookEnvVars({
        event: 'UserPromptSubmit',
        sessionId: 'test-session',
        timestamp: Date.now(),
        workingDirectory: '/test',
        prompt,
      });

      expect(toolEnv.HOOK_TOOL_INPUT).toBe(toolInput);
      expect(toolEnv.HOOK_TOOL_INPUT).not.toContain(HOOK_ENV_TRUNCATED_MARKER);
      expect(toolEnv.HOOK_TOOL_OUTPUT).toBe(toolOutput);
      expect(toolEnv.HOOK_TOOL_OUTPUT).not.toContain(HOOK_ENV_TRUNCATED_MARKER);
      expect(toolEnv.HOOK_ERROR_MESSAGE).toBe(errorMessage);
      expect(toolEnv.HOOK_ERROR_MESSAGE).not.toContain(HOOK_ENV_TRUNCATED_MARKER);
      expect(promptEnv.HOOK_USER_PROMPT).toBe(prompt);
      expect(promptEnv.HOOK_USER_PROMPT).not.toContain(HOOK_ENV_TRUNCATED_MARKER);
    });

    it('should truncate oversized tool input env entries', () => {
      const env = createHookEnvVars({
        event: 'PreToolUse',
        sessionId: 'test-session',
        timestamp: Date.now(),
        workingDirectory: '/test',
        toolName: 'bash',
        toolInput: 'x'.repeat(MAX_HOOK_ENV_ENTRY_BYTES + 1024),
      });

      expect(env.HOOK_TOOL_INPUT).toMatch(/\[truncated\]$/);
      expect(envEntryByteLength('HOOK_TOOL_INPUT', env.HOOK_TOOL_INPUT)).toBeLessThanOrEqual(MAX_HOOK_ENV_ENTRY_BYTES);
    });

    it('should truncate oversized tool output env entries', () => {
      const env = createHookEnvVars({
        event: 'PostToolUse',
        sessionId: 'test-session',
        timestamp: Date.now(),
        workingDirectory: '/test',
        toolName: 'bash',
        toolInput: '{}',
        toolOutput: 'x'.repeat(MAX_HOOK_ENV_ENTRY_BYTES + 1024),
      });

      expect(env.HOOK_TOOL_OUTPUT).toMatch(/\[truncated\]$/);
      expect(envEntryByteLength('HOOK_TOOL_OUTPUT', env.HOOK_TOOL_OUTPUT)).toBeLessThanOrEqual(MAX_HOOK_ENV_ENTRY_BYTES);
    });

    it('should truncate oversized user prompt env entries', () => {
      const env = createHookEnvVars({
        event: 'UserPromptSubmit',
        sessionId: 'test-session',
        timestamp: Date.now(),
        workingDirectory: '/test',
        prompt: 'x'.repeat(MAX_HOOK_ENV_ENTRY_BYTES + 1024),
      });

      expect(env.HOOK_USER_PROMPT).toMatch(/\[truncated\]$/);
      expect(envEntryByteLength('HOOK_USER_PROMPT', env.HOOK_USER_PROMPT)).toBeLessThanOrEqual(MAX_HOOK_ENV_ENTRY_BYTES);
    });

    it('should truncate oversized error message env entries', () => {
      const env = createHookEnvVars({
        event: 'PostToolUseFailure',
        sessionId: 'test-session',
        timestamp: Date.now(),
        workingDirectory: '/test',
        toolName: 'bash',
        toolInput: '{}',
        errorMessage: 'x'.repeat(MAX_HOOK_ENV_ENTRY_BYTES + 1024),
      });
      const stopFailureEnv = createHookEnvVars({
        event: 'StopFailure',
        sessionId: 'test-session',
        timestamp: Date.now(),
        workingDirectory: '/test',
        phase: 'execute',
        error: 'x'.repeat(MAX_HOOK_ENV_ENTRY_BYTES + 1024),
      });

      expect(env.HOOK_ERROR_MESSAGE).toMatch(/\[truncated\]$/);
      expect(envEntryByteLength('HOOK_ERROR_MESSAGE', env.HOOK_ERROR_MESSAGE)).toBeLessThanOrEqual(MAX_HOOK_ENV_ENTRY_BYTES);
      expect(stopFailureEnv.HOOK_ERROR_MESSAGE).toMatch(/\[truncated\]$/);
      expect(envEntryByteLength('HOOK_ERROR_MESSAGE', stopFailureEnv.HOOK_ERROR_MESSAGE)).toBeLessThanOrEqual(MAX_HOOK_ENV_ENTRY_BYTES);
    });

    it('should truncate multibyte hook env values without splitting code points', () => {
      const env = createHookEnvVars({
        event: 'PostToolUse',
        sessionId: 'test-session',
        timestamp: Date.now(),
        workingDirectory: '/test',
        toolName: 'bash',
        toolInput: '你'.repeat(60000),
        toolOutput: '😀'.repeat(40000),
      });

      expect(env.HOOK_TOOL_INPUT).toMatch(/\[truncated\]$/);
      expect(env.HOOK_TOOL_INPUT).not.toContain('\uFFFD');
      expect(env.HOOK_TOOL_INPUT.slice(0, -HOOK_ENV_TRUNCATED_MARKER.length)).toMatch(/你$/);
      expect(envEntryByteLength('HOOK_TOOL_INPUT', env.HOOK_TOOL_INPUT)).toBeLessThanOrEqual(MAX_HOOK_ENV_ENTRY_BYTES);

      expect(env.HOOK_TOOL_OUTPUT).toMatch(/\[truncated\]$/);
      expect(env.HOOK_TOOL_OUTPUT).not.toContain('\uFFFD');
      expect(env.HOOK_TOOL_OUTPUT.slice(0, -HOOK_ENV_TRUNCATED_MARKER.length)).toMatch(/😀$/u);
      expect(envEntryByteLength('HOOK_TOOL_OUTPUT', env.HOOK_TOOL_OUTPUT)).toBeLessThanOrEqual(MAX_HOOK_ENV_ENTRY_BYTES);
    });

    it('should cap multiple oversized hook env payloads independently', () => {
      const env = createHookEnvVars({
        event: 'PostToolUseFailure',
        sessionId: 'test-session',
        timestamp: Date.now(),
        workingDirectory: '/test',
        toolName: 'bash',
        toolInput: 'input'.repeat(40000),
        toolOutput: 'output'.repeat(40000),
        errorMessage: 'error'.repeat(40000),
      });
      const promptEnv = createHookEnvVars({
        event: 'UserPromptSubmit',
        sessionId: 'test-session',
        timestamp: Date.now(),
        workingDirectory: '/test',
        prompt: 'prompt'.repeat(40000),
      });

      for (const [name, value] of [
        ['HOOK_TOOL_INPUT', env.HOOK_TOOL_INPUT],
        ['HOOK_TOOL_OUTPUT', env.HOOK_TOOL_OUTPUT],
        ['HOOK_ERROR_MESSAGE', env.HOOK_ERROR_MESSAGE],
        ['HOOK_USER_PROMPT', promptEnv.HOOK_USER_PROMPT],
      ] as const) {
        expect(value).toMatch(/\[truncated\]$/);
        expect(envEntryByteLength(name, value)).toBeLessThanOrEqual(MAX_HOOK_ENV_ENTRY_BYTES);
      }
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

    it('should expose stop_hook_active flag for stop context retries (GAP-006)', () => {
      const context: StopContext = {
        event: 'Stop',
        sessionId: 'test-session',
        timestamp: Date.now(),
        workingDirectory: '/test',
        response: 'Task completed',
        stopHookActive: true,
      };

      const env = createHookEnvVars(context);

      expect(env.HOOK_STOP_HOOK_ACTIVE).toBe('true');
    });

    it('should expose stop_hook_active=false on first stop trigger (GAP-006)', () => {
      const context: StopContext = {
        event: 'Stop',
        sessionId: 'test-session',
        timestamp: Date.now(),
        workingDirectory: '/test',
        response: 'Task completed',
        stopHookActive: false,
      };

      const env = createHookEnvVars(context);

      expect(env.HOOK_STOP_HOOK_ACTIVE).toBe('false');
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
