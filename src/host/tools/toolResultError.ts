type FailedResultLike = {
  success: boolean;
  error?: string;
  output?: string;
  metadata?: Record<string, unknown>;
};

const FAILURE_REASON_KEYS = ['error', 'errorMessage', 'reason', 'message', 'stderr'] as const;
const MAX_FAILURE_REASON_LENGTH = 500;

function compactReason(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, MAX_FAILURE_REASON_LENGTH);
}

function readStructuredOutputReason(output: string | undefined): string | null {
  const trimmed = output?.trim();
  if (!trimmed?.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of FAILURE_REASON_KEYS) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) return compactReason(value);
    }
  } catch {
    // 普通文本 output 不自动提升为 error，避免把大段或敏感输出误当错误详情。
  }
  return null;
}

function resolveMissingFailureReason(result: FailedResultLike): string {
  for (const key of FAILURE_REASON_KEYS) {
    const value = result.metadata?.[key];
    if (typeof value === 'string' && value.trim()) return compactReason(value);
  }

  const structuredOutputReason = readStructuredOutputReason(result.output);
  if (structuredOutputReason) return structuredOutputReason;

  const code = result.metadata?.code;
  const codeSuffix = typeof code === 'string' || typeof code === 'number'
    ? ` (${String(code)})`
    : '';
  return `execution backend returned failure${codeSuffix} without an error message`;
}

/**
 * Tool execution boundary invariant: every failed result carries a readable error.
 * Existing errors remain byte-for-byte stable; only missing/blank errors are repaired.
 */
export function ensureFailedToolResultError<T extends FailedResultLike>(
  toolName: string,
  result: T,
): T {
  if (result.success !== false || (typeof result.error === 'string' && result.error.trim())) {
    return result;
  }
  const displayName = toolName.trim() || 'unknown';
  return {
    ...result,
    error: `Tool "${displayName}" failed: ${resolveMissingFailureReason(result)}`,
  };
}
