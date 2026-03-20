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

export interface PythonResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
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
  const resourcePath = path.join((process as any).resourcesPath || '', 'scripts/', scriptName);
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

    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data) => {
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
        const result = JSON.parse(stdout.trim());
        resolve(result);
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
