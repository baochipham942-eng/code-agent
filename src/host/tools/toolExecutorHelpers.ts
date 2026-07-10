import { getLogMasker, maskSensitiveData } from '../security';
import { isSensitiveLogKey, redactSecrets } from '../security/secretRedaction';
import { commandMatchesScopedPrefix } from './neoTagToolGuard';
import { isBashToolName, normalizeToolName, sameToolName } from './toolNames';

export function sanitizeToolParams(params: Record<string, unknown>): Record<string, unknown> {
  const redacted = '***REDACTED***';
  const sensitiveContainers = new Set(['header', 'headers', 'env', 'environment']);
  const seen = new WeakSet<object>();

  const sanitizeValue = (value: unknown, key?: string): unknown => {
    const normalizedKey = key?.toLowerCase().replace(/[-_\s]/g, '');
    if (key && (sensitiveContainers.has(normalizedKey || '') || isSensitiveLogKey(key))) {
      return redacted;
    }
    if (typeof value === 'string') {
      const masked = normalizedKey === 'command'
        ? getLogMasker().maskCommand(value)
        : maskSensitiveData(value);
      return redactSecrets(masked);
    }
    if (value === null || value === undefined || typeof value !== 'object') {
      return value;
    }
    if (value instanceof Date) return value.toISOString();
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) {
      const sanitized = value.map((item) => sanitizeValue(item));
      seen.delete(value);
      return sanitized;
    }
    const sanitized = Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([childKey, childValue]) => [childKey, sanitizeValue(childValue, childKey)]),
    );
    seen.delete(value);
    return sanitized;
  };

  return sanitizeValue(params) as Record<string, unknown>;
}

export function truncateToolOutput(output: string, maxLength = 1000): string {
  if (output.length > maxLength) {
    return `${output.substring(0, maxLength)}...[truncated]`;
  }
  return output;
}

export function isDangerousCommand(command: string): boolean {
  const dangerousPatterns = [
    /rm\s+(-r|-rf|-f)?\s*[\/~]/,
    /rm\s+-rf?\s+\*/,
    />\s*\/dev\/sd/,
    /mkfs/,
    /dd\s+if=/,
    /:\(\)\{.*\}/,
    /git\s+push\s+.*--force/,
    /git\s+reset\s+--hard/,
    /chmod\s+-R\s+777/,
    /sudo\s+rm/,
  ];

  return dangerousPatterns.some((pattern) => pattern.test(command));
}

export function toolMatchesPatternSet(
  toolName: string,
  params: Record<string, unknown>,
  patterns: Set<string>,
): boolean {
  if (patterns.size === 0) return false;

  const normalizedToolName = normalizeToolName(toolName);
  for (const candidate of patterns) {
    if (sameToolName(candidate, normalizedToolName)) return true;
  }

  for (const pattern of patterns) {
    const match = pattern.match(/^([A-Za-z][A-Za-z0-9_.:-]*)\(([A-Za-z0-9._\/@+-]+):\*\)$/);
    if (!match) continue;

    const [, patternTool, prefix] = match;
    if (!sameToolName(patternTool, normalizedToolName)) continue;
    if (isBashToolName(normalizedToolName)) {
      const command = (params.command as string) || '';
      if (commandMatchesScopedPrefix(command, prefix)) return true;
    }
  }

  return false;
}
