// ============================================================================
// Shared Provider Utilities
// ============================================================================

import axios, { type AxiosResponse } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createLogger } from '../../services/infra/logger';

export const logger = createLogger('ModelRouter');

// System proxy configuration - only use proxy if explicitly set via env var
const PROXY_URL = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
const USE_PROXY = !!PROXY_URL && process.env.NO_PROXY !== 'true' && process.env.DISABLE_PROXY !== 'true';
export const httpsAgent = USE_PROXY ? new HttpsProxyAgent(PROXY_URL) : undefined;

logger.info(' Proxy:', USE_PROXY ? PROXY_URL : 'disabled (no proxy env var set)');

/**
 * Helper function to wrap axios in a fetch-like interface for consistency
 */
export async function electronFetch(url: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown>; body?: ReadableStream<Uint8Array> }> {
  try {
    const response: AxiosResponse = await axios({
      url,
      method: options.method || 'GET',
      headers: options.headers,
      data: options.body ? JSON.parse(options.body) : undefined,
      timeout: 300000,
      httpsAgent,
      validateStatus: () => true,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
      json: async () => response.data,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Network request failed: ${message}`);
  }
}

/**
 * Normalize JSON Schema for better model compliance
 */
export function normalizeJsonSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const normalized: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
  const schemaObj = schema as Record<string, unknown>;

  if (schemaObj.type === 'object') {
    if (normalized.additionalProperties === undefined) {
      normalized.additionalProperties = false;
    }

    if (normalized.properties && typeof normalized.properties === 'object') {
      const normalizedProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(normalized.properties as Record<string, unknown>)) {
        normalizedProps[key] = normalizeJsonSchema(value);
      }
      normalized.properties = normalizedProps;
    }
  }

  if (schemaObj.type === 'array' && normalized.items) {
    normalized.items = normalizeJsonSchema(normalized.items);
  }

  return normalized;
}

/**
 * Safe JSON parse with repair strategies
 */
export function safeJsonParse(str: string): Record<string, unknown> {
  // Strategy 1: Direct parse
  try {
    const result = JSON.parse(str);
    logger.debug('[safeJsonParse] Direct parse succeeded');
    return result;
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : 'Unknown parse error';
    logger.debug(`[safeJsonParse] Direct parse failed: ${errorMessage}, trying repair strategies...`);
  }

  // Strategy 2: Repair common JSON issues
  const repaired = repairJsonForArguments(str);
  if (repaired) {
    logger.info('[safeJsonParse] Repaired JSON parse succeeded');
    return repaired;
  }

  // Strategy 3: Extract key-value pairs
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

/**
 * Repair common JSON issues for arguments parsing
 */
function repairJsonForArguments(str: string): Record<string, unknown> | null {
  if (!str || !str.trim()) return null;

  let repaired = str.trim();
  repaired = repaired.replace(/^[^{\[]*/, '');
  repaired = repaired.replace(/[^}\]]*$/, '');

  if (!repaired.startsWith('{') && !repaired.startsWith('[')) {
    return null;
  }

  let braceCount = 0;
  let bracketCount = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < repaired.length; i++) {
    const char = repaired[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') braceCount++;
      else if (char === '}') braceCount--;
      else if (char === '[') bracketCount++;
      else if (char === ']') bracketCount--;
    }
  }

  if (inString) {
    repaired += '"';
  }

  while (bracketCount > 0) {
    repaired += ']';
    bracketCount--;
  }

  while (braceCount > 0) {
    repaired += '}';
    braceCount--;
  }

  try {
    return JSON.parse(repaired);
  } catch {
    const lastComma = repaired.lastIndexOf(',');
    if (lastComma > 0) {
      const truncated = repaired.substring(0, lastComma) + '}';
      try {
        return JSON.parse(truncated);
      } catch {
        // Continue to other methods
      }
    }
    return null;
  }
}

/**
 * Extract key-value pairs from raw string
 */
function extractKeyValuePairs(str: string): Record<string, unknown> | null {
  if (!str || !str.trim()) return null;

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
