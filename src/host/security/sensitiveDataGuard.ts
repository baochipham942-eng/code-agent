// ============================================================================
// Sensitive Data Guard
// ============================================================================
//
// Shared guard for local derived data surfaces: prompt context, memory,
// activity context, knowledge captures, telemetry, transcripts, and exports.
// Raw session messages stay full fidelity; sinks and derived copies pass here.
// ============================================================================

import { getLogMasker } from './logMasker';
import {
  detectPiiEntities,
  redactPiiEntities,
  shouldUsePiiEntityDetection,
} from './piiEntityDetector';

export type SensitiveDataSurface =
  | 'prompt'
  | 'memory'
  | 'activity'
  | 'knowledge'
  | 'transcript'
  | 'export'
  | 'telemetry';

export type SensitiveDataMode =
  | 'local-persist'
  | 'model-context'
  | 'share'
  | 'diagnostic';

export interface SensitiveDataGuardOptions {
  surface: SensitiveDataSurface;
  mode: SensitiveDataMode;
  maxLength?: number;
  preserveLines?: boolean;
}

const DEFAULT_MAX_LENGTH = 50_000;
const REDACTED_VALUE = '***REDACTED***';
const MAX_OBJECT_DEPTH = 8;
const MAX_ARRAY_ITEMS = 200;

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|refresh[_-]?token|authorization|auth|bearer|cookie|credential|private[_-]?key|session[_-]?id)/i;

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/gi,
  /disregard\s+(all\s+)?(previous|prior|above)\s+instructions/gi,
  /forget\s+(all\s+)?(previous|prior|above)\s+instructions/gi,
  /override\s+(all\s+)?(previous|prior|above)\s+instructions/gi,
];

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;
const MASKED_EMAIL_PATTERN = /(?:\b[a-zA-Z0-9._%+-]+)?\*{3}@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
const WINDOWS_HOME_PATH_PATTERN = /\b[A-Z]:\\Users\\[a-zA-Z0-9_.-]+/gi;
const SCREENSHOT_FILE_PATTERN = /\b(?:screenshot|screen-capture|screen_capture)[\w.-]*\.(?:png|jpe?g|webp)\b/gi;
const AUDIO_FILE_PATTERN = /\b[\w.-]*\.(?:wav|mp3|m4a|aac|flac)\b/gi;
const SCREENSHOT_PATH_PATTERN =
  /(?:~|\/Users\/[a-zA-Z0-9_.-]+|\/home\/[a-zA-Z0-9_.-]+|[A-Z]:\\Users\\[a-zA-Z0-9_.-]+)[^\s<>"'`]*?(?:(?:screenshot|screen-capture|screen_capture)[^\s<>"'`]*?\.(?:png|jpe?g|webp)|\[screenshot hidden\])/gi;
const AUDIO_PATH_PATTERN =
  /(?:~|\/Users\/[a-zA-Z0-9_.-]+|\/home\/[a-zA-Z0-9_.-]+|[A-Z]:\\Users\\[a-zA-Z0-9_.-]+)[^\s<>"'`]*?\.(?:wav|mp3|m4a|aac|flac)/gi;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CREDIT_CARD_CANDIDATE_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

const CUSTOM_PATTERNS = [
  {
    pattern: /((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|token|cookie)\s*["']?\s*[:=]\s*["']?)([^"'\s,;}{]+)/gi,
    replacement: `$1${REDACTED_VALUE}`,
  },
  {
    pattern: /(bearer\s+)[a-zA-Z0-9._~+/=-]{12,}/gi,
    replacement: `$1${REDACTED_VALUE}`,
  },
  {
    pattern: WINDOWS_HOME_PATH_PATTERN,
    replacement: '~',
  },
  {
    pattern: SCREENSHOT_FILE_PATTERN,
    replacement: '[screenshot hidden]',
  },
];

const SURFACES_WITH_INJECTION_NEUTRALIZATION = new Set<SensitiveDataSurface>([
  'prompt',
  'memory',
  'activity',
  'knowledge',
  'transcript',
  'export',
]);

export function guardSensitiveText(value: unknown, options: SensitiveDataGuardOptions): string {
  if (value === null || value === undefined) return '';

  let guarded = String(value);
  guarded = sanitizeUrlTokens(guarded);

  if (SURFACES_WITH_INJECTION_NEUTRALIZATION.has(options.surface) || options.mode === 'model-context') {
    guarded = neutralizePromptInjectionText(guarded);
  }

  guarded = getLogMasker().mask(guarded, {
    maskSecrets: true,
    maskPaths: true,
    maskEmails: true,
    maskIPs: true,
    customPatterns: CUSTOM_PATTERNS,
    maxLength: options.maxLength ?? DEFAULT_MAX_LENGTH,
    preserveLines: options.preserveLines ?? true,
  }).masked;
  guarded = redactDeterministicPii(guarded);
  guarded = guarded.replace(MASKED_EMAIL_PATTERN, '[email hidden]');

  if (options.surface === 'activity') {
    guarded = guarded
      .replace(SCREENSHOT_PATH_PATTERN, '[screenshot hidden]')
      .replace(AUDIO_PATH_PATTERN, '[audio hidden]')
      .replace(AUDIO_FILE_PATTERN, '[audio hidden]');
  }

  return guarded;
}

function redactDeterministicPii(value: string): string {
  return value
    .replace(SSN_PATTERN, '[ssn hidden]')
    .replace(CREDIT_CARD_CANDIDATE_PATTERN, (match) =>
      isLikelyCreditCardNumber(match) ? '[credit card hidden]' : match,
    );
}

function isLikelyCreditCardNumber(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  if (/^(\d)\1+$/.test(digits)) return false;

  let sum = 0;
  let shouldDouble = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (!Number.isFinite(digit)) return false;
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

export async function guardSensitiveTextAsync(
  value: unknown,
  options: SensitiveDataGuardOptions,
): Promise<string> {
  const guarded = guardSensitiveText(value, options);
  if (!shouldUsePiiEntityDetection(options)) {
    return guarded;
  }

  return redactNaturalLanguageSegments(guarded, async (segment) => {
    const entities = await detectPiiEntities(segment, options);
    return redactPiiEntities(segment, entities);
  });
}

export function guardSensitiveValue<T = unknown>(value: T, options: SensitiveDataGuardOptions): T {
  return guardValue(value, options, 0) as T;
}

export function guardSensitiveJsonText(
  value: string | null | undefined,
  options: SensitiveDataGuardOptions,
): string | null {
  if (typeof value !== 'string') return null;

  try {
    const parsed = JSON.parse(value) as unknown;
    return JSON.stringify(guardSensitiveValue(parsed, options));
  } catch {
    return guardSensitiveText(value, options);
  }
}

export function neutralizePromptInjectionText(value: string): string {
  let guarded = value.replace(/<\/?\s*(system|assistant|user|developer|tool)\b[^>]*>/gi, (match) =>
    match.replace(/</g, '[').replace(/>/g, ']'),
  );

  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    guarded = guarded.replace(pattern, '[neutralized instruction override]');
  }

  return guarded;
}

export function sanitizeUrlTokens(value: string): string {
  return value.replace(URL_PATTERN, (match) => {
    const trailing = match.match(/[.,;:!?]+$/)?.[0] ?? '';
    const rawUrl = trailing ? match.slice(0, -trailing.length) : match;

    try {
      const url = new URL(rawUrl);
      if (url.username || url.password) {
        url.username = '';
        url.password = '';
      }
      url.search = '';
      url.hash = '';
      return `${url.toString()}${trailing}`;
    } catch {
      return match;
    }
  });
}

function guardValue(
  value: unknown,
  options: SensitiveDataGuardOptions,
  depth: number,
  key?: string,
): unknown {
  if (value === null || value === undefined) return value;

  if (key && SENSITIVE_KEY_PATTERN.test(key)) {
    return REDACTED_VALUE;
  }

  if (typeof value === 'string') {
    return guardSensitiveText(value, options);
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (depth >= MAX_OBJECT_DEPTH) {
    return '[redacted nested value]';
  }

  if (Array.isArray(value)) {
    const sliced = value.slice(0, MAX_ARRAY_ITEMS).map((item, index) =>
      guardValue(item, options, depth + 1, String(index)),
    );
    if (value.length > MAX_ARRAY_ITEMS) {
      sliced.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
    }
    return sliced;
  }

  const guarded: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    guarded[entryKey] = guardValue(entryValue, options, depth + 1, entryKey);
  }
  return guarded;
}

async function redactNaturalLanguageSegments(
  text: string,
  redactSegment: (segment: string) => Promise<string>,
): Promise<string> {
  const parts: string[] = [];
  let cursor = 0;
  const fencedCodePattern = /```[\s\S]*?```/g;

  for (const match of text.matchAll(fencedCodePattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      parts.push(await redactSegment(text.slice(cursor, index)));
    }
    parts.push(match[0]);
    cursor = index + match[0].length;
  }

  if (cursor < text.length) {
    parts.push(await redactSegment(text.slice(cursor)));
  }

  return parts.join('');
}
