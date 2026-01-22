// ============================================================================
// Log Masker - Masks sensitive information in logs and output
// ============================================================================

import { getSensitiveDetector, maskSensitiveData, type SensitiveMatch } from './sensitiveDetector';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('LogMasker');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Masking options
 */
export interface MaskingOptions {
  /** Mask all sensitive data (default: true) */
  maskSecrets?: boolean;
  /** Mask file paths (default: false) */
  maskPaths?: boolean;
  /** Mask email addresses (default: false) */
  maskEmails?: boolean;
  /** Mask IP addresses (default: false) */
  maskIPs?: boolean;
  /** Custom patterns to mask */
  customPatterns?: Array<{
    pattern: RegExp;
    replacement: string;
  }>;
  /** Maximum length of output (truncate if longer) */
  maxLength?: number;
  /** Preserve line structure when truncating */
  preserveLines?: boolean;
}

/**
 * Masking result
 */
export interface MaskingResult {
  /** The masked text */
  masked: string;
  /** Number of items masked */
  maskCount: number;
  /** Types of items masked */
  maskedTypes: string[];
  /** Whether the output was truncated */
  truncated: boolean;
}

// ----------------------------------------------------------------------------
// Additional Patterns
// ----------------------------------------------------------------------------

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const IP_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const HOME_PATH_PATTERN = /(?:\/Users\/|\/home\/)[a-zA-Z0-9_-]+/g;

// ----------------------------------------------------------------------------
// Log Masker Class
// ----------------------------------------------------------------------------

/**
 * Log Masker - Masks sensitive information in logs
 *
 * Uses SensitiveDetector for secret detection and provides
 * additional masking options for paths, emails, and IPs.
 */
export class LogMasker {
  private defaultOptions: MaskingOptions = {
    maskSecrets: true,
    maskPaths: false,
    maskEmails: false,
    maskIPs: false,
    maxLength: 50000,
    preserveLines: true,
  };

  /**
   * Mask sensitive information in text
   *
   * @param text - Text to mask
   * @param options - Masking options
   * @returns Masking result
   */
  mask(text: string, options: MaskingOptions = {}): MaskingResult {
    const opts = { ...this.defaultOptions, ...options };
    let masked = text;
    let maskCount = 0;
    const maskedTypes: string[] = [];
    let truncated = false;

    // Mask secrets using SensitiveDetector
    if (opts.maskSecrets) {
      const detector = getSensitiveDetector();
      const result = detector.detect(text);

      if (result.hasSensitive) {
        masked = detector.maskAll(text);
        maskCount += result.count;
        maskedTypes.push(...new Set(result.matches.map(m => m.type)));
      }
    }

    // Mask home directory paths
    if (opts.maskPaths) {
      const pathMatches = masked.match(HOME_PATH_PATTERN);
      if (pathMatches) {
        masked = masked.replace(HOME_PATH_PATTERN, '~');
        maskCount += pathMatches.length;
        if (!maskedTypes.includes('path')) {
          maskedTypes.push('path');
        }
      }
    }

    // Mask email addresses
    if (opts.maskEmails) {
      const emailMatches = masked.match(EMAIL_PATTERN);
      if (emailMatches) {
        masked = masked.replace(EMAIL_PATTERN, (match) => {
          const [local, domain] = match.split('@');
          if (local.length > 2) {
            return `${local[0]}***@${domain}`;
          }
          return '***@' + domain;
        });
        maskCount += emailMatches.length;
        if (!maskedTypes.includes('email')) {
          maskedTypes.push('email');
        }
      }
    }

    // Mask IP addresses
    if (opts.maskIPs) {
      const ipMatches = masked.match(IP_PATTERN);
      if (ipMatches) {
        masked = masked.replace(IP_PATTERN, (match) => {
          // Don't mask localhost
          if (match === '127.0.0.1' || match === '0.0.0.0') {
            return match;
          }
          const parts = match.split('.');
          return `${parts[0]}.xxx.xxx.${parts[3]}`;
        });
        maskCount += ipMatches.length;
        if (!maskedTypes.includes('ip')) {
          maskedTypes.push('ip');
        }
      }
    }

    // Apply custom patterns
    if (opts.customPatterns) {
      for (const { pattern, replacement } of opts.customPatterns) {
        pattern.lastIndex = 0;
        const matches = masked.match(pattern);
        if (matches) {
          masked = masked.replace(pattern, replacement);
          maskCount += matches.length;
          if (!maskedTypes.includes('custom')) {
            maskedTypes.push('custom');
          }
        }
      }
    }

    // Truncate if necessary
    if (opts.maxLength && masked.length > opts.maxLength) {
      if (opts.preserveLines) {
        // Find a good break point near maxLength
        const lines = masked.split('\n');
        let charCount = 0;
        let lineIndex = 0;

        for (let i = 0; i < lines.length; i++) {
          if (charCount + lines[i].length + 1 > opts.maxLength) {
            lineIndex = i;
            break;
          }
          charCount += lines[i].length + 1;
          lineIndex = i + 1;
        }

        if (lineIndex < lines.length) {
          masked = lines.slice(0, lineIndex).join('\n') + '\n... [output truncated]';
          truncated = true;
        }
      } else {
        masked = masked.substring(0, opts.maxLength) + '... [output truncated]';
        truncated = true;
      }
    }

    logger.debug('Text masked', {
      originalLength: text.length,
      maskedLength: masked.length,
      maskCount,
      truncated,
    });

    return {
      masked,
      maskCount,
      maskedTypes,
      truncated,
    };
  }

