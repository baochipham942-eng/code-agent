// ============================================================================
// Code Execute - Programmatic Tool Calling (PTC)
// ============================================================================
// 在 child_process.fork() worker 中执行 JS 代码，通过 IPC 桥接调用真实工具。
// 中间结果留在 worker 内存，只有最终输出返回给模型上下文。
// ============================================================================

import { fork, type ChildProcess } from 'child_process';
import * as path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { ToolExecutor } from '../toolExecutor';
import { validateCodeSafety } from './codeValidator';
import { createLogger } from '../../services/infra/logger';
import { getAuditLogger } from '../../security';

const logger = createLogger('CodeExecute');

// ============================================================================
// Tool Whitelist Configuration
// ============================================================================

/** 默认允许的只读工具 */
const DEFAULT_ALLOWED = [
  'read_file', 'glob', 'grep', 'list_directory',
  'web_fetch', 'web_search', 'read_xlsx', 'read_pdf', 'read_docx',
];

/** 可由模型请求扩展的工具（需要用户已授权 code_execute） */
const EXTENDABLE = [
  'bash', 'write_file', 'edit_file', 'memory_store', 'memory_search',
];

/** 绝对禁止在 PTC 中调用的工具 */
const NEVER_ALLOWED = [
  'code_execute', 'tool_create', 'spawn_agent', 'AgentSpawn',
  'Task', 'SdkTask', 'WorkflowOrchestrate', 'workflow_orchestrate',
];

const ALL_VALID_TOOLS = [...DEFAULT_ALLOWED, ...EXTENDABLE];

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT = 60_000; // 60s
const MAX_TIMEOUT = 120_000; // 120s
const MAX_HEAP_MB = 256;

// ============================================================================
// Worker Path Resolution
// ============================================================================

function resolveWorkerPath(): string {
  // In bundled mode, __dirname points to dist/main/ or dist/cli/
  const candidates = [
    path.join(__dirname, 'worker-sandbox.cjs'),
    path.join(__dirname, '..', 'main', 'worker-sandbox.cjs'),
    // Source mode (dev)
    path.join(__dirname, '..', '..', '..', 'src', 'main', 'tools', 'evolution', 'worker-sandbox.cjs'),
  ];

  for (const p of candidates) {
    try {
      require.resolve(p);
      return p;
    } catch {
      // continue
    }
  }

  // Fallback: assume same directory
  return candidates[0];
}

// ============================================================================
// Tool Definition
// ============================================================================

