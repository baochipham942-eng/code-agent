export type SecretPatternId =
  | 'url-basic-auth'
  | 'cookie-header'
  | 'session-cookie-assignment'
  | 'openai-key'
  | 'google-api-key'
  | 'bearer-token'
  | 'github-ghp-token'
  | 'github-gho-token'
  | 'github-fine-grained-pat'
  | 'slack-xox-token'
  | 'slack-xapp-token'
  | 'aws-access-key-id'
  | 'url-query-token'
  | 'jwt-token'
  | 'pem-private-key';

export type SecretPatternType =
  | 'basic_auth'
  | 'cookie'
  | 'openai_key'
  | 'gcp_key'
  | 'bearer_token'
  | 'github_pat'
  | 'github_token'
  | 'slack_token'
  | 'aws_access_key'
  | 'url_query_token'
  | 'jwt_token'
  | 'private_key';

export interface SecretPatternEntry {
  id: SecretPatternId;
  type: SecretPatternType;
  pattern: RegExp;
  confidence: 'high' | 'medium' | 'low';
  maskStyle: 'full' | 'prefix' | 'private_key';
  validate?: (input: string, match: RegExpExecArray) => boolean;
  redact?: (match: RegExpExecArray, redacted: string) => string;
}

export interface RedactCredentialTextOptions {
  redacted?: string;
}

const DEFAULT_REDACTED = '[REDACTED]';

const normalizeBase64UrlSegment = (segment: string): string | null => {
  if (!segment || segment.length % 4 === 1) return null;
  return `${segment}${'='.repeat((4 - (segment.length % 4)) % 4)}`
    .replace(/-/g, '+')
    .replace(/_/g, '/');
};

const decodeBase64UrlSegment = (segment: string): string | null => {
  const normalized = normalizeBase64UrlSegment(segment);
  if (!normalized) return null;
  try {
    const decoded = globalThis.atob(normalized);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
};

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isJwtToken(input: string, match: RegExpExecArray): boolean {
  const token = match[0];
  const before = input.slice(Math.max(0, match.index - 64), match.index).toLowerCase();
  const lastWhitespace = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n'), before.lastIndexOf('\t'));
  const prefix = before.slice(lastWhitespace + 1);
  if (prefix.includes('data:') && prefix.endsWith('base64,')) {
    return false;
  }

  const [headerSegment, payloadSegment, signatureSegment] = token.split('.');
  const headerBytes = decodeBase64UrlSegment(headerSegment);
  const payloadBytes = decodeBase64UrlSegment(payloadSegment);
  const signatureBytes = decodeBase64UrlSegment(signatureSegment);
  if (!headerBytes || !payloadBytes || !signatureBytes) return false;

  try {
    const header = JSON.parse(headerBytes) as unknown;
    return isJsonRecord(header) && ('alg' in header || 'typ' in header);
  } catch {
    return false;
  }
}

const replaceWith = (redacted: string) => redacted;

export const secretPatternRegistry: SecretPatternEntry[] = [
  {
    id: 'url-basic-auth',
    type: 'basic_auth',
    pattern: /\b(https?:\/\/)[^:@/\s]+:[^@/\s]+@/gi,
    confidence: 'high',
    maskStyle: 'full',
    redact: (match, redacted) => `${match[1]}${redacted}@`,
  },
  {
    id: 'cookie-header',
    type: 'cookie',
    pattern: /\b(Set-Cookie|Cookie)(\s*:\s*)[^'"\r\n]+/gi,
    confidence: 'high',
    maskStyle: 'full',
    redact: (match, redacted) => `${match[1]}${match[2]}${redacted}`,
  },
  {
    id: 'session-cookie-assignment',
    type: 'cookie',
    pattern: /\b((?:session[-_\s]?cookie|cookie)\s*=\s*)[^\s'";,]+/gi,
    confidence: 'high',
    maskStyle: 'full',
    redact: (match, redacted) => `${match[1]}${redacted}`,
  },
  {
    id: 'openai-key',
    type: 'openai_key',
    pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_*.-]{7,}/g,
    confidence: 'high',
    maskStyle: 'prefix',
    redact: (_match, redacted) => `sk-${redacted}`,
  },
  {
    id: 'google-api-key',
    type: 'gcp_key',
    pattern: /\bAIza[0-9A-Za-z_-]{20,}/g,
    confidence: 'high',
    maskStyle: 'prefix',
    redact: (_match, redacted) => `AIza${redacted}`,
  },
  {
    id: 'bearer-token',
    type: 'bearer_token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    confidence: 'medium',
    maskStyle: 'prefix',
    redact: (_match, redacted) => `Bearer ${redacted}`,
  },
  {
    id: 'github-ghp-token',
    type: 'github_pat',
    pattern: /\bghp_[A-Za-z0-9]{20,}\b/g,
    confidence: 'high',
    maskStyle: 'full',
  },
  {
    id: 'github-gho-token',
    type: 'github_token',
    pattern: /\bgho_[A-Za-z0-9]{20,}\b/g,
    confidence: 'high',
    maskStyle: 'full',
  },
  {
    id: 'github-fine-grained-pat',
    type: 'github_pat',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/g,
    confidence: 'high',
    maskStyle: 'full',
  },
  {
    id: 'slack-xox-token',
    type: 'slack_token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    confidence: 'high',
    maskStyle: 'full',
  },
  {
    id: 'slack-xapp-token',
    type: 'slack_token',
    pattern: /\bxapp-[A-Za-z0-9-]{10,}\b/g,
    confidence: 'high',
    maskStyle: 'full',
  },
  {
    id: 'aws-access-key-id',
    type: 'aws_access_key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    confidence: 'high',
    maskStyle: 'full',
  },
  {
    id: 'url-query-token',
    type: 'url_query_token',
    pattern: /([?&](?:access_token|auth_token|token|api_key|apikey|secret|password|credential)=)([^&#\s]+)/gi,
    confidence: 'high',
    maskStyle: 'full',
    redact: (match, redacted) => `${match[1]}${redacted}`,
  },
  {
    id: 'jwt-token',
    type: 'jwt_token',
    pattern: /(?<![\w-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![\w-])/g,
    confidence: 'high',
    maskStyle: 'full',
    validate: isJwtToken,
  },
  {
    id: 'pem-private-key',
    type: 'private_key',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g,
    confidence: 'high',
    maskStyle: 'private_key',
    redact: () => '[private key redacted]',
  },
];

export function redactCredentialText(input: string, options: RedactCredentialTextOptions = {}): string {
  const redacted = options.redacted ?? DEFAULT_REDACTED;
  let output = input;

  for (const entry of secretPatternRegistry) {
    entry.pattern.lastIndex = 0;
    output = output.replace(entry.pattern, (...args: unknown[]) => {
      const match = args[0] as string;
      const offset = args[args.length - 2] as number;
      const groups = args.slice(1, -2) as string[];
      const execMatch = [match, ...groups] as unknown as RegExpExecArray;
      execMatch.index = offset;
      execMatch.input = output;
      if (entry.validate && !entry.validate(output, execMatch)) {
        return match;
      }
      if (entry.redact) {
        return entry.redact(execMatch, redacted);
      }
      if (entry.maskStyle === 'private_key') {
        return '[private key redacted]';
      }
      return replaceWith(redacted);
    });
  }

  return output;
}