  /**
   * Mask command line arguments
   *
   * @param command - Command string to mask
   * @returns Masked command
   */
  maskCommand(command: string): string {
    // Mask common secret patterns in commands
    let masked = command;

    // Mask -password, --password, -p flags
    masked = masked.replace(
      /(-{1,2}(?:password|passwd|pwd|secret|token|key|api[_-]?key)[\s=]+)(['"]?)([^\s'"]+)\2/gi,
      '$1$2***REDACTED***$2'
    );

    // Mask environment variable assignments
    masked = masked.replace(
      /((?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[=])(['"]?)([^\s'"]+)\2/gi,
      '$1$2***REDACTED***$2'
    );

    // Mask inline credentials in URLs
    masked = masked.replace(
      /(https?:\/\/)([^:@\s]+):([^@\s]+)@/gi,
      '$1$2:***@'
    );

    // Use sensitive detector for any remaining secrets
    return maskSensitiveData(masked);
  }

  /**
   * Mask environment variables
   *
   * @param env - Environment variables object
   * @returns Masked environment variables
   */
  maskEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
    const sensitiveKeys = [
      'KEY', 'SECRET', 'TOKEN', 'PASSWORD', 'PASSWD', 'PWD',
      'CREDENTIAL', 'AUTH', 'API', 'PRIVATE', 'ACCESS',
    ];

    const masked: Record<string, string | undefined> = {};

    for (const [key, value] of Object.entries(env)) {
      const isSensitive = sensitiveKeys.some(
        sensitive => key.toUpperCase().includes(sensitive)
      );

      if (isSensitive && value) {
        masked[key] = '***REDACTED***';
      } else {
        masked[key] = value;
      }
    }

    return masked;
  }

  /**
   * Mask a structured object (deep)
   *
   * @param obj - Object to mask
   * @returns Masked object
   */
  maskObject<T extends Record<string, unknown>>(obj: T): T {
    const sensitiveKeys = [
      'password', 'secret', 'token', 'key', 'apiKey', 'api_key',
      'credential', 'auth', 'authorization', 'private', 'access',
      'bearer', 'jwt', 'session',
    ];

    const mask = (value: unknown, key?: string): unknown => {
      if (value === null || value === undefined) {
        return value;
      }

      if (typeof value === 'string') {
        // Check if key suggests sensitive data
        if (key && sensitiveKeys.some(k => key.toLowerCase().includes(k))) {
          return '***REDACTED***';
        }
        // Also run through sensitive detector
        return maskSensitiveData(value);
      }

      if (Array.isArray(value)) {
        return value.map((item, index) => mask(item, String(index)));
      }

      if (typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          result[k] = mask(v, k);
        }
        return result;
      }

      return value;
    };

    return mask(obj) as T;
  }

  /**
   * Create a safe log message (masks and truncates)
   *
   * @param message - Message to log
   * @param maxLength - Maximum length (default: 1000)
   * @returns Safe log message
   */
  safeLogMessage(message: string, maxLength = 1000): string {
    const result = this.mask(message, {
      maskSecrets: true,
      maxLength,
      preserveLines: false,
    });
    return result.masked;
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let logMaskerInstance: LogMasker | null = null;

/**
 * Get or create log masker instance
 */
export function getLogMasker(): LogMasker {
  if (!logMaskerInstance) {
    logMaskerInstance = new LogMasker();
  }
  return logMaskerInstance;
}

/**
 * Reset log masker instance (for testing)
 */
export function resetLogMasker(): void {
  logMaskerInstance = null;
}

/**
 * Convenience function to mask text
 */
export function maskText(text: string, options?: MaskingOptions): string {
  return getLogMasker().mask(text, options).masked;
}

/**
 * Convenience function to mask command
 */
export function maskCommand(command: string): string {
  return getLogMasker().maskCommand(command);
}
