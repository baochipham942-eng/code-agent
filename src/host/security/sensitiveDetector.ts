// ============================================================================
// Sensitive Information Detector - Detects secrets and sensitive data
// ============================================================================

import { createLogger } from '../services/infra/logger';

const logger = createLogger('SensitiveDetector');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Types of sensitive information
 */
export type SensitiveType =
  | 'api_key'
  | 'aws_access_key'
  | 'aws_secret_key'
  | 'github_token'
  | 'github_pat'
  | 'gitlab_token'
  | 'npm_token'
  | 'pypi_token'
  | 'docker_token'
  | 'slack_token'
  | 'slack_webhook'
  | 'discord_token'
  | 'discord_webhook'
  | 'stripe_key'
  | 'twilio_key'
  | 'sendgrid_key'
  | 'mailgun_key'
  | 'jwt_token'
  | 'bearer_token'
  | 'basic_auth'
  | 'private_key'
  | 'ssh_private_key'
  | 'password'
  | 'database_url'
  | 'connection_string'
  | 'openai_key'
  | 'anthropic_key'
  | 'azure_key'
  | 'gcp_key'
  | 'firebase_key'
  | 'supabase_key'
  | 'generic_secret';

/**
 * Detection result for a single match
 */
export interface SensitiveMatch {
  /** Type of sensitive information */
  type: SensitiveType;
  /** Start position in the text */
  start: number;
  /** End position in the text */
  end: number;
  /** The original matched text */
  original: string;
  /** Masked version (e.g., "sk-...xxxx") */
  masked: string;
  /** Confidence level */
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Detection result
 */
export interface DetectionResult {
  /** Whether any sensitive information was found */
  hasSensitive: boolean;
  /** List of matches */
  matches: SensitiveMatch[];
  /** Total count of matches */
  count: number;
}

// ----------------------------------------------------------------------------
// Sensitive Patterns
// ----------------------------------------------------------------------------

interface SensitivePattern {
  type: SensitiveType;
  pattern: RegExp;
  confidence: SensitiveMatch['confidence'];
  maskStyle: 'full' | 'partial' | 'prefix';
}

/**
 * Patterns for detecting sensitive information
 * Ordered by specificity (more specific patterns first)
 */
const SENSITIVE_PATTERNS: SensitivePattern[] = [
  // API Keys - Provider specific
  {
    type: 'openai_key',
    pattern: /sk-[a-zA-Z0-9]{20,}T3BlbkFJ[a-zA-Z0-9]{20,}/g,
    confidence: 'high',
    maskStyle: 'partial',
  },
  {
    type: 'openai_key',
    pattern: /sk-(?:proj-)?[a-zA-Z0-9_-]{40,}/g,
    confidence: 'high',
    maskStyle: 'partial',
  },
  {
    type: 'anthropic_key',
    pattern: /sk-ant-[a-zA-Z0-9_-]{90,}/g,
    confidence: 'high',
    maskStyle: 'partial',
  },

  // AWS
  {
    type: 'aws_access_key',
    pattern: /(?:^|[^a-zA-Z0-9])(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}(?:[^a-zA-Z0-9]|$)/g,
    confidence: 'high',
    maskStyle: 'partial',
  },
  {
    type: 'aws_secret_key',
    pattern: /(?:aws[_-]?secret[_-]?(?:access[_-]?)?key|secret[_-]?key)[=:]\s*['"]?([a-zA-Z0-9/+=]{40})['"]?/gi,
    confidence: 'high',
    maskStyle: 'full',
  },

  // GitHub
  {
    type: 'github_pat',
    pattern: /ghp_[a-zA-Z0-9]{36,}/g,
    confidence: 'high',
    maskStyle: 'partial',
  },
  {
    type: 'github_token',
    pattern: /gho_[a-zA-Z0-9]{36,}/g,
    confidence: 'high',
    maskStyle: 'partial',
  },
  {
    type: 'github_token',
    pattern: /ghu_[a-zA-Z0-9]{36,}/g,
    confidence: 'high',
    maskStyle: 'partial',
  },
  {
    type: 'github_token',
    pattern: /ghs_[a-zA-Z0-9]{36,}/g,
    confidence: 'high',
    maskStyle: 'partial',
  },
  {
    type: 'github_token',
    pattern: /ghr_[a-zA-Z0-9]{36,}/g,
    confidence: 'high',
    maskStyle: 'partial',
  },

  // GitLab
  {
    type: 'gitlab_token',
    pattern: /glpat-[a-zA-Z0-9_-]{20,}/g,
    confidence: 'high',
    maskStyle: 'partial',
  },

  // NPM
  {
    type: 'npm_token',
    pattern: /npm_[a-zA-Z0-9]{36,}/g,
    confidence: 'high',
    maskStyle: 'partial',
  },

  // PyPI
  {
    type: 'pypi_token',
    pattern: /pypi-[a-zA-Z0-9_-]{50,}/g,
    confidence: 'high',
    maskStyle: 'partial',
  },

  // Docker
  {
    type: 'docker_token',
    pattern: /dckr_pat_[a-zA-Z0-9_-]{20,}/g,
    confidence: 'high',
    maskStyle: 'partial',
  },

  // Slack
  {
    type: 'slack_token',
    pattern: /xox[baprs]-[a-zA-Z0-9-]{10,}/g,
    confidence: 'high',
    maskStyle: 'partial',
  },
  {
    type: 'slack_webhook',
    pattern: /hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[a-zA-Z0-9]+/g,
    confidence: 'high',
    maskStyle: 'partial',
  },

  // Discord
  {
    type: 'discord_token',
    pattern: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27}/g,
    confidence: 'high',
    maskStyle: 'partial',
  },
  {
    type: 'discord_webhook',
    pattern: /discord(?:app)?\.com\/api\/webhooks\/\d+\/[a-zA-Z0-9_-]+/g,
    confidence: 'high',
    maskStyle: 'partial',
  },

  // Stripe
  {
    type: 'stripe_key',
    pattern: /sk_(?:live|test)_[a-zA-Z0-9]{24,}/g,
    confidence: 'high',
    maskStyle: 'partial',
  },
  {
    type: 'stripe_key',
    pattern: /pk_(?:live|test)_[a-zA-Z0-9]{24,}/g,
    confidence: 'high',
    maskStyle: 'partial',
  },
  {
    type: 'stripe_key',
    pattern: /rk_(?:live|test)_[a-zA-Z0-9]{24,}/g,
    confidence: 'high',
    maskStyle: 'partial',
  },

  // Twilio
  {
    type: 'twilio_key',
    pattern: /SK[a-f0-9]{32}/g,
    confidence: 'medium',
    maskStyle: 'partial',
  },

  // SendGrid
  {
    type: 'sendgrid_key',
    pattern: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g,
    confidence: 'high',
    maskStyle: 'partial',
  },

  // Firebase
  {
    type: 'firebase_key',
    pattern: /AIza[a-zA-Z0-9_-]{35}/g,
    confidence: 'high',
    maskStyle: 'partial',
  },

  // Supabase
  {
    type: 'supabase_key',
    pattern: /sbp_[a-f0-9]{40}/g,
    confidence: 'high',
    maskStyle: 'partial',
  },
  {
    type: 'supabase_key',
    pattern: /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
    confidence: 'medium',
    maskStyle: 'partial',
  },

  // JWT Tokens
  {
    type: 'jwt_token',
    pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
    confidence: 'high',
    maskStyle: 'partial',
  },

  // Bearer Tokens
  {
    type: 'bearer_token',
    pattern: /[Bb]earer\s+[a-zA-Z0-9_-]{20,}/g,
    confidence: 'medium',
    maskStyle: 'partial',
  },

  // Basic Auth
  {
    type: 'basic_auth',
    pattern: /[Bb]asic\s+[a-zA-Z0-9+/=]{20,}/g,
    confidence: 'medium',
    maskStyle: 'full',
  },

  // Private Keys
  {
    type: 'private_key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    confidence: 'high',
    maskStyle: 'full',
  },
  {
    type: 'ssh_private_key',
    pattern: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g,
    confidence: 'high',
    maskStyle: 'full',
  },

  // Database URLs
  {
    type: 'database_url',
    pattern: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|mssql):\/\/[^\s'"]+/gi,
    confidence: 'high',
    maskStyle: 'partial',
  },
  {
    type: 'connection_string',
    pattern: /Server=[^;]+;(?:Database|Initial Catalog)=[^;]+;(?:User Id|UID)=[^;]+;(?:Password|PWD)=[^;]+/gi,
    confidence: 'high',
    maskStyle: 'partial',
  },

  // Generic patterns (lower priority)
  {
    type: 'api_key',
    pattern: /(?:api[_-]?key|apikey)[=:]\s*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi,
    confidence: 'medium',
    maskStyle: 'full',
  },
  {
    type: 'password',
    pattern: /(?:password|passwd|pwd)[=:]\s*['"]?([^\s'"]{8,})['"]?/gi,
    confidence: 'medium',
    maskStyle: 'full',
  },
  {
    type: 'generic_secret',
    pattern: /(?:secret|token|credential)[=:]\s*['"]?([a-zA-Z0-9_-]{16,})['"]?/gi,
    confidence: 'low',
    maskStyle: 'full',
  },
];

// ----------------------------------------------------------------------------
// Sensitive Detector Class
// ----------------------------------------------------------------------------

/**
 * Sensitive Information Detector
 *
 * Detects various types of sensitive information including:
 * - API keys (OpenAI, Anthropic, AWS, etc.)
 * - Tokens (GitHub, GitLab, NPM, Slack, Discord)
 * - Credentials (passwords, database URLs)
 * - Private keys (RSA, SSH)
 */
export class SensitiveDetector {
  private patterns: SensitivePattern[];
  private customPatterns: SensitivePattern[] = [];

  constructor() {
    this.patterns = [...SENSITIVE_PATTERNS];
  }

  /**
   * Add a custom pattern for detection
   */
  addPattern(pattern: SensitivePattern): void {
    this.customPatterns.push(pattern);
  }

  /**
   * Detect sensitive information in text
   *
   * @param text - Text to scan for sensitive information
   * @returns Detection result with all matches
   */
  detect(text: string): DetectionResult {
    const matches: SensitiveMatch[] = [];
    const allPatterns = [...this.patterns, ...this.customPatterns];

    // Track matched ranges to avoid duplicates
    const matchedRanges: Set<string> = new Set();

    for (const { type, pattern, confidence, maskStyle } of allPatterns) {
      // Reset regex lastIndex for global patterns
      pattern.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        const rangeKey = `${start}-${end}`;

        // Skip if this range was already matched by a more specific pattern
        if (matchedRanges.has(rangeKey)) {
          continue;
        }

        // Check if this overlaps with an existing match
        let overlaps = false;
        for (const existingMatch of matches) {
          if (
            (start >= existingMatch.start && start < existingMatch.end) ||
            (end > existingMatch.start && end <= existingMatch.end) ||
            (start <= existingMatch.start && end >= existingMatch.end)
          ) {
            overlaps = true;
            break;
          }
        }

        if (overlaps) {
          continue;
        }

        matchedRanges.add(rangeKey);

        const original = match[0];
        const masked = this.maskValue(original, maskStyle);

        matches.push({
          type,
          start,
          end,
          original,
          masked,
          confidence,
        });
      }
    }

    // Sort matches by position
    matches.sort((a, b) => a.start - b.start);

    logger.debug('Sensitive detection complete', {
      textLength: text.length,
      matchCount: matches.length,
      types: [...new Set(matches.map(m => m.type))],
    });

    return {
      hasSensitive: matches.length > 0,
      matches,
      count: matches.length,
    };
  }

  /**
   * Quick check if text contains any sensitive information
   *
   * @param text - Text to check
   * @returns true if any sensitive information is found
   */
  hasSensitive(text: string): boolean {
    const allPatterns = [...this.patterns, ...this.customPatterns];

    for (const { pattern } of allPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Mask all sensitive information in text
   *
   * @param text - Text to mask
   * @returns Text with all sensitive information masked
   */
  maskAll(text: string): string {
    const result = this.detect(text);

    if (!result.hasSensitive) {
      return text;
    }

    let maskedText = text;
    // Process matches in reverse order to preserve positions
    const reversedMatches = [...result.matches].reverse();

    for (const match of reversedMatches) {
      maskedText =
        maskedText.slice(0, match.start) +
        match.masked +
        maskedText.slice(match.end);
    }

    return maskedText;
  }

  /**
   * Mask a single value based on mask style
   */
  private maskValue(value: string, style: SensitivePattern['maskStyle']): string {
    const REDACTED = '***REDACTED***';

    switch (style) {
      case 'full':
        return REDACTED;

      case 'partial': {
        // Show prefix and last 4 chars
        if (value.length <= 8) {
          return REDACTED;
        }
        const prefix = value.slice(0, 4);
        const suffix = value.slice(-4);
        return `${prefix}...${suffix}`;
      }

      case 'prefix': {
        // Show only the prefix (e.g., "sk-" for API keys)
        const prefixMatch = value.match(/^[a-zA-Z_-]+/);
        if (prefixMatch) {
          return `${prefixMatch[0]}${REDACTED}`;
        }
        return REDACTED;
      }

      default:
        return REDACTED;
    }
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let sensitiveDetectorInstance: SensitiveDetector | null = null;

/**
 * Get or create sensitive detector instance
 */
export function getSensitiveDetector(): SensitiveDetector {
  if (!sensitiveDetectorInstance) {
    sensitiveDetectorInstance = new SensitiveDetector();
  }
  return sensitiveDetectorInstance;
}

/**
 * Reset sensitive detector instance (for testing)
 */
export function resetSensitiveDetector(): void {
  sensitiveDetectorInstance = null;
}

/**
 * Convenience function to mask sensitive data
 */
export function maskSensitiveData(text: string): string {
  return getSensitiveDetector().maskAll(text);
}
