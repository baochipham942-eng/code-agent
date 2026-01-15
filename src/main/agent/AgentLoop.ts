// ============================================================================
// Agent Loop - Core event loop for AI agent execution
// Enhanced with Manus-style persistent planning hooks
// ============================================================================

import type {
  Generation,
  ModelConfig,
  Message,
  ToolCall,
  ToolResult,
  AgentEvent,
} from '../../shared/types';
import type { ToolRegistry } from '../tools/ToolRegistry';
import type { ToolExecutor } from '../tools/ToolExecutor';
import { ModelRouter } from '../model/ModelRouter';
import type { PlanningService } from '../planning';
import { getMemoryService } from '../memory/MemoryService';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface AgentLoopConfig {
  generation: Generation;
  modelConfig: ModelConfig;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  messages: Message[];
  onEvent: (event: AgentEvent) => void;
  // New: optional planning service for persistent planning
  planningService?: PlanningService;
  // New: enable/disable hooks
  enableHooks?: boolean;
}

interface ModelResponse {
  type: 'text' | 'tool_use';
  content?: string;
  toolCalls?: ToolCall[];
}

// ----------------------------------------------------------------------------
// Agent Loop
// ----------------------------------------------------------------------------

export class AgentLoop {
  private generation: Generation;
  private modelConfig: ModelConfig;
  private toolRegistry: ToolRegistry;
  private toolExecutor: ToolExecutor;
  private messages: Message[];
  private onEvent: (event: AgentEvent) => void;
  private modelRouter: ModelRouter;
  private isCancelled: boolean = false;
  private maxIterations: number = 50;

  // Planning integration
  private planningService?: PlanningService;
  private enableHooks: boolean;