export const codeExecuteTool: Tool = {
  name: 'code_execute',
  description: `Execute JavaScript code in a sandboxed worker process with tool calling capability.

Use this when a task requires 3+ similar tool calls (e.g., reading multiple files, batch searching).
The code runs in an isolated child process. Use \`callTool(name, args)\` to invoke tools.
Intermediate results stay in worker memory — only console.log output and the return value enter your context.

**Available by default**: ${DEFAULT_ALLOWED.join(', ')}
**Extendable (specify in allowed_tools)**: ${EXTENDABLE.join(', ')}

Example:
\`\`\`javascript
const files = await callTool('glob', { pattern: 'src/**/*.ts' });
let total = 0;
for (const f of files.output.split('\\n').filter(Boolean)) {
  const r = await callTool('read_file', { file_path: f });
  if (r.success) total += r.output.split('\\n').length;
}
return \`\${total} lines across \${files.output.split('\\n').filter(Boolean).length} files\`;
\`\`\`

callTool returns: { success: boolean, output?: string, error?: string }
Max 50 tool calls per execution. Timeout: 60s (configurable up to 120s).`,

  requiresPermission: true,
  permissionLevel: 'execute',

  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'JavaScript code to execute. Use callTool(name, args) for tool calls. Use return for final output.',
      },
      allowed_tools: {
        type: 'array',
        items: { type: 'string' },
        description: `Optional: additional tools to allow beyond defaults. Valid: ${EXTENDABLE.join(', ')}`,
      },
      timeout: {
        type: 'number',
        description: 'Execution timeout in ms (default 60000, max 120000)',
      },
    },
    required: ['code'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const code = params.code as string;
    const requestedTools = (params.allowed_tools as string[]) || [];
    const timeout = Math.min(
      Math.max((params.timeout as number) || DEFAULT_TIMEOUT, 1000),
      MAX_TIMEOUT
    );

    // ========================================================================
    // Step 1: Validate code safety
    // ========================================================================
    const validation = validateCodeSafety(code);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    // ========================================================================
    // Step 2: Build allowed tools list
    // ========================================================================
    const allowedTools = [...DEFAULT_ALLOWED];

    for (const t of requestedTools) {
      if (NEVER_ALLOWED.includes(t)) {
        return { success: false, error: `Tool "${t}" is never allowed in code_execute` };
      }
      if (!ALL_VALID_TOOLS.includes(t)) {
        return { success: false, error: `Tool "${t}" is not a valid tool for code_execute. Valid: ${ALL_VALID_TOOLS.join(', ')}` };
      }
      if (!allowedTools.includes(t)) {
        allowedTools.push(t);
      }
    }

    // Verify all requested tools exist in registry
    if (context.toolRegistry) {
      for (const t of allowedTools) {
        if (!context.toolRegistry.get(t)) {
          logger.warn('Tool not found in registry, removing from allowed list', { tool: t });
          allowedTools.splice(allowedTools.indexOf(t), 1);
        }
      }
    }

    // ========================================================================
    // Step 3: Create ToolExecutor for internal calls (full pipeline)
    // ========================================================================
    const startTime = Date.now();
    const auditLogger = getAuditLogger();

    // Build a ToolExecutor that goes through the full security pipeline
    // (bash validation, file checkpoint, audit) but skips permission prompts
    // for whitelisted tools (user already approved code_execute itself).
    let internalExecutor: ToolExecutor | null = null;
    if (context.toolRegistry) {
      internalExecutor = new ToolExecutor({
        toolRegistry: context.toolRegistry,
        requestPermission: context.requestPermission,
        workingDirectory: context.workingDirectory,
      });
    }
    const preApprovedToolSet = new Set(allowedTools);

    // ========================================================================
    // Step 4: Fork worker and execute
    // ========================================================================
    const workerPath = resolveWorkerPath();
    logger.info('Starting PTC worker', { workerPath, allowedTools, timeout });

    return new Promise<ToolExecutionResult>((resolve) => {
      let worker: ChildProcess | null = null;
      let settled = false;
      let internalCallCount = 0;

      const settle = (result: ToolExecutionResult) => {
        if (settled) return;
        settled = true;
        if (worker && worker.connected) {
          worker.kill('SIGTERM');
        }
        auditLogger.logToolUsage({
          sessionId: context.sessionId || 'unknown',
          toolName: 'code_execute',
          input: { codeLength: code.length, allowedTools },
          output: result.output?.substring(0, 200),
          duration: Date.now() - startTime,
          success: result.success,
          error: result.error,
        });
        resolve(result);
      };

      // Timeout handler
      const timer = setTimeout(() => {
        logger.warn('PTC worker timed out', { timeout });
        if (worker) worker.kill('SIGKILL');
        settle({
          success: false,
          error: `Execution timed out after ${timeout}ms`,
          metadata: { toolCallCount: internalCallCount },
        });
      }, timeout);

      try {
        worker = fork(workerPath, [], {
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          execArgv: [`--max-old-space-size=${MAX_HEAP_MB}`],
          env: {}, // Clean environment — no access to parent env
        });

        // Handle worker messages
        worker.on('message', async (msg: { type: string; id?: string; name?: string; args?: Record<string, unknown>; success?: boolean; output?: string }) => {
          if (msg.type === 'tool_call') {
            internalCallCount++;

            if (!internalExecutor) {
              worker?.send({ type: 'tool_result', id: msg.id, result: { success: false, error: 'Tool executor not available' } });
              return;
            }

            try {
              logger.debug('PTC internal tool call', { name: msg.name, callNum: internalCallCount });

              // Execute through full ToolExecutor pipeline:
              // ✅ Bash dangerous command detection
              // ✅ File checkpoint (rollback support)
              // ✅ Audit logging (full context)
              // ✅ Generation compatibility check
              // ✅ Cache check
              // Permission: pre-approved (user already approved code_execute)
              const result = await internalExecutor.execute(
                msg.name!,
                msg.args || {},
                {
                  generation: {
                    ...context.generation,
                    id: context.generation.id as import('@shared/types').GenerationId,
                    name: context.generation.id,
                    version: '1.0',
                    description: '',
                    tools: allowedTools,
                    systemPrompt: '',
                    promptMetadata: { lineCount: 0, toolCount: 0, ruleCount: 0 },
                  },
                  sessionId: context.sessionId,
                  preApprovedTools: preApprovedToolSet,
                  emitEvent: context.emitEvent || context.emit,
                  modelCallback: context.modelCallback,
                }
              );

              // Send result back to worker
              if (worker?.connected) {
                worker.send({
                  type: 'tool_result',
                  id: msg.id,
                  result: {
                    success: result.success,
                    output: result.output || '',
                    error: result.error,
                  },
                });
              }
            } catch (err) {
              if (worker?.connected) {
                worker.send({
                  type: 'tool_result',
                  id: msg.id,
                  result: { success: false, error: String(err) },
                });
              }
            }
          } else if (msg.type === 'done') {
            clearTimeout(timer);
            settle({
              success: msg.success ?? false,
              output: msg.output || '(no output)',
              metadata: { toolCallCount: internalCallCount },
            });
          }
        });

        // Handle worker errors
        worker.on('error', (err) => {
          clearTimeout(timer);
          logger.error('PTC worker error', { error: String(err) });
          settle({
            success: false,
            error: `Worker error: ${err.message}`,
            metadata: { toolCallCount: internalCallCount },
          });
        });

        // Handle unexpected worker exit
        worker.on('exit', (exitCode, signal) => {
          clearTimeout(timer);
          if (!settled) {
            settle({
              success: false,
              error: `Worker exited unexpectedly (code=${exitCode}, signal=${signal})`,
              metadata: { toolCallCount: internalCallCount },
            });
          }
        });

        // Send code to worker
        worker.send({
          type: 'execute',
          code,
          allowedTools,
        });
      } catch (err) {
        clearTimeout(timer);
        settle({
          success: false,
          error: `Failed to start worker: ${String(err)}`,
        });
      }
    });
  },
};
