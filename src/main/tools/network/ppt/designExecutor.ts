// ============================================================================
// Design Mode — 代码提取 + 安全检查 + 执行
// ============================================================================

import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../../../services/infra/logger';
import { DESIGN_MODE } from './constants';

const logger = createLogger('DesignExecutor');
const execFileAsync = promisify(execFile);

/**
 * 从 LLM 响应中提取 slide 代码段
 *
 * 优先提取 ```typescript 代码块，降级到 ```ts 或裸代码
 */
export function extractSlideCode(llmResponse: string): string | null {
  // 1. 提取 ```typescript 或 ```ts 代码块
  const codeBlockMatch = llmResponse.match(/```(?:typescript|ts)\s*\n([\s\S]*?)\n```/);
  if (codeBlockMatch) {
    const code = codeBlockMatch[1].trim();
    if (code.includes('pptx.addSlide') || code.includes('addBg(')) {
      return code;
    }
  }

  // 2. 提取所有代码块并合并
  const allBlocks = [...llmResponse.matchAll(/```(?:typescript|ts)?\s*\n([\s\S]*?)\n```/g)];
  if (allBlocks.length > 0) {
    const merged = allBlocks.map(m => m[1].trim()).join('\n\n');
    if (merged.includes('pptx.addSlide') || merged.includes('addBg(')) {
      return merged;
    }
  }

  // 3. 裸代码：检查是否包含 slide 标记注释
  if (llmResponse.includes('// --- Slide') && llmResponse.includes('pptx.addSlide')) {
    // 提取从第一个 slide 注释到最后一个 } 的代码
    const startIdx = llmResponse.indexOf('// --- Slide');
    const lastBrace = llmResponse.lastIndexOf('}');
    if (startIdx >= 0 && lastBrace > startIdx) {
      return llmResponse.substring(startIdx, lastBrace + 1).trim();
    }
  }

  return null;
}

/**
 * 安全检查：禁止危险模块和操作
 */
export function sanitizeCode(code: string): { safe: boolean; reason?: string } {
  const forbidden = [
    { pattern: /require\s*\(\s*['"`](child_process|fs|net|http|https|os|path|crypto|dgram|cluster|worker_threads)['"`]\s*\)/, reason: 'Forbidden module import' },
    { pattern: /import\s+.*from\s+['"`](child_process|fs|net|http|https|os|path|crypto|dgram|cluster|worker_threads)['"`]/, reason: 'Forbidden module import' },
    { pattern: /process\.env\b/, reason: 'Environment variable access' },
    { pattern: /\beval\s*\(/, reason: 'eval() is forbidden' },
    { pattern: /\bnew\s+Function\s*\(/, reason: 'Function constructor is forbidden' },
    { pattern: /\bexecSync\b|\bexecFile\b|\bspawnSync\b|\bspawn\b|\bexec\b/, reason: 'Process execution is forbidden' },
    { pattern: /\bglobalThis\b|\bglobal\b\./, reason: 'Global object access' },
  ];

  for (const { pattern, reason } of forbidden) {
    if (pattern.test(code)) {
      return { safe: false, reason };
    }
  }

  return { safe: true };
}

/**
 * 执行设计脚本
 *
 * @param scriptPath - .ts 脚本路径
 * @param timeout - 执行超时（ms），默认 30000
 */
export async function executeDesignScript(
  scriptPath: string,
  timeout: number = DESIGN_MODE.SCRIPT_TIMEOUT,
): Promise<{ success: boolean; stdout: string; error?: string }> {
  if (!fs.existsSync(scriptPath)) {
    return { success: false, stdout: '', error: `Script not found: ${scriptPath}` };
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      'npx',
      ['tsx', scriptPath],
      {
        timeout,
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
        maxBuffer: DESIGN_MODE.MAX_BUFFER,
      },
    );

    if (stderr && !stderr.includes('ExperimentalWarning')) {
      logger.debug(`tsx stderr: ${stderr.substring(0, 200)}`);
    }

    return { success: true, stdout: stdout || '' };
  } catch (err: any) {
    const message = err.stderr || err.message || String(err);
    // 截取有用的错误信息
    const lines = message.split('\n').filter((l: string) =>
      l.includes('Error') || l.includes('error') || l.includes('TypeError') ||
      l.includes('SyntaxError') || l.includes('ReferenceError') ||
      l.includes('at ') || l.includes('Cannot find')
    ).slice(0, 8);

    const cleanError = lines.length > 0 ? lines.join('\n') : message.substring(0, 500);
    return { success: false, stdout: err.stdout || '', error: cleanError };
  }
}

/**
 * 验证生成的 PPTX 文件
 */
export function validateOutput(
  outputPath: string,
  minSize: number = 10 * 1024,      // 10KB
  maxSize: number = 50 * 1024 * 1024, // 50MB
): { valid: boolean; reason?: string; size?: number } {
  if (!fs.existsSync(outputPath)) {
    return { valid: false, reason: 'Output file not found' };
  }

  const stats = fs.statSync(outputPath);
  if (stats.size < minSize) {
    return { valid: false, reason: `File too small (${stats.size} bytes)`, size: stats.size };
  }
  if (stats.size > maxSize) {
    return { valid: false, reason: `File too large (${stats.size} bytes)`, size: stats.size };
  }

  return { valid: true, size: stats.size };
}
