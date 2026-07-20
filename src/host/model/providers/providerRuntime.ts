import { createLogger } from '../../services/infra/logger';

export const logger = createLogger('ModelRouter');

function closeOpenBrackets(str: string): string {
  let braceCount = 0;
  let bracketCount = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (char === '\\') { escapeNext = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (!inString) {
      if (char === '{') braceCount++;
      else if (char === '}') braceCount--;
      else if (char === '[') bracketCount++;
      else if (char === ']') bracketCount--;
    }
  }

  let result = str;
  if (inString) result += '"';
  while (bracketCount > 0) { result += ']'; bracketCount--; }
  while (braceCount > 0) { result += '}'; braceCount--; }
  return result;
}

function repairJsonForArguments(str: string): Record<string, unknown> | null {
  if (!str?.trim()) return null;

  let repaired = str.trim();
  repaired = repaired.replace(/^[^{[]*/, '');
  repaired = repaired.replace(/[^}\]]*$/, '');

  if (!repaired.startsWith('{') && !repaired.startsWith('[')) {
    return null;
  }

  repaired = closeOpenBrackets(repaired);

  try {
    return JSON.parse(repaired) as Record<string, unknown>;
  } catch {
    const lastComma = repaired.lastIndexOf(',');
    if (lastComma > 0) {
      try {
        return JSON.parse(repaired.substring(0, lastComma) + '}') as Record<string, unknown>;
      } catch {
        /* Continue */
      }
    }
    return null;
  }
}

function extractKeyValuePairs(str: string): Record<string, unknown> | null {
  if (!str?.trim()) return null;

  const result: Record<string, unknown> = {};

  const stringPattern = /"(\w+)":\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  const numberPattern = /"(\w+)":\s*(-?\d+\.?\d*)/g;
  const booleanPattern = /"(\w+)":\s*(true|false)/g;
  const nullPattern = /"(\w+)":\s*null/g;

  let match;
  while ((match = stringPattern.exec(str)) !== null) {
    result[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }

  while ((match = numberPattern.exec(str)) !== null) {
    if (!(match[1] in result)) {
      result[match[1]] = parseFloat(match[2]);
    }
  }

  while ((match = booleanPattern.exec(str)) !== null) {
    if (!(match[1] in result)) {
      result[match[1]] = match[2] === 'true';
    }
  }

  while ((match = nullPattern.exec(str)) !== null) {
    if (!(match[1] in result)) {
      result[match[1]] = null;
    }
  }

  const arrayPattern = /"(\w+)":\s*\[([^\]]*)\]/g;
  while ((match = arrayPattern.exec(str)) !== null) {
    if (!(match[1] in result)) {
      try {
        result[match[1]] = JSON.parse(`[${match[2]}]`);
      } catch {
        result[match[1]] = match[2].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
      }
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

export function safeJsonParse(str: string): Record<string, unknown> {
  try {
    const result = JSON.parse(str) as Record<string, unknown>;
    logger.debug('[safeJsonParse] Direct parse succeeded');
    return result;
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : 'Unknown parse error';
    logger.debug(`[safeJsonParse] Direct parse failed: ${errorMessage}, trying repair strategies...`);
  }

  const repaired = repairJsonForArguments(str);
  if (repaired) {
    logger.info('[safeJsonParse] Repaired JSON parse succeeded');
    return repaired;
  }

  const extracted = extractKeyValuePairs(str);
  if (extracted && Object.keys(extracted).length > 0) {
    logger.info('[safeJsonParse] Extracted key-value pairs:', Object.keys(extracted).join(', '));
    return extracted;
  }

  logger.warn('[safeJsonParse] All parse strategies failed');
  logger.warn(`[safeJsonParse] Raw arguments (first 500 chars): ${str.substring(0, 500)}`);
  return {
    __parseError: true,
    __errorMessage: 'All JSON parse strategies failed',
    __rawArguments: str.substring(0, 1000),
  };
}
