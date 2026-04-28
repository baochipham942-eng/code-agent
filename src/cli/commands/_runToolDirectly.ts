// ============================================================================
// runToolDirectly - 共享的工具直接执行核心，不经过 agent loop
// 由 exec-tool 和 debug tool dry-run 共用
// ============================================================================

import fs from 'fs';
import path from 'path';
import { cleanup, getToolExecutor, initializeCLIServices } from '../bootstrap';
import { jsonOutput, terminalOutput } from '../output';
import type { CLIRunResult } from '../types';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8').trim();
}

function parseParams(raw: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${source} 不是有效的 JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} 必须是 JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function resolveParams(paramsStr?: string, paramsFile?: string, stdinContent?: string): Record<string, unknown> {
  if (paramsFile) {
    const resolved = path.resolve(paramsFile);
    if (!fs.existsSync(resolved)) throw new Error(`参数文件不存在: ${resolved}`);
    return parseParams(fs.readFileSync(resolved, 'utf-8'), `参数文件 ${resolved}`);
  }
  if (paramsStr) return parseParams(paramsStr, '--params');
  if (stdinContent) return parseParams(stdinContent, 'stdin');
  return {};
}

export interface RunToolOptions {
  params?: string;
  paramsFile?: string;
  session?: string;
}

/**
 * 直接执行工具，不经过模型回合。被 exec-tool 和 debug tool dry-run 共用。
 * 行为：会调用 process.exit。
 */
export async function runToolDirectly(
  tool: string,
  options: RunToolOptions,
  globalOpts: { project?: string; json?: boolean; outputFormat?: string } = {},
): Promise<void> {
  const isJson = !!globalOpts.json || globalOpts.outputFormat === 'json' || globalOpts.outputFormat === 'stream-json';

  try {
    const stdinContent = await readStdin();
    const params = resolveParams(options.params, options.paramsFile, stdinContent);

    await initializeCLIServices();
    const executor = getToolExecutor();
    if (!executor) throw new Error('ToolExecutor 不可用');

    const workingDirectory = globalOpts.project ? path.resolve(globalOpts.project) : process.cwd();
    executor.setWorkingDirectory(workingDirectory);

    const sessionId = options.session || `cli-tool-${Date.now()}`;
    const startMs = Date.now();
    const result = await executor.execute(tool, params, { sessionId });
    const durationMs = Date.now() - startMs;

    if (isJson) {
      jsonOutput.result({
        success: result.success,
        output: result.output,
        error: result.error,
        metadata: { ...(result.metadata ?? {}), tool, params, sessionId, durationMs },
        result: result.result,
      } as CLIRunResult);
    } else if (result.success) {
      terminalOutput.info(`工具: ${tool}  (${durationMs}ms)`);
      terminalOutput.info(`工作目录: ${workingDirectory}`);
      if (result.output) {
        console.log(result.output);
      } else if (result.result !== undefined) {
        console.log(JSON.stringify(result.result, null, 2));
      } else {
        terminalOutput.success('工具执行成功');
      }
    } else {
      terminalOutput.error(result.error || `工具 ${tool} 执行失败`);
    }

    await cleanup();
    process.exit(result.success ? 0 : 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isJson) jsonOutput.error(message);
    else terminalOutput.error(message);
    await cleanup();
    process.exit(1);
  }
}
