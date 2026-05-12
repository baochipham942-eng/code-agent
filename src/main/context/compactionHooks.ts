import type { Message } from '../../shared/contract';

export interface PreCompactHookResultLike {
  preservedContext?: string;
}

export interface CompactionHookManagerLike {
  triggerPreCompact?: (
    sessionId: string,
    messages: Message[],
    tokenCount: number,
    targetTokenCount: number
  ) => Promise<PreCompactHookResultLike> | PreCompactHookResultLike;
  triggerPostCompact?: (
    savedTokens: number,
    strategy: string,
    sessionId: string
  ) => Promise<unknown> | unknown;
}

export interface CompactionHookLoggerLike {
  warn: (message: string, error?: unknown) => void;
}

export interface RunPreCompactHooksInput {
  hookManager?: CompactionHookManagerLike;
  sessionId: string;
  messages: Message[];
  tokenCount: number;
  targetTokenCount: number;
  logger?: CompactionHookLoggerLike;
}

export interface RunPreCompactHooksResult {
  preservedContext?: string;
  warnings: string[];
}

export interface RunPostCompactHooksInput {
  hookManager?: CompactionHookManagerLike;
  sessionId: string;
  savedTokens: number;
  strategy: string;
  logger?: CompactionHookLoggerLike;
}

export interface RunPostCompactHooksResult {
  warnings: string[];
}

export async function runPreCompactHooks(
  input: RunPreCompactHooksInput
): Promise<RunPreCompactHooksResult> {
  const warnings: string[] = [];
  const hookManager = input.hookManager;

  if (!hookManager?.triggerPreCompact) {
    return { warnings };
  }

  try {
    const result = await hookManager.triggerPreCompact(
      input.sessionId,
      input.messages,
      input.tokenCount,
      input.targetTokenCount
    );

    return {
      preservedContext: result.preservedContext,
      warnings,
    };
  } catch (error) {
    const warning = formatHookWarning('PreCompact hook failed', error);
    warnings.push(warning);
    input.logger?.warn(warning, error);
    return { warnings };
  }
}

export async function runPostCompactHooks(
  input: RunPostCompactHooksInput
): Promise<RunPostCompactHooksResult> {
  const warnings: string[] = [];
  const hookManager = input.hookManager;

  if (!hookManager?.triggerPostCompact) {
    return { warnings };
  }

  try {
    await hookManager.triggerPostCompact(
      input.savedTokens,
      input.strategy,
      input.sessionId
    );
  } catch (error) {
    const warning = formatHookWarning('PostCompact hook failed', error);
    warnings.push(warning);
    input.logger?.warn(warning, error);
  }

  return { warnings };
}

function formatHookWarning(prefix: string, error: unknown): string {
  if (error instanceof Error && error.message) {
    return `${prefix}: ${error.message}`;
  }

  if (typeof error === 'string' && error) {
    return `${prefix}: ${error}`;
  }

  return prefix;
}
