// ============================================================================
// Agent Adapter - Bridge between TestRunner and AgentLoop
// ============================================================================

import type { AgentInterface } from './testRunner';
import type { ToolExecutionRecord } from './types';
import type { AgentLoop } from '../agent/agentLoop';
import type { ModelProvider } from '../../shared/contract';
import { createLogger } from '../services/infra/logger';
import { MODEL_MAX_TOKENS } from '../../shared/constants';
import { app } from '../platform';

const logger = createLogger('AgentAdapter');

/**
 * Adapter that connects TestRunner to the real AgentLoop
 */
export class AgentLoopAdapter implements AgentInterface {
  private agentLoop: AgentLoop;
  private agentInfo: {
    name: string;
    model: string;
    provider: string;
  };

  constructor(
    agentLoop: AgentLoop,
    agentInfo: { name: string; model: string; provider: string }
  ) {
    this.agentLoop = agentLoop;
    this.agentInfo = agentInfo;
  }

  /**
   * Send a message to the agent and collect results
   */
  async sendMessage(prompt: string): Promise<{
    responses: string[];
    toolExecutions: ToolExecutionRecord[];
    turnCount: number;
    errors: string[];
  }> {
    const responses: string[] = [];
    const toolExecutions: ToolExecutionRecord[] = [];
    const errors: string[] = [];
    let turnCount = 0;

    // Set up event listeners to capture outputs
    const originalEmit = (this.agentLoop as any).emit?.bind(this.agentLoop);

    try {
      // Hook into agent events if possible
      // This is a simplified version - actual implementation depends on AgentLoop internals

      // Run the agent with the prompt
      await this.agentLoop.run(prompt);

      // After run completes, extract results from the agent state
      // This needs to be adapted based on actual AgentLoop implementation
      const state = (this.agentLoop as any).state || {};

      // Extract responses from messages
      if (state.messages) {
        for (const msg of state.messages) {
          if (msg.role === 'assistant' && msg.content) {
            responses.push(msg.content);
          }
        }
      }

      // Extract tool executions
      if (state.toolExecutions) {
        toolExecutions.push(...state.toolExecutions);
      }

      turnCount = state.turnCount || responses.length;

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message || String(error));
      logger.error('Agent execution error', { error });
    }

    return {
      responses,
      toolExecutions,
      turnCount,
      errors,
    };
  }

  /**
   * Reset agent state for a new test
   */
  async reset(): Promise<void> {
    // Reset the agent loop state
    if (typeof (this.agentLoop as any).reset === 'function') {
      await (this.agentLoop as any).reset();
    }
  }

  /**
   * Get agent info
   */
  getAgentInfo(): { name: string; model: string; provider: string } {
    return this.agentInfo;
  }
}

/**
 * Mock agent for testing the test framework itself
 */
export class MockAgentAdapter implements AgentInterface {
  private responses: Map<string, {
    responses: string[];
    toolExecutions: ToolExecutionRecord[];
    turnCount: number;
    errors: string[];
  }> = new Map();

  private agentInfo = {
    name: 'mock-gen',
    model: 'mock-model',
    provider: 'mock',
  };

  /**
   * Configure mock response for a prompt
   */
  setMockResponse(
    promptPattern: string,
    response: {
      responses: string[];
      toolExecutions: ToolExecutionRecord[];
      turnCount?: number;
      errors?: string[];
    }
  ): void {
    this.responses.set(promptPattern, {
      responses: response.responses,
      toolExecutions: response.toolExecutions,
      turnCount: response.turnCount || 1,
      errors: response.errors || [],
    });
  }

  async sendMessage(prompt: string): Promise<{
    responses: string[];
    toolExecutions: ToolExecutionRecord[];
    turnCount: number;
    errors: string[];
  }> {
    // Find matching mock response
    for (const [pattern, response] of this.responses) {
      if (prompt.includes(pattern) || new RegExp(pattern).test(prompt)) {
        return response;
      }
    }

    // Default response
    return {
      responses: ['Mock response for: ' + prompt],
      toolExecutions: [],
      turnCount: 1,
      errors: [],
    };
  }

  async reset(): Promise<void> {
    // No-op for mock
  }

  getAgentInfo(): { name: string; model: string; provider: string } {
    return this.agentInfo;
  }
}

/**
 * Standalone agent adapter that creates its own agent loop
 * Used for auto-test mode without GUI
 */
export class StandaloneAgentAdapter implements AgentInterface {
  private static _electronMockInjected = false;

  /**
   * Inject electron mock for non-Electron environments (CLI/test mode).
   * No-op if mock is already injected (e.g., by real-test-entry.ts bootstrap).
   */
  static async _ensureElectronMock(): Promise<void> {
    if (StandaloneAgentAdapter._electronMockInjected || process.versions.electron) {
      return;
    }

    // Check if platform module is available (e.g., by CJS entry point)
    try {
      if (app?.getName?.()) {
        StandaloneAgentAdapter._electronMockInjected = true;
        return;
      }
    } catch { /* not available yet */ }

    StandaloneAgentAdapter._electronMockInjected = true;

    // For ESM environments (npx tsx), use dynamic import + require patching
    try {
      const { createRequire } = await import('module');
      const _require = createRequire(import.meta.url);
      const electronMock = (await import('../../cli/electron-mock')).default;

      const Module = _require('module') as any;
      const originalRequire = Module.prototype.require;
      Module.prototype.require = function(id: string) {
        if (id === 'electron' || id === '../platform') {
          return electronMock;
        }
        return originalRequire.apply(this, arguments);
      };
    } catch {
      // CJS bundled mode — electron mock should already be injected by entry point
    }
  }

