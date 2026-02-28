// ============================================================================
// Cross Verify - 双模型交叉验证（Kimi K2.5 × Codex）
// ============================================================================
//
// 对复杂代码任务，用 Codex MCP Server 独立生成方案，
// 与 Kimi 的方案做 token-level Jaccard 对比。
// agreement >= SIMILARITY_THRESHOLD → 直接用 Kimi（本地快）
// disagreement → 返回 null，由调用方决定（reviewer 仲裁等）
//
// 设计原则：
// - 纯增强，不改变现有路由逻辑
// - Codex 调用失败 → 静默降级（返回 null）
// - 不引入额外依赖
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import { CROSS_VERIFY } from '../../../shared/constants';

const logger = createLogger('CrossVerify');

// ============================================================================
// Types
// ============================================================================

export interface CrossVerifyResult {
  kimiResult: string;
  codexResult: string;
  agreement: boolean;
  similarityScore: number;
  chosen: 'kimi' | 'codex' | 'merged';
  reason: string;
}

// ============================================================================
// Codex MCP Availability
// ============================================================================

/**
 * 检查 Codex MCP Server 是否可用
 * 懒加载 getMCPClient 避免循环依赖
 */
export function isCodexAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getMCPClient } = require('../../mcp/mcpClient');
    const client = getMCPClient();
    // 使用 isConnected 而非 getTools()，避免跳过 lazy-load 的服务器
    // callTool() 内部会自动触发懒连接
    return client.isConnected('codex');
  } catch {
    return false;
  }
}

// ============================================================================
// Core: Cross Verify
// ============================================================================

/**
 * 用 Codex 对 Kimi 结果做交叉验证
 *
 * @returns CrossVerifyResult 或 null（Codex 不可用 / 调用失败 / disagreement）
 */
export async function crossVerifyWithCodex(
  task: string,
  kimiResult: string,
  context: { cwd: string },
): Promise<CrossVerifyResult | null> {
  // 1. 检查 Codex MCP 是否可用
  if (!isCodexAvailable()) {
    logger.debug('Codex MCP not available, skipping cross-verify');
    return null;
  }

  // 2. 调用 Codex
  let codexResult: string;
  try {
    codexResult = await callCodex(task, context.cwd);
  } catch (err) {
    logger.warn('Codex call failed, silently degrading', { error: String(err) });
    return null;
  }

  if (!codexResult) {
    logger.debug('Codex returned empty result');
    return null;
  }

  // 3. 对比
  const kimiBlocks = extractCodeBlocks(kimiResult);
  const codexBlocks = extractCodeBlocks(codexResult);

  // 优先比较代码块；若无代码块则比较全文
  const kimiText = kimiBlocks.length > 0 ? kimiBlocks.join('\n') : kimiResult;
  const codexText = codexBlocks.length > 0 ? codexBlocks.join('\n') : codexResult;

  const similarityScore = calculateSimilarity(kimiText, codexText);
  const agreement = similarityScore >= CROSS_VERIFY.SIMILARITY_THRESHOLD;

  // 4. 选择策略
  let chosen: 'kimi' | 'codex' | 'merged' = 'kimi';
  let reason: string;

  if (agreement) {
    chosen = 'kimi';
    reason = `Agreement (similarity=${similarityScore.toFixed(2)}), using Kimi result (local, faster)`;
  } else {
    // Disagreement — 返回结果但标记不一致，由调用方决策
    chosen = 'kimi';
    reason = `Disagreement (similarity=${similarityScore.toFixed(2)}), needs reviewer judgment`;
  }

  logger.info('Cross-verify completed', {
    similarityScore: similarityScore.toFixed(2),
    agreement,
    chosen,
    kimiCodeBlocks: kimiBlocks.length,
    codexCodeBlocks: codexBlocks.length,
  });

  return {
    kimiResult,
    codexResult,
    agreement,
    similarityScore,
    chosen,
    reason,
  };
}

// ============================================================================
// Codex MCP Call
// ============================================================================

async function callCodex(task: string, cwd: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getMCPClient } = require('../../mcp/mcpClient');
  const client = getMCPClient();

  const toolCallId = `cross-verify-${Date.now()}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: Awaited<ReturnType<typeof client.callTool>>;
  try {
    result = await Promise.race([
      client.callTool(toolCallId, 'codex', 'codex', {
        prompt: task,
        sandbox: 'read-only',
        cwd,
        'approval-policy': 'never',
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Codex call timed out')), CROSS_VERIFY.TIMEOUT);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!result.success) {
    throw new Error(result.error || 'Codex call returned failure');
  }

  return result.output || '';
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * 从 markdown 文本中提取代码块内容
 */
export function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const regex = /```[\w]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const content = match[1].trim();
    if (content.length > 0) {
      blocks.push(content);
    }
  }
  return blocks;
}

/**
 * 基于 token-level Jaccard 相似度计算
 * tokens = 按空白 + 标点分词
 */
export function calculateSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersection++;
    }
  }

  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 从代码文本中提取标识符（函数名、变量名、API 调用）
 */
export function extractIdentifiers(code: string): Set<string> {
  const identifiers = new Set<string>();
  // 匹配 JS/TS 标识符模式：字母/下划线开头，后跟字母/数字/下划线
  const regex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(code)) !== null) {
    // 跳过常见关键字
    if (!JS_KEYWORDS.has(match[1])) {
      identifiers.add(match[1]);
    }
  }
  return identifiers;
}

// ============================================================================
// Internal
// ============================================================================

function tokenize(text: string): Set<string> {
  // 按空白和常见标点分词，转小写，去空串
  const tokens = text
    .toLowerCase()
    .split(/[\s,;:{}()\[\]<>=!&|+\-*/%.'"\\`~@#^?]+/)
    .filter(t => t.length > 0);
  return new Set(tokens);
}

const JS_KEYWORDS = new Set([
  'abstract', 'arguments', 'await', 'boolean', 'break', 'byte', 'case', 'catch',
  'char', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'double', 'else', 'enum', 'eval', 'export', 'extends', 'false', 'final',
  'finally', 'float', 'for', 'function', 'goto', 'if', 'implements', 'import',
  'in', 'instanceof', 'int', 'interface', 'let', 'long', 'native', 'new',
  'null', 'of', 'package', 'private', 'protected', 'public', 'return', 'short',
  'static', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
  'transient', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'volatile',
  'while', 'with', 'yield', 'async', 'from', 'as', 'type', 'string', 'number',
]);
