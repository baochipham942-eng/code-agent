// ============================================================================
// Log Masker Tests [D1]
// ============================================================================
//
// Tests for the log masking functionality.
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  LogMasker,
  getLogMasker,
  resetLogMasker,
  maskText,
  maskCommand,
  type MaskingOptions,
} from '../../../src/main/security/logMasker';
import { resetSensitiveDetector } from '../../../src/main/security/sensitiveDetector';

describe('LogMasker', () => {
  let masker: LogMasker;

  beforeEach(() => {
    masker = new LogMasker();
    resetLogMasker();
    resetSensitiveDetector();
  });

  // --------------------------------------------------------------------------
  // String Masking
  // --------------------------------------------------------------------------
  describe('String Masking', () => {
    it('should mask API keys in strings', () => {
      const input = 'api_key=sk-1234567890abcdefghijklmnopqrstuvwxyz1234';
      const result = masker.mask(input);
      // SensitiveDetector uses partial masking (e.g., "sk-1...1234")
      expect(result.maskCount).toBeGreaterThan(0);
      // Should not contain the full key
      expect(result.masked).not.toBe(input);
    });

    it('should mask multiple secrets in one string', () => {
      const input = 'ghp_' + 'a'.repeat(36) + ' ghp_' + 'b'.repeat(36);
      const result = masker.mask(input);
      expect(result.maskCount).toBe(2);
      expect(result.maskedTypes).toContain('github_pat');
    });

    it('should preserve non-sensitive text', () => {
      const input = 'User: john, Status: active';
      const result = masker.mask(input);
      expect(result.masked).toBe(input);
      expect(result.maskCount).toBe(0);
    });

    it('should handle empty string', () => {
      const result = masker.mask('');
      expect(result.masked).toBe('');
      expect(result.maskCount).toBe(0);
    });

    it('should return masking result structure', () => {
      const result = masker.mask('normal text');
      expect(result).toHaveProperty('masked');
      expect(result).toHaveProperty('maskCount');
      expect(result).toHaveProperty('maskedTypes');
      expect(result).toHaveProperty('truncated');
    });
  });

  // --------------------------------------------------------------------------
  // Path Masking
  // --------------------------------------------------------------------------
  describe('Path Masking', () => {
    it('should mask home directory paths when enabled', () => {
      const input = 'File at /Users/john/Documents/secret.txt';
      const result = masker.mask(input, { maskPaths: true });
      expect(result.masked).toContain('~');
      expect(result.masked).not.toContain('/Users/john');
      expect(result.maskedTypes).toContain('path');
    });

    it('should mask Linux home paths when enabled', () => {
      const input = 'File at /home/john/config';
      const result = masker.mask(input, { maskPaths: true });
      expect(result.masked).toContain('~');
      expect(result.masked).not.toContain('/home/john');
    });

    it('should not mask paths by default', () => {
      const input = 'File at /Users/john/Documents/file.txt';
      const result = masker.mask(input);
      expect(result.masked).toContain('/Users/john');
    });
  });

  // --------------------------------------------------------------------------
  // Email Masking
  // --------------------------------------------------------------------------
  describe('Email Masking', () => {
    it('should mask email addresses when enabled', () => {
      const input = 'Contact: john.doe@example.com';
      const result = masker.mask(input, { maskEmails: true });
      expect(result.masked).toContain('j***@example.com');
      expect(result.maskedTypes).toContain('email');
    });

    it('should mask short email local parts', () => {
      const input = 'Email: ab@test.com';
      const result = masker.mask(input, { maskEmails: true });
      expect(result.masked).toContain('***@test.com');
    });

    it('should not mask emails by default', () => {
      const input = 'Contact: john@example.com';
      const result = masker.mask(input);
      expect(result.masked).toContain('john@example.com');
    });
  });

  // --------------------------------------------------------------------------
  // IP Masking
  // --------------------------------------------------------------------------
  describe('IP Masking', () => {
    it('should mask IP addresses when enabled', () => {
      const input = 'Server at 192.168.1.100';
      const result = masker.mask(input, { maskIPs: true });
      expect(result.masked).toContain('192.xxx.xxx.100');
      expect(result.maskedTypes).toContain('ip');
    });

    it('should not mask localhost', () => {
      const input = 'Server at 127.0.0.1';
      const result = masker.mask(input, { maskIPs: true });
      expect(result.masked).toContain('127.0.0.1');
    });

    it('should not mask 0.0.0.0', () => {
      const input = 'Bind to 0.0.0.0';
      const result = masker.mask(input, { maskIPs: true });
      expect(result.masked).toContain('0.0.0.0');
    });

    it('should not mask IPs by default', () => {
      const input = 'Server at 10.0.0.1';
      const result = masker.mask(input);
      expect(result.masked).toContain('10.0.0.1');
    });
  });

  // --------------------------------------------------------------------------
  // Custom Patterns
  // --------------------------------------------------------------------------
  describe('Custom Patterns', () => {
    it('should mask custom patterns', () => {
      // Note: SensitiveDetector may match 'secret:' as generic_secret first
      // Use a pattern that won't be caught by SensitiveDetector
      const input = 'Custom data: MYPREFIX-VALUE-123';
      const result = masker.mask(input, {
        customPatterns: [
          { pattern: /MYPREFIX-[A-Z0-9-]+/g, replacement: '[CUSTOM-MASKED]' },
        ],
      });
      expect(result.masked).toContain('[CUSTOM-MASKED]');
      expect(result.maskedTypes).toContain('custom');
    });

    it('should handle multiple custom patterns', () => {
      const input = 'PATTERN1-abc PATTERN2-xyz';
      const result = masker.mask(input, {
        customPatterns: [
          { pattern: /PATTERN1-\w+/g, replacement: '[P1]' },
          { pattern: /PATTERN2-\w+/g, replacement: '[P2]' },
        ],
      });
      expect(result.masked).toContain('[P1]');
      expect(result.masked).toContain('[P2]');
    });
  });

  // --------------------------------------------------------------------------
  // Truncation
  // --------------------------------------------------------------------------
  describe('Truncation', () => {
    it('should truncate long output', () => {
      const input = 'x'.repeat(60000);
      const result = masker.mask(input, { maxLength: 1000 });
      expect(result.truncated).toBe(true);
      expect(result.masked.length).toBeLessThan(input.length);
      expect(result.masked).toContain('[output truncated]');
    });

    it('should preserve lines when truncating', () => {
      const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}`);
      const input = lines.join('\n');
      const result = masker.mask(input, { maxLength: 100, preserveLines: true });
      expect(result.truncated).toBe(true);
      expect(result.masked).toContain('Line 0');
    });

    it('should not truncate short output', () => {
      const input = 'Short text';
      const result = masker.mask(input, { maxLength: 1000 });
      expect(result.truncated).toBe(false);
      expect(result.masked).toBe(input);
    });
  });

  // --------------------------------------------------------------------------
  // Command Masking
  // --------------------------------------------------------------------------
  describe('Command Masking', () => {
    it('should mask password flags', () => {
      const cmd = 'mysql --password=secret123 -u root';
      const masked = masker.maskCommand(cmd);
      expect(masked).toContain('***REDACTED***');
      expect(masked).not.toContain('secret123');
    });

    it('should mask API key environment variables', () => {
      const cmd = 'API_KEY=sk-12345 ./run.sh';
      const masked = masker.maskCommand(cmd);
      expect(masked).toContain('***REDACTED***');
    });

    it('should mask credentials in URLs', () => {
      const cmd = 'curl https://user:password123@api.example.com';
      const masked = masker.maskCommand(cmd);
      expect(masked).toContain('***');
      expect(masked).not.toContain('password123');
    });

    it('should preserve non-sensitive command parts', () => {
      const cmd = 'ls -la /tmp';
      const masked = masker.maskCommand(cmd);
      expect(masked).toBe('ls -la /tmp');
    });
  });

  // --------------------------------------------------------------------------
  // Environment Masking
  // --------------------------------------------------------------------------
  describe('Environment Masking', () => {
    it('should mask sensitive environment variables', () => {
      const env = {
        PATH: '/usr/bin',
        API_KEY: 'secret123',
        DATABASE_PASSWORD: 'dbpass',
        NODE_ENV: 'production',
      };
      const masked = masker.maskEnv(env);
      expect(masked.PATH).toBe('/usr/bin');
      expect(masked.API_KEY).toBe('***REDACTED***');
      expect(masked.DATABASE_PASSWORD).toBe('***REDACTED***');
      expect(masked.NODE_ENV).toBe('production');
    });

    it('should handle undefined values', () => {
      const env = {
        API_KEY: undefined,
        PATH: '/bin',
      };
      const masked = masker.maskEnv(env);
      expect(masked.API_KEY).toBeUndefined();
      expect(masked.PATH).toBe('/bin');
    });
  });

  // --------------------------------------------------------------------------
  // Object Masking
  // --------------------------------------------------------------------------
  describe('Object Masking', () => {
    it('should mask sensitive keys in objects', () => {
      const obj = {
        username: 'john',
        password: 'secret123',
        apiKey: 'key123',
      };
      const masked = masker.maskObject(obj);
      expect(masked.username).toBe('john');
      expect(masked.password).toBe('***REDACTED***');
      expect(masked.apiKey).toBe('***REDACTED***');
    });

    it('should mask nested object values', () => {
      const obj = {
        config: {
          api: {
            key: 'secret123',
            endpoint: 'https://api.example.com',
          },
        },
      };
      const masked = masker.maskObject(obj);
      expect(masked.config.api.key).toBe('***REDACTED***');
      expect(masked.config.api.endpoint).toBe('https://api.example.com');
    });

    it('should mask sensitive values in arrays', () => {
      // Array elements use index as key, so sensitive key matching doesn't apply
      // However, values that match SensitiveDetector patterns will still be masked
      // Let's use values that are detected as sensitive by SensitiveDetector
      const obj = {
        keys: ['ghp_' + 'a'.repeat(36), 'ghp_' + 'b'.repeat(36)],
        names: ['John', 'Jane'],
      };
      const masked = masker.maskObject(obj);
      // GitHub tokens are detected by SensitiveDetector
      expect(masked.keys[0]).not.toBe('ghp_' + 'a'.repeat(36));
      expect(masked.keys[1]).not.toBe('ghp_' + 'b'.repeat(36));
      expect(masked.names[0]).toBe('John');
    });

    it('should handle null and undefined values', () => {
      const obj = {
        name: 'test',
        apiKey: null,
        config: undefined,
      };
      const masked = masker.maskObject(obj as Record<string, unknown>);
      expect(masked.apiKey).toBeNull();
      expect(masked.config).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Safe Log Message
  // --------------------------------------------------------------------------
  describe('Safe Log Message', () => {
    it('should create safe log message', () => {
      const message = 'User logged in with token=ghp_' + 'a'.repeat(36);
      const safe = masker.safeLogMessage(message);
      // Should be masked (partial masking keeps prefix ghp_ but hides middle)
      expect(safe).not.toBe(message);
      // The full token should not be present
      expect(safe).not.toContain('ghp_' + 'a'.repeat(36));
    });

    it('should truncate long messages', () => {
      const message = 'x'.repeat(2000);
      const safe = masker.safeLogMessage(message, 100);
      expect(safe.length).toBeLessThan(200);
      expect(safe).toContain('[output truncated]');
    });
  });

  // --------------------------------------------------------------------------
  // Singleton
  // --------------------------------------------------------------------------
  describe('Singleton', () => {
    it('should return same instance from getLogMasker', () => {
      const instance1 = getLogMasker();
      const instance2 = getLogMasker();
      expect(instance1).toBe(instance2);
    });

    it('should reset instance with resetLogMasker', () => {
      const instance1 = getLogMasker();
      resetLogMasker();
      const instance2 = getLogMasker();
      expect(instance1).not.toBe(instance2);
    });
  });

  // --------------------------------------------------------------------------
  // Convenience Functions
  // --------------------------------------------------------------------------
  describe('Convenience Functions', () => {
    it('should mask text with maskText function', () => {
      const input = 'api_key=sk-test12345678901234567890123456789012';
      const result = maskText(input);
      expect(result).toContain('***REDACTED***');
    });

    it('should mask command with maskCommand function', () => {
      const cmd = '--password=secret123';
      const result = maskCommand(cmd);
      expect(result).toContain('***REDACTED***');
    });
  });
});
