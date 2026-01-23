// ============================================================================
// Prompt Hook Tests
// ============================================================================
//
// Tests for the prompt-based hook execution module.
// Tests cover:
// - Variable substitution in prompts
// - AI response parsing
// - Mock AI completion
// - Timeout handling
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  executePromptHook,
  substitutePromptVariables,
  createPromptHookExecutor,
  createMockAICompletion,
  type AICompletionFn,
} from '../../../src/main/hooks/promptHook';
import type { ToolHookContext, UserPromptContext, SessionContext } from '../../../src/main/hooks/events';

describe('Prompt Hook', () => {
  // --------------------------------------------------------------------------
  // substitutePromptVariables
  // --------------------------------------------------------------------------
  describe('substitutePromptVariables', () => {
    it('should substitute $EVENT variable', () => {
      const context: SessionContext = {
        event: 'SessionStart',
        sessionId: 'test-123',
        timestamp: Date.now(),
        workingDirectory: '/test',
      };

      const result = substitutePromptVariables('Event: $EVENT', context);
      expect(result).toBe('Event: SessionStart');
    });

    it('should substitute $SESSION_ID variable', () => {
      const context: SessionContext = {
        event: 'SessionStart',
        sessionId: 'my-session-456',
        timestamp: Date.now(),
        workingDirectory: '/test',
      };

      const result = substitutePromptVariables('Session: $SESSION_ID', context);
      expect(result).toBe('Session: my-session-456');
    });

    it('should substitute $TOOL_NAME and $TOOL_INPUT for tool contexts', () => {
      const context: ToolHookContext = {
        event: 'PreToolUse',
        sessionId: 'test',
        timestamp: Date.now(),
        workingDirectory: '/test',
        toolName: 'bash',
        toolInput: '{"command": "ls -la"}',
      };

      const result = substitutePromptVariables(
        'Tool: $TOOL_NAME, Input: $TOOL_INPUT',
        context
      );
      expect(result).toBe('Tool: bash, Input: {"command": "ls -la"}');
    });

    it('should substitute $USER_PROMPT for user prompt contexts', () => {
      const context: UserPromptContext = {
        event: 'UserPromptSubmit',
        sessionId: 'test',
        timestamp: Date.now(),
        workingDirectory: '/test',
        prompt: 'Help me fix this bug',
      };

      const result = substitutePromptVariables('User said: $USER_PROMPT', context);
      expect(result).toBe('User said: Help me fix this bug');
    });

    it('should substitute $ARGUMENTS with tool input', () => {
      const context: ToolHookContext = {
        event: 'PreToolUse',
        sessionId: 'test',
        timestamp: Date.now(),
        workingDirectory: '/test',
        toolName: 'bash',
        toolInput: '{"command": "npm test"}',
      };

      const result = substitutePromptVariables('Args: $ARGUMENTS', context);
      expect(result).toBe('Args: {"command": "npm test"}');
    });

    it('should substitute $ARGUMENTS with user prompt', () => {
      const context: UserPromptContext = {
        event: 'UserPromptSubmit',
        sessionId: 'test',
        timestamp: Date.now(),
        workingDirectory: '/test',
        prompt: 'Build the project',
      };

      const result = substitutePromptVariables('Args: $ARGUMENTS', context);
      expect(result).toBe('Args: Build the project');
    });

    it('should handle multiple variable substitutions', () => {
      const context: ToolHookContext = {
        event: 'PreToolUse',
        sessionId: 'session-abc',
        timestamp: Date.now(),
        workingDirectory: '/project',
        toolName: 'edit_file',
        toolInput: '{"path": "test.ts"}',
      };

      const template = 'Event: $EVENT, Tool: $TOOL_NAME in $WORKING_DIR';
      const result = substitutePromptVariables(template, context);
      expect(result).toBe('Event: PreToolUse, Tool: edit_file in /project');
    });

    it('should return empty string for missing context properties', () => {
      const context: SessionContext = {
        event: 'SessionStart',
        sessionId: 'test',
        timestamp: Date.now(),
        workingDirectory: '/test',
      };

      const result = substitutePromptVariables('Tool: $TOOL_NAME', context);
      expect(result).toBe('Tool: ');
    });
  });

  // --------------------------------------------------------------------------
  // createMockAICompletion
  // --------------------------------------------------------------------------
  describe('createMockAICompletion', () => {
    it('should return default ALLOW response', async () => {
      const mockAI = createMockAICompletion();
      const result = await mockAI('any prompt');
      expect(result).toBe('ALLOW');
    });

    it('should return custom response', async () => {
      const mockAI = createMockAICompletion('BLOCK: Not allowed');
      const result = await mockAI('any prompt');
      expect(result).toBe('BLOCK: Not allowed');
    });
  });

  // --------------------------------------------------------------------------
  // executePromptHook
  // --------------------------------------------------------------------------
  describe('executePromptHook', () => {
    const createContext = (): ToolHookContext => ({
      event: 'PreToolUse',
      sessionId: 'test-session',
      timestamp: Date.now(),
      workingDirectory: '/test/project',
      toolName: 'bash',
      toolInput: '{"command": "rm -rf /"}',
    });

    it('should return allow action for ALLOW response', async () => {
      const aiCompletion: AICompletionFn = async () => 'ALLOW';
      const result = await executePromptHook(
        { prompt: 'Evaluate this' },
        createContext(),
        aiCompletion
      );

      expect(result.action).toBe('allow');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should return block action for BLOCK response', async () => {
      const aiCompletion: AICompletionFn = async () => 'BLOCK: Dangerous command detected';
      const result = await executePromptHook(
        { prompt: 'Evaluate this' },
        createContext(),
        aiCompletion
      );

      expect(result.action).toBe('block');
      expect(result.message).toBe('Dangerous command detected');
    });

    it('should return continue action for CONTINUE response', async () => {
      const aiCompletion: AICompletionFn = async () => 'CONTINUE: Added safety warning';
      const result = await executePromptHook(
        { prompt: 'Evaluate this' },
        createContext(),
        aiCompletion
      );

      expect(result.action).toBe('continue');
      expect(result.message).toBe('Added safety warning');
    });

    it('should default to allow for unclear response', async () => {
      const aiCompletion: AICompletionFn = async () => 'Some unclear response';
      const result = await executePromptHook(
        { prompt: 'Evaluate this' },
        createContext(),
        aiCompletion
      );

      expect(result.action).toBe('allow');
    });

    it('should handle AI errors gracefully', async () => {
      const aiCompletion: AICompletionFn = async () => {
        throw new Error('AI service unavailable');
      };
      const result = await executePromptHook(
        { prompt: 'Evaluate this' },
        createContext(),
        aiCompletion
      );

      expect(result.action).toBe('error');
      expect(result.error).toBe('AI service unavailable');
    });

    it('should substitute variables in prompt', async () => {
      let receivedPrompt = '';
      const aiCompletion: AICompletionFn = async (prompt) => {
        receivedPrompt = prompt;
        return 'ALLOW';
      };

      await executePromptHook(
        { prompt: 'Tool: $TOOL_NAME is being used' },
        createContext(),
        aiCompletion
      );

      expect(receivedPrompt).toContain('Tool: bash is being used');
    });

    it('should handle case-insensitive responses', async () => {
      const aiCompletion: AICompletionFn = async () => 'allow';
      const result = await executePromptHook(
        { prompt: 'Evaluate' },
        createContext(),
        aiCompletion
      );

      expect(result.action).toBe('allow');
    });

    it('should handle BLOCK without message', async () => {
      const aiCompletion: AICompletionFn = async () => 'BLOCK';
      const result = await executePromptHook(
        { prompt: 'Evaluate' },
        createContext(),
        aiCompletion
      );

      expect(result.action).toBe('block');
      expect(result.message).toBe('Blocked by prompt hook');
    });
  });

  // --------------------------------------------------------------------------
  // createPromptHookExecutor
  // --------------------------------------------------------------------------
  describe('createPromptHookExecutor', () => {
    it('should create executor with injected AI function', async () => {
      const mockAI = createMockAICompletion('ALLOW');
      const executor = createPromptHookExecutor(mockAI);

      const context: ToolHookContext = {
        event: 'PreToolUse',
        sessionId: 'test',
        timestamp: Date.now(),
        workingDirectory: '/test',
        toolName: 'bash',
        toolInput: '{}',
      };

      const result = await executor({ prompt: 'Test' }, context);
      expect(result.action).toBe('allow');
    });

    it('should use injected AI for all executions', async () => {
      let callCount = 0;
      const mockAI: AICompletionFn = async () => {
        callCount++;
        return 'ALLOW';
      };
      const executor = createPromptHookExecutor(mockAI);

      const context: SessionContext = {
        event: 'SessionStart',
        sessionId: 'test',
        timestamp: Date.now(),
        workingDirectory: '/test',
      };

      await executor({ prompt: 'Test 1' }, context);
      await executor({ prompt: 'Test 2' }, context);

      expect(callCount).toBe(2);
    });
  });
});