  constructor(config: AgentLoopConfig) {
    this.generation = config.generation;
    this.modelConfig = config.modelConfig;
    this.toolRegistry = config.toolRegistry;
    this.toolExecutor = config.toolExecutor;
    this.messages = config.messages;
    this.onEvent = config.onEvent;
    this.modelRouter = new ModelRouter();

    // Planning service integration
    this.planningService = config.planningService;
    this.enableHooks = config.enableHooks ?? true;
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  async run(userMessage: string): Promise<void> {
    console.log('[AgentLoop] run() called with message:', userMessage.substring(0, 100));

    // Session Start Hook
    if (this.enableHooks && this.planningService) {
      await this.runSessionStartHook();
    }

    let iterations = 0;

    while (!this.isCancelled && iterations < this.maxIterations) {
      iterations++;
      console.log(`[AgentLoop] Iteration ${iterations}...`);

      // 1. Call model
      console.log('[AgentLoop] Calling inference...');
      const response = await this.inference();
      console.log('[AgentLoop] Inference response type:', response.type);

      // 2. Handle text response
      if (response.type === 'text' && response.content) {
        // Stop Hook - verify completion before stopping
        if (this.enableHooks && this.planningService) {
          const stopResult = await this.planningService.hooks.onStop();

          if (!stopResult.shouldContinue && stopResult.injectContext) {
            // Plan not complete, inject warning and continue
            this.injectSystemMessage(stopResult.injectContext);

            if (stopResult.notification) {
              this.onEvent({
                type: 'notification',
                data: { message: stopResult.notification },
              });
            }

            continue; // Force another iteration
          }

          if (stopResult.notification) {
            this.onEvent({
              type: 'notification',
              data: { message: stopResult.notification },
            });
          }
        }

        const assistantMessage: Message = {
          id: this.generateId(),
          role: 'assistant',
          content: response.content,
          timestamp: Date.now(),
        };
        this.messages.push(assistantMessage);
        this.onEvent({ type: 'message', data: assistantMessage });
        break;
      }

      // 3. Handle tool calls
      if (response.type === 'tool_use' && response.toolCalls) {
        // Create assistant message with tool calls
        const assistantMessage: Message = {
          id: this.generateId(),
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          toolCalls: response.toolCalls,
        };
        this.messages.push(assistantMessage);

        // Send the message event to frontend so it can display tool calls
        this.onEvent({ type: 'message', data: assistantMessage });

        // Execute tools (with hooks)
        const toolResults = await this.executeToolsWithHooks(response.toolCalls);

        // Create tool result message
        const toolMessage: Message = {
          id: this.generateId(),
          role: 'tool',
          content: JSON.stringify(toolResults),
          timestamp: Date.now(),
          toolResults,
        };
        this.messages.push(toolMessage);

        // Continue loop
        continue;
      }

      // No response, break
      break;
    }

    if (iterations >= this.maxIterations) {
      this.onEvent({
        type: 'error',
        data: { message: 'Max iterations reached' },
      });
    }

    // Signal completion to frontend
    this.onEvent({ type: 'agent_complete', data: null });
  }

  cancel(): void {
    this.isCancelled = true;
  }

  // Getter for planning service (for tools that need it)
  getPlanningService(): PlanningService | undefined {
    return this.planningService;
  }

  // --------------------------------------------------------------------------
  // Hook Methods
  // --------------------------------------------------------------------------

  private async runSessionStartHook(): Promise<void> {
    if (!this.planningService) return;

    try {
      const result = await this.planningService.hooks.onSessionStart();

      if (result.injectContext) {
        this.injectSystemMessage(result.injectContext);
      }

      if (result.notification) {
        this.onEvent({
          type: 'notification',
          data: { message: result.notification },
        });
      }
    } catch (error) {
      console.error('Session start hook error:', error);
    }
  }

  private async executeToolsWithHooks(
    toolCalls: ToolCall[]
  ): Promise<ToolResult[]> {
    console.log(`[AgentLoop] executeToolsWithHooks called with ${toolCalls.length} tool calls`);
    const results: ToolResult[] = [];

    for (const toolCall of toolCalls) {
      console.log(`[AgentLoop] Processing tool call: ${toolCall.name}, id: ${toolCall.id}`);
      if (this.isCancelled) break;

      // Pre-Tool Hook
      if (this.enableHooks && this.planningService) {
        try {
          const preResult = await this.planningService.hooks.preToolUse({
            toolName: toolCall.name,
            toolParams: toolCall.arguments,
          });

          if (preResult.injectContext) {
            this.injectSystemMessage(preResult.injectContext);
          }
        } catch (error) {
          console.error('Pre-tool hook error:', error);
        }
      }

      // Emit tool call start event
      this.onEvent({ type: 'tool_call_start', data: toolCall });

      const startTime = Date.now();

      try {
        // Execute tool
        const result = await this.toolExecutor.execute(
          toolCall.name,
          toolCall.arguments,
          {
            generation: this.generation,
            planningService: this.planningService, // Pass planning service to tools
            modelConfig: this.modelConfig, // Pass model config for subagent execution
          }
        );

        const toolResult: ToolResult = {
          toolCallId: toolCall.id,
          success: result.success,
          output: result.output,
          error: result.error,
          duration: Date.now() - startTime,
        };

        results.push(toolResult);

        // Post-Tool Hook
        if (this.enableHooks && this.planningService) {
          try {
            const postResult = await this.planningService.hooks.postToolUse({
              toolName: toolCall.name,
              toolParams: toolCall.arguments,
              toolResult: result,
            });

            if (postResult.injectContext) {
              this.injectSystemMessage(postResult.injectContext);
            }
          } catch (error) {
            console.error('Post-tool hook error:', error);
          }
        }

        // Emit tool call end event
        this.onEvent({ type: 'tool_call_end', data: toolResult });
      } catch (error) {
        const toolResult: ToolResult = {
          toolCallId: toolCall.id,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          duration: Date.now() - startTime,
        };

        results.push(toolResult);

        // Error Hook
        if (this.enableHooks && this.planningService) {
          try {
            const errorResult = await this.planningService.hooks.onError({
              toolName: toolCall.name,
              toolParams: toolCall.arguments,
              error: error instanceof Error ? error : new Error('Unknown error'),
            });

            if (errorResult.injectContext) {
              this.injectSystemMessage(errorResult.injectContext);
            }
          } catch (hookError) {
            console.error('Error hook error:', hookError);
          }
        }

        this.onEvent({ type: 'tool_call_end', data: toolResult });
      }
    }

    return results;
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private async inference(): Promise<ModelResponse> {
    // Get available tools for current generation
    const tools = this.toolRegistry.getToolDefinitions(this.generation.id);
    console.log(`[AgentLoop] Tools for ${this.generation.id}:`, tools.map(t => t.name));

    // Build messages for model
    const modelMessages = this.buildModelMessages();
    console.log('[AgentLoop] Model messages count:', modelMessages.length);
    console.log('[AgentLoop] Model config:', {
      provider: this.modelConfig.provider,
      model: this.modelConfig.model,
      hasApiKey: !!this.modelConfig.apiKey,
    });

    try {
      // Call model through router
      console.log('[AgentLoop] Calling modelRouter.inference()...');
      const response = await this.modelRouter.inference(
        modelMessages,
        tools,
        this.modelConfig,
        (chunk) => {
          // Handle streaming chunks
          this.onEvent({ type: 'stream_chunk', data: { content: chunk } });
        }
      );

      console.log('[AgentLoop] Model response received:', response.type);
      return response;
    } catch (error) {
      console.error('[AgentLoop] Model inference error:', error);
      throw error;
    }
  }

  private buildModelMessages(): Array<{ role: string; content: string }> {
    const modelMessages: Array<{ role: string; content: string }> = [];

    // Build enhanced system prompt for Gen5
    let systemPrompt = this.generation.systemPrompt;

    if (this.generation.id === 'gen5') {
      systemPrompt = this.buildEnhancedSystemPrompt(systemPrompt);
    }

    // Add system prompt
    modelMessages.push({
      role: 'system',
      content: systemPrompt,
    });

    // Add conversation history
    for (const message of this.messages) {
      if (message.role === 'tool') {
        // Convert tool results to user message format
        modelMessages.push({
          role: 'user',
          content: `Tool results:\n${message.content}`,
        });
      } else if (message.role === 'assistant' && message.toolCalls) {
        // Format tool calls
        const toolCallsStr = message.toolCalls
          .map((tc) => `Calling ${tc.name}(${JSON.stringify(tc.arguments)})`)
          .join('\n');
        modelMessages.push({
          role: 'assistant',
          content: toolCallsStr || message.content,
        });
      } else {
        modelMessages.push({
          role: message.role,
          content: message.content,
        });
      }
    }

    return modelMessages;
  }

  /**
   * Build enhanced system prompt with RAG context for Gen5
   * Retrieves relevant knowledge, code patterns, and user preferences
   */
  private buildEnhancedSystemPrompt(basePrompt: string): string {
    try {
      const memoryService = getMemoryService();
      let enhancedPrompt = basePrompt;

      // Get user query from the last user message
      const lastUserMessage = [...this.messages]
        .reverse()
        .find((m) => m.role === 'user');
      const userQuery = lastUserMessage?.content || '';

      if (!userQuery) {
        return basePrompt;
      }

      // Add RAG context
      const ragContext = memoryService.getRAGContext(userQuery, {
        includeCode: true,
        includeKnowledge: true,
        includeConversations: false, // Avoid duplication with message history
        maxTokens: 1500,
      });

      if (ragContext && ragContext.trim().length > 0) {
        enhancedPrompt += `\n\n## Relevant Context from Memory\n\nThe following context was retrieved from your knowledge base and may be helpful:\n\n${ragContext}`;
      }

      // Add project knowledge
      const projectKnowledge = memoryService.getProjectKnowledge();
      if (projectKnowledge.length > 0) {
        const knowledgeStr = projectKnowledge
          .slice(0, 5)
          .map((k) => `- **${k.key}**: ${typeof k.value === 'string' ? k.value : JSON.stringify(k.value)}`)
          .join('\n');
        enhancedPrompt += `\n\n## Project Knowledge\n\n${knowledgeStr}`;
      }

      // Add user coding preferences
      const codingStyle = memoryService.getUserPreference<Record<string, unknown>>('coding_style');
      if (codingStyle && Object.keys(codingStyle).length > 0) {
        const styleStr = Object.entries(codingStyle)
          .map(([key, value]) => `- ${key}: ${value}`)
          .join('\n');
        enhancedPrompt += `\n\n## User Coding Preferences\n\n${styleStr}`;
      }

      console.log(`[AgentLoop] Enhanced system prompt with RAG context (${ragContext?.length || 0} chars)`);
      return enhancedPrompt;
    } catch (error) {
      console.error('[AgentLoop] Failed to build enhanced system prompt:', error);
      return basePrompt;
    }
  }

  /**
   * Inject a system message into the conversation
   * Used by hooks to add context reminders
   */
  private injectSystemMessage(content: string): void {
    const systemMessage: Message = {
      id: this.generateId(),
      role: 'system',
      content,
      timestamp: Date.now(),
    };
    this.messages.push(systemMessage);
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
