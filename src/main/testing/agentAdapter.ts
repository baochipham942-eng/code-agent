// ============================================================================
// Agent Adapter - Bridge between TestRunner and AgentLoop
// ============================================================================

import type { AgentInterface } from './testRunner';
import type { ToolExecutionRecord } from './types';
import type { AgentLoop } from '../agent/agentLoop';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('AgentAdapter');

/**
 * Adapter that connects TestRunner to the real AgentLoop
 */
export class AgentLoopAdapter implements AgentInterface {
  private agentLoop: AgentLoop;
  private generationInfo: {
    name: string;
    model: string;
    provider: string;
  };

  constructor(
    agentLoop: AgentLoop,
    generationInfo: { name: string; model: string; provider: string }
  ) {
    this.agentLoop = agentLoop;
    this.generationInfo = generationInfo;
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
    const originalEmit = this.agentLoop.emit?.bind(this.agentLoop);

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

    } catch (error: any) {
      errors.push(error.message || String(error));
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
   * Get generation info
   */
  getGenerationInfo(): { name: string; model: string; provider: string } {
    return this.generationInfo;
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

  private generationInfo = {
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

  getGenerationInfo(): { name: string; model: string; provider: string } {
    return this.generationInfo;
  }
}

/**
 * Standalone agent adapter that creates its own agent loop
 * Used for auto-test mode without GUI
 */
export class StandaloneAgentAdapter implements AgentInterface {
  private workingDirectory: string;
  private generation: string;
  private modelConfig: {
    provider: string;
    model: string;
    apiKey?: string;
  };

  constructor(config: {
    workingDirectory: string;
    generation: string;
    modelConfig: {
      provider: string;
      model: string;
      apiKey?: string;
    };
  }) {
    this.workingDirectory = config.workingDirectory;
    this.generation = config.generation;
    this.modelConfig = config.modelConfig;
  }

  async sendMessage(prompt: string): Promise<{
    responses: string[];
    toolExecutions: ToolExecutionRecord[];
    turnCount: number;
    errors: string[];
  }> {
    // This would create a new AgentLoop instance and run the prompt
    // Implementation depends on making AgentLoop standalone-compatible

    const responses: string[] = [];
    const toolExecutions: ToolExecutionRecord[] = [];
    const errors: string[] = [];
    let turnCount = 0;

    try {
      // Dynamic import to avoid circular dependencies
      const { AgentLoop } = await import('../agent/agentLoop');
      const { GenerationManager } = await import('../generation/GenerationManager');
      const { ModelRouter } = await import('../model/ModelRouter');
      const { ToolRegistry } = await import('../tools/ToolRegistry');

      const generationManager = new GenerationManager();
      generationManager.switchGeneration(this.generation as any);
      const generation = generationManager.getCurrentGeneration();

      const modelRouter = new ModelRouter();
      const toolRegistry = new ToolRegistry();

      // Create a minimal agent loop for testing
      const loop = new AgentLoop({
        sessionId: `test-${Date.now()}`,
        workingDirectory: this.workingDirectory,
        generationManager,
        modelRouter,
        toolRegistry,
        modelConfig: this.modelConfig as any,
        onMessage: (msg) => {
          if (msg.role === 'assistant' && msg.content) {
            responses.push(msg.content);
          }
        },
        onToolExecution: (te) => {
          toolExecutions.push({
            tool: te.tool,
            input: te.input,
            output: te.output || '',
            success: te.success,
            error: te.error,
            duration: te.duration,
            timestamp: Date.now(),
          });
        },
      });

      await loop.run(prompt);
      turnCount = loop.getTurnCount?.() || responses.length;

    } catch (error: any) {
      errors.push(error.message || String(error));
    }

    return { responses, toolExecutions, turnCount, errors };
  }

  async reset(): Promise<void> {
    // Each sendMessage creates a new loop, so no state to reset
  }

  getGenerationInfo(): { name: string; model: string; provider: string } {
    return {
      name: this.generation,
      model: this.modelConfig.model,
      provider: this.modelConfig.provider,
    };
  }
}
