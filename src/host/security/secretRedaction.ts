// ============================================================================
// Secret Redaction - small dependency-free helpers for logs and smoke output
// ============================================================================

import { redactCommandKeywordSecrets, redactCredentialText } from '../../shared/security/secretPatterns';
import type { ToolResult } from '../../shared/contract';

const SENSITIVE_KEY_PARTS = [
  'apikey',
  'api_key',
  'password',
  'passwd',
  'pwd',
  'token',
  'secret',
  'authorization',
  'credential',
  'private',
  'bearer',
  'cookie',
];

export function isSensitiveLogKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '');
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part.replace(/_/g, '')));
}

export function redactSecrets(value: string): string {
  return redactCredentialText(value, { redacted: '***REDACTED***' });
}

/** 命令行/审批预览专用：在 redactSecrets 之上再掩 password=… / --password … 形态。不要用于工具结果。 */
export function redactCommandSecrets(value: string): string {
  return redactCommandKeywordSecrets(redactSecrets(value), { redacted: '***REDACTED***' });
}

/**
 * 工具结果级脱敏（transcript / 会话落库 / 导出 / 事件流统一入口）。
 *
 * 背景：agent 用 Bash/jq 读 ~/.claude.json 之类的配置文件时，明文 API key 会原样
 * 进入 tool_result，随后扩散到会话 transcript、neo export 与日志。这里只改写
 * output / error 两个文本字段里的密钥形态子串，不动 metadata 结构，也不做整段
 * 替换——正常代码内容不受影响的概率由 secretPatterns 的键/形态约束保证。
 */
export function redactToolResultSecrets(result: ToolResult): ToolResult {
  const output = typeof result.output === 'string' ? redactSecrets(result.output) : result.output;
  const error = typeof result.error === 'string' ? redactSecrets(result.error) : result.error;
  if (output === result.output && error === result.error) {
    return result;
  }
  return { ...result, output, error };
}

type Redactor = (value: string) => string;

function sanitizeWith(redact: Redactor, value: unknown, key?: string): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return key && isSensitiveLogKey(key) ? '***REDACTED***' : redact(value);
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message),
      stack: value.stack ? redact(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeWith(redact, item));
  }

  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    output[childKey] = isSensitiveLogKey(childKey)
      ? '***REDACTED***'
      : sanitizeWith(redact, childValue, childKey);
  }
  return output;
}

/** 通用脱敏（streamSnapshot 恢复快照仍用它：快照可能回灌/重放，保持旧行为）。 */
export function sanitizeLogValue(value: unknown, key?: string): unknown {
  return sanitizeWith(redactSecrets, value, key);
}

/** 纯日志输出专用（logger / logCollector）：额外掩 password=… / --password … 形态。不要用于模型可见内容。 */
export function sanitizeLogOutput(value: unknown, key?: string): unknown {
  return sanitizeWith(redactCommandSecrets, value, key);
}
