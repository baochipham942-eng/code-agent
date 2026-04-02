// ============================================================================
// HTTP Hook Executor - POST hook input to remote URL
// ============================================================================

import { createLogger } from '../services/infra/logger';
import type { AnyHookContext, HookExecutionResult } from './events';

const logger = createLogger('HttpHookExecutor');

export interface HttpHookOptions {
  /** Target URL to POST to */
  url: string;
  /** HTTP headers (supports env var interpolation: $ENV_VAR) */
  headers?: Record<string, string>;
  /** Timeout in milliseconds (default 10000) */
  timeout?: number;
  /** List of allowed env vars for header interpolation */
  allowedEnvVars?: string[];
}

/**
 * Execute an HTTP hook by POSTing the hook context as JSON.
 *
 * Response format (JSON):
 * { "action": "allow"|"block"|"continue", "message": "...", "modifiedInput": "..." }
 */
export async function executeHttpHook(
  options: HttpHookOptions,
  context: AnyHookContext
): Promise<HookExecutionResult> {
  const startTime = Date.now();
  const { url, headers = {}, timeout = 10000, allowedEnvVars = [] } = options;

  // Interpolate env vars in headers
  const resolvedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolvedHeaders[key] = interpolateEnvVars(value, allowedEnvVars);
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...resolvedHeaders,
      },
      body: JSON.stringify(context),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      return {
        action: 'error',
        error: `HTTP hook returned ${response.status}: ${response.statusText}`,
        duration: Date.now() - startTime,
      };
    }

    // Parse JSON response
    const text = await response.text();
    try {
      const result = JSON.parse(text);
      return {
        action: result.action || 'allow',
        message: result.message,
        modifiedInput: result.modifiedInput,
        duration: Date.now() - startTime,
      };
    } catch {
      // Non-JSON response treated as message with allow
      return {
        action: 'allow',
        message: text.slice(0, 500),
        duration: Date.now() - startTime,
      };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`HTTP hook failed: ${url} — ${msg}`);
    return {
      action: 'error',
      error: `HTTP hook error: ${msg}`,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Interpolate $ENV_VAR patterns in a string.
 * Only variables in allowedEnvVars list are resolved (security).
 */
function interpolateEnvVars(value: string, allowedEnvVars: string[]): string {
  return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, varName) => {
    if (allowedEnvVars.includes(varName)) {
      return process.env[varName] || match;
    }
    return match; // Keep unresolved if not allowed
  });
}
