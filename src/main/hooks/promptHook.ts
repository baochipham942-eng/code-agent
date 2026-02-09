// ============================================================================
// Prompt-Based Hook Executor
// Use AI to evaluate hooks with dynamic prompts
// ============================================================================

import type { HookExecutionResult, AnyHookContext, HookActionResult } from './events';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('PromptHook');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface PromptHookOptions {
  /** The prompt template with variable placeholders */
  prompt: string;
  /** Timeout for AI evaluation in ms (default: 10000) */
  timeout?: number;
}

/**
 * Function to execute AI completion
 * This should be injected to avoid circular dependencies
 */
export type AICompletionFn = (
  prompt: string,
  options?: { timeout?: number }
) => Promise<string>;

// ----------------------------------------------------------------------------
// Variable Substitution
// ----------------------------------------------------------------------------

/**
 * Variable placeholders supported in prompt templates
 */
const PROMPT_VARIABLES: Record<string, (ctx: AnyHookContext) => string> = {
  '$EVENT': (ctx) => ctx.event,
  '$SESSION_ID': (ctx) => ctx.sessionId,
  '$WORKING_DIR': (ctx) => ctx.workingDirectory,
  '$TIMESTAMP': (ctx) => new Date(ctx.timestamp).toISOString(),
  '$TOOL_NAME': (ctx) => 'toolName' in ctx ? ctx.toolName : '',
  '$TOOL_INPUT': (ctx) => 'toolInput' in ctx ? ctx.toolInput : '',
  '$TOOL_OUTPUT': (ctx) => 'toolOutput' in ctx ? ctx.toolOutput || '' : '',
  '$ERROR_MESSAGE': (ctx) => 'errorMessage' in ctx ? ctx.errorMessage || '' : '',
  '$USER_PROMPT': (ctx) => 'prompt' in ctx ? ctx.prompt : '',
  '$ARGUMENTS': (ctx) => {
    // Generic arguments - tool input for tool events, prompt for user events
    if ('toolInput' in ctx) return ctx.toolInput;
    if ('prompt' in ctx) return ctx.prompt;
    return '';
  },
};

/**
 * Substitute variables in prompt template
 */
