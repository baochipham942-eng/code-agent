// ============================================================================
// Python Bridge - 共享 Python 脚本执行抽象
// ============================================================================
// 从 xlwingsExecute.ts 提取，供多个工具复用（Excel/PDF/DOCX 等）
// ============================================================================

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { app } from '../../platform';

const PYTHON_SCRIPT_TIMEOUT = 120_000; // 2 分钟默认超时

type ProcessWithResourcesPath = NodeJS.Process & {
  resourcesPath?: string;
};

export interface PythonResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePythonResult(raw: string): PythonResult | null {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || typeof parsed.success !== 'boolean') {
    return null;
  }

  const result: PythonResult = { success: parsed.success };
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'success') continue;
    result[key] = value;
  }
  return result;
}

/**
 * 解析 Python 脚本路径（3 级降级）
 */
export function resolveScriptPath(scriptName: string): string {
  // 1. 开发环境
  const devPath = path.join(__dirname, '../../../../scripts/', scriptName);
  if (fs.existsSync(devPath)) return devPath;

  // 2. 打包环境
  const prodPath = path.join(app.getAppPath(), 'scripts/', scriptName);
  if (fs.existsSync(prodPath)) return prodPath;

  // 3. 资源目录
  const resourcePath = path.join((process as ProcessWithResourcesPath).resourcesPath || '', 'scripts/', scriptName);
  if (fs.existsSync(resourcePath)) return resourcePath;

  throw new Error(`找不到 Python 脚本: ${scriptName}`);
}

/**
 * 执行 Python 脚本并返回 JSON 结果
 */
export async function executePythonScript(
  scriptName: string,
  args: string[],
  timeout: number = PYTHON_SCRIPT_TIMEOUT
): Promise<PythonResult> {
  return new Promise((resolve) => {
    const scriptPath = resolveScriptPath(scriptName);
    const python = spawn('python3', [scriptPath, ...args]);

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      python.kill('SIGTERM');
      resolve({
        success: false,
        error: `Python 脚本超时 (${timeout / 1000}s): ${scriptName}`,
      });
    }, timeout);

    python.stdout.on('data', (data: Buffer | string) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data: Buffer | string) => {
      stderr += data.toString();
    });

    python.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;

      if (code !== 0) {
        resolve({
          success: false,
          error: stderr || `Python 进程退出码: ${code}`,
        });
        return;
      }

      try {
        const result = parsePythonResult(stdout.trim());
        resolve(result ?? {
          success: false,
          error: `JSON 结果缺少 success 字段: ${stdout}`,
        });
      } catch {
        resolve({
          success: false,
          error: `JSON 解析失败: ${stdout}`,
        });
      }
    });

    python.on('error', (err) => {
      clearTimeout(timer);
      if (timedOut) return;
      resolve({
        success: false,
        error: `Python 执行失败: ${err.message}`,
      });
    });
  });
}
