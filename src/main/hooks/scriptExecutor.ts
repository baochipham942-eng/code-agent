// ============================================================================
// Script Executor - Execute external hook scripts
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import type { HookExecutionResult, AnyHookContext, HookActionResult } from '../protocol/events';
import { createHookEnvVars } from '../protocol/events';
import { createLogger } from '../services/infra/logger';
import { HOOK_TIMEOUTS } from '../../shared/constants';

const execAsync = promisify(exec);
const logger = createLogger('ScriptExecutor');

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const DEFAULT_TIMEOUT = HOOK_TIMEOUTS.SCRIPT_DEFAULT;
const MAX_OUTPUT_LENGTH = 100000; // 100KB; SessionStart memory injection 等场景需要 >10KB

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Script Executor
// ----------------------------------------------------------------------------

export interface ScriptExecutorOptions {
  /** Command to execute */
  command: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Working directory */
  workingDirectory?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
}

/**
 * Execute a hook script and parse its result
 *
 * Script output format:
 * - Exit code 0: allow (continue normally)
 * - Exit code 1: block (stop the action)
 * - Exit code 2: continue (proceed but with modifications)
 * - Other exit codes: error
 *
 * stdout can contain:
 * - JSON: { "action": "allow|block|continue", "message": "..." }
 * - Plain text: treated as a message, action defaults to "allow"
 */
export async function executeScript(
  options: ScriptExecutorOptions,
  context: AnyHookContext
): Promise<HookExecutionResult> {
  const startTime = Date.now();
  const timeout = options.timeout || DEFAULT_TIMEOUT;

  // Build environment variables
  const hookEnv = createHookEnvVars(context);
  const env = {
    ...process.env,
    ...hookEnv,
    ...options.env,
  };

  try {
    logger.debug('Executing hook script', {
      command: options.command,
      timeout,
      event: context.event,
    });

    const { stdout, stderr } = await execAsync(options.command, {
      timeout,
      cwd: options.workingDirectory || context.workingDirectory,
      env,
      maxBuffer: MAX_OUTPUT_LENGTH,
    });

    const duration = Date.now() - startTime;

    // Log stderr as warning if present
    if (stderr?.trim()) {
      logger.warn('Hook script stderr', { stderr: stderr.trim() });
    }

    // Parse output
    return parseScriptOutput(stdout, duration);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const duration = Date.now() - startTime;

    // Check for timeout
    const errorRecord = isRecord(error) ? error : {};

    if (errorRecord.killed === true && errorRecord.signal === 'SIGTERM') {
      logger.warn('Hook script timed out', {
        command: options.command,
        timeout,
      });
      return {
        action: 'error',
        error: `Hook script timed out after ${timeout}ms`,
        duration,
      };
    }

    // Check exit code for intentional block
    if (errorRecord.code === 1) {
      return {
        action: 'block',
        message: readString(errorRecord, 'stdout')?.trim() || 'Blocked by hook script',
        duration,
      };
    }

    if (errorRecord.code === 2) {
      const stdout = readString(errorRecord, 'stdout');
      return {
        action: 'continue',
        message: stdout?.trim(),
        modifiedInput: parseModifiedInput(stdout),
        duration,
      };
    }

    // Other errors
    logger.error('Hook script execution failed', {
      command: options.command,
      error: errMsg,
      exitCode: readNumber(errorRecord, 'code'),
    });

    return {
      action: 'error',
      error: errMsg || 'Hook script execution failed',
      duration,
    };
  }
}

/**
 * Parse script output to determine action and message
 */
function parseScriptOutput(stdout: string, duration: number): HookExecutionResult {
  const output = stdout.trim();

  if (!output) {
    return { action: 'allow', duration };
  }

  // Try to parse as JSON
  if (output.startsWith('{')) {
    const json = parseJsonRecord(output);
    if (json) {
      const action = validateAction(json.action);
      return {
        action,
        message: readString(json, 'message'),
        modifiedInput: readString(json, 'modifiedInput'),
        duration,
      };
    }
  }

  // Plain text output - treat as message, action is allow
  return {
    action: 'allow',
    message: output.length > MAX_OUTPUT_LENGTH
      ? output.substring(0, MAX_OUTPUT_LENGTH) + '...'
      : output,
    duration,
  };
}

/**
 * Validate and normalize action string
 */
function validateAction(action: unknown): HookActionResult {
  if (action === 'allow' || action === 'block' || action === 'continue' || action === 'error') {
    return action;
  }
  return 'allow';
}

/**
 * Try to extract modified input from script output
 */
function parseModifiedInput(output: string | undefined): string | undefined {
  if (!output) return undefined;

  const json = parseJsonRecord(output.trim());
  return json ? readString(json, 'modifiedInput') : undefined;
}

/**
 * Create a timeout-protected script execution
 */
export function createScriptExecutor(defaultOptions: Partial<ScriptExecutorOptions> = {}) {
  return async (
    command: string,
    context: AnyHookContext,
    options: Partial<ScriptExecutorOptions> = {}
  ): Promise<HookExecutionResult> => {
    return executeScript(
      {
        command,
        ...defaultOptions,
        ...options,
      },
      context
    );
  };
}