export function substitutePromptVariables(
  template: string,
  context: AnyHookContext
): string {
  let result = template;

  for (const [variable, getter] of Object.entries(PROMPT_VARIABLES)) {
    result = result.replace(new RegExp(escapeRegex(variable), 'g'), getter(context));
  }

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ----------------------------------------------------------------------------
// Prompt Hook Executor
// ----------------------------------------------------------------------------

/**
 * Execute a prompt-based hook using AI
 *
 * The AI is asked to evaluate the situation and respond with:
 * - "ALLOW" - proceed with the action
 * - "BLOCK: <reason>" - stop the action with reason
 * - "CONTINUE: <message>" - proceed with additional context
 */
export async function executePromptHook(
  options: PromptHookOptions,
  context: AnyHookContext,
  aiCompletion: AICompletionFn
): Promise<HookExecutionResult> {
  const startTime = Date.now();
  const timeout = options.timeout || 10000;

  try {
    // Substitute variables in prompt
    const processedPrompt = substitutePromptVariables(options.prompt, context);

    // Build the full prompt for AI evaluation
    const fullPrompt = buildEvaluationPrompt(processedPrompt, context);

    logger.debug('Executing prompt hook', {
      event: context.event,
      promptLength: fullPrompt.length,
    });

    // Call AI for evaluation
    const response = await Promise.race([
      aiCompletion(fullPrompt, { timeout }),
      createTimeout(timeout),
    ]);

    const duration = Date.now() - startTime;

    // Parse AI response
    return parseAIResponse(response as string, duration);
  } catch (error: any) {
    const duration = Date.now() - startTime;

    if (error.message === 'Timeout') {
      logger.warn('Prompt hook timed out', { timeout });
      return {
        action: 'allow', // Default to allow on timeout
        message: 'Hook evaluation timed out - defaulting to allow',
        duration,
      };
    }

    logger.error('Prompt hook execution failed', { error: error.message });
    return {
      action: 'error',
      error: error.message || 'Prompt hook execution failed',
      duration,
    };
  }
}

/**
 * Build the full evaluation prompt for AI
 */
function buildEvaluationPrompt(userPrompt: string, context: AnyHookContext): string {
  return `You are a hook evaluator. Based on the following context and evaluation criteria, decide whether to ALLOW, BLOCK, or CONTINUE the action.

## Context
- Event: ${context.event}
- Session ID: ${context.sessionId}
- Working Directory: ${context.workingDirectory}
${buildContextDetails(context)}

## Evaluation Criteria
${userPrompt}

## Response Format
Respond with exactly one of:
- ALLOW - if the action should proceed normally
- BLOCK: <reason> - if the action should be stopped, with explanation
- CONTINUE: <message> - if the action should proceed with the message injected as context

Your response:`;
}

/**
 * Build context-specific details
 */
function buildContextDetails(context: AnyHookContext): string {
  // Tool hook contexts (PreToolUse, PostToolUse, PostToolUseFailure)
  if (context.event === 'PreToolUse' || context.event === 'PostToolUse' || context.event === 'PostToolUseFailure') {
    const toolContext = context as { toolName: string; toolInput: string; toolOutput?: string; errorMessage?: string };
    let details = `- Tool: ${toolContext.toolName}\n- Input: ${toolContext.toolInput}`;
    if (toolContext.toolOutput) {
      details += `\n- Output: ${toolContext.toolOutput}`;
    }
    if (toolContext.errorMessage) {
      details += `\n- Error: ${toolContext.errorMessage}`;
    }
    return details;
  }

  // Permission request context
  if (context.event === 'PermissionRequest') {
    const permContext = context as { toolName: string; permissionType: string; resource: string; reason?: string };
    let details = `- Tool: ${permContext.toolName}\n- Permission: ${permContext.permissionType}\n- Resource: ${permContext.resource}`;
    if (permContext.reason) {
      details += `\n- Reason: ${permContext.reason}`;
    }
    return details;
  }

  if ('prompt' in context) {
    return `- User Prompt: ${(context as { prompt: string }).prompt}`;
  }

  return '';
}

/**
 * Parse AI response into HookExecutionResult
 */
function parseAIResponse(response: string, duration: number): HookExecutionResult {
  const trimmed = response.trim().toUpperCase();

  if (trimmed === 'ALLOW' || trimmed.startsWith('ALLOW')) {
    return { action: 'allow', duration };
  }

  if (trimmed.startsWith('BLOCK')) {
    const reason = response.replace(/^BLOCK:?\s*/i, '').trim();
    return {
      action: 'block',
      message: reason || 'Blocked by prompt hook',
      duration,
    };
  }

  if (trimmed.startsWith('CONTINUE')) {
    const message = response.replace(/^CONTINUE:?\s*/i, '').trim();
    return {
      action: 'continue',
      message: message || undefined,
      duration,
    };
  }

  // Default to allow if response is unclear
  logger.warn('Unclear AI response for prompt hook, defaulting to allow', {
    response: response.substring(0, 100),
  });

  return {
    action: 'allow',
    message: response.trim() || undefined,
    duration,
  };
}

/**
 * Create a timeout promise
 */
function createTimeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Timeout')), ms);
  });
}

/**
 * Create a prompt hook executor with injected AI completion function
 */
export function createPromptHookExecutor(aiCompletion: AICompletionFn) {
  return async (
    options: PromptHookOptions,
    context: AnyHookContext
  ): Promise<HookExecutionResult> => {
    return executePromptHook(options, context, aiCompletion);
  };
}

/**
 * Mock AI completion for testing
 */
export function createMockAICompletion(
  defaultResponse: string = 'ALLOW'
): AICompletionFn {
  return async () => defaultResponse;
}