  private workingDirectory: string;
  private generation: string;
  private toolMode: 'all' | 'deferred';
  private currentSessionId?: string;
  private modelConfig: {
    provider: string;
    model: string;
    apiKey?: string;
  };

  // Persisted across sendMessage() calls so multi-turn follow-ups share conversation history.
  // Cleared by reset() between cases (testRunner calls reset before each case's first prompt).
  private messages: import('../../shared/contract').Message[] = [];

  constructor(config: {
    workingDirectory: string;
    generation: string;
    modelConfig: {
      provider: string;
      model: string;
      apiKey?: string;
    };
    toolMode?: 'all' | 'deferred';
  }) {
    this.workingDirectory = config.workingDirectory;
    this.generation = config.generation;
    this.modelConfig = config.modelConfig;
    this.toolMode = config.toolMode ?? 'deferred';
    // Eval-mode signal: prevents cross-case prompt contamination via recent_conversations.
    process.env.CODE_AGENT_DISABLE_RECENT_CONVERSATIONS = 'true';
  }

  async sendMessage(prompt: string): Promise<{
    responses: string[];
    toolExecutions: ToolExecutionRecord[];
    turnCount: number;
    errors: string[];
  }> {
    const responses: string[] = [];
    const toolExecutions: ToolExecutionRecord[] = [];
    const errors: string[] = [];
    let turnCount = 0;

    // Track in-flight tool calls for pairing start/end events
    const pendingToolCalls = new Map<string, { name: string; args: Record<string, unknown>; startTime: number }>();

    try {
      // Inject electron mock when not running inside Electron
      await StandaloneAgentAdapter._ensureElectronMock();

      // Dynamic imports (safe after electron mock is in place)
      const { AgentLoop } = await import('../agent/agentLoop');
      const { SYSTEM_PROMPT } = await import('../prompts/builder');
      const { ToolExecutor } = await import('../tools/toolExecutor');

      // 1. System prompt

      // 2. ToolExecutor (auto-approve all permissions for testing)
      const toolExecutor = new ToolExecutor({
        requestPermission: async () => true,
        workingDirectory: this.workingDirectory,
      });

      // 3. Shared messages array — persisted on the adapter instance so follow-up
      // prompts within the same case see prior tool_results and assistant responses.
      // reset() clears this between cases.
      const messages = this.messages;

      // 4. Create AgentLoop with correct event handlers
      // Reuse session id across follow-ups so AgentLoop's session-scoped state stays consistent.
      if (!this.currentSessionId) this.currentSessionId = `test-${Date.now()}`;
      const loop = new AgentLoop({
        sessionId: this.currentSessionId,
        workingDirectory: this.workingDirectory,
        systemPrompt: SYSTEM_PROMPT,
        modelConfig: {
          provider: this.modelConfig.provider as ModelProvider,
          model: this.modelConfig.model,
          apiKey: this.modelConfig.apiKey || '',
          temperature: 0.3,
          maxTokens: MODEL_MAX_TOKENS.DEFAULT,
        },
        toolExecutor,
        messages,
        enableHooks: false,
        enableToolDeferredLoading: this.toolMode === 'deferred',
        autoApprovePlan: true,
        onEvent: (event) => {
          switch (event.type) {
            case 'message':
              if (event.data?.role === 'assistant' && event.data?.content) {
                responses.push(event.data.content);
                turnCount++;
              }
              break;
            case 'tool_call_start':
              pendingToolCalls.set(event.data.id, {
                name: event.data.name,
                args: event.data.arguments || {},
                startTime: Date.now(),
              });
              break;
            case 'tool_call_end': {
              const pending = pendingToolCalls.get(event.data.toolCallId);
              if (pending) {
                toolExecutions.push({
                  tool: pending.name,
                  input: pending.args,
                  output: event.data.output || '',
                  success: event.data.success,
                  error: event.data.error,
                  duration: event.data.duration || (Date.now() - pending.startTime),
                  timestamp: Date.now(),
                });
                pendingToolCalls.delete(event.data.toolCallId);
              }
              break;
            }
            case 'error':
              errors.push(event.data?.message || 'Unknown error');
              break;
          }
        },
      });

      // Add user message to messages array before run() - 
      // orchestrator does this but test adapter was missing it
      messages.push({
        id: `user-${Date.now()}`,
        role: 'user',
        content: prompt,
        timestamp: Date.now(),
      } as import('../../shared/contract').Message);

      await loop.run(prompt);

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message || String(error));
    }

    return { responses, toolExecutions, turnCount: turnCount || responses.length, errors };
  }

  async reset(): Promise<void> {
    // Clear conversation history and session id between cases so each case starts fresh.
    // Within a case, sendMessage() reuses this.messages so follow-ups share history.
    this.messages = [];
    this.currentSessionId = undefined;
  }

  getAgentInfo(): { name: string; model: string; provider: string } {
    return {
      name: this.generation,
      model: this.modelConfig.model,
      provider: this.modelConfig.provider,
    };
  }

  getSessionId(): string | undefined {
    return this.currentSessionId;
  }
}
