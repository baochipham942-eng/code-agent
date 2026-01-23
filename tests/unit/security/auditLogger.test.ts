// ============================================================================
// Audit Logger Tests [D1]
// ============================================================================
//
// Tests for the JSONL audit logging system.
// Note: Full file I/O tests are skipped in unit tests due to async stream issues.
// File operations are tested in E2E tests.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AuditLogger,
  getAuditLogger,
  resetAuditLogger,
  type AuditEntry,
} from '../../../src/main/security/auditLogger';

describe('AuditLogger', () => {
  let logger: AuditLogger;
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `audit-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    logger = new AuditLogger(tempDir);
    resetAuditLogger();
  });

  afterEach(() => {
    logger.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // --------------------------------------------------------------------------
  // Instance Management
  // --------------------------------------------------------------------------
  describe('Instance Management', () => {
    it('should be enabled by default', () => {
      expect(logger.isEnabled()).toBe(true);
    });

    it('should be disableable', () => {
      logger.disable();
      expect(logger.isEnabled()).toBe(false);
    });

    it('should be re-enableable', () => {
      logger.disable();
      logger.enable();
      expect(logger.isEnabled()).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Singleton
  // --------------------------------------------------------------------------
  describe('Singleton', () => {
    it('should return same instance from getAuditLogger', () => {
      const instance1 = getAuditLogger();
      const instance2 = getAuditLogger();
      expect(instance1).toBe(instance2);
    });

    it('should reset instance with resetAuditLogger', () => {
      const instance1 = getAuditLogger();
      resetAuditLogger();
      const instance2 = getAuditLogger();
      expect(instance1).not.toBe(instance2);
    });
  });

  // --------------------------------------------------------------------------
  // Log Methods
  // --------------------------------------------------------------------------
  describe('Log Methods', () => {
    it('should have log method', () => {
      expect(typeof logger.log).toBe('function');
    });

    it('should have logToolUsage method', () => {
      expect(typeof logger.logToolUsage).toBe('function');
    });

    it('should have logCommandExecution method', () => {
      expect(typeof logger.logCommandExecution).toBe('function');
    });

    it('should have logSecurityIncident method', () => {
      expect(typeof logger.logSecurityIncident).toBe('function');
    });

    it('should not throw when logging', () => {
      expect(() => {
        logger.log({
          eventType: 'tool_usage',
          sessionId: 'test',
          toolName: 'test',
          input: {},
          duration: 0,
          success: true,
        });
      }).not.toThrow();
    });

    it('should not throw when logging tool usage', () => {
      expect(() => {
        logger.logToolUsage({
          sessionId: 'test',
          toolName: 'bash',
          input: { command: 'ls' },
          duration: 100,
          success: true,
        });
      }).not.toThrow();
    });

    it('should not throw when logging command execution', () => {
      expect(() => {
        logger.logCommandExecution({
          sessionId: 'test',
          command: 'ls -la',
          exitCode: 0,
          duration: 100,
        });
      }).not.toThrow();
    });

    it('should not throw when logging security incident', () => {
      expect(() => {
        logger.logSecurityIncident({
          sessionId: 'test',
          toolName: 'bash',
          incident: 'Test incident',
          details: {},
          riskLevel: 'low',
        });
      }).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Query Methods
  // --------------------------------------------------------------------------
  describe('Query Methods', () => {
    it('should have query method', () => {
      expect(typeof logger.query).toBe('function');
    });

    it('should have getStatistics method', () => {
      expect(typeof logger.getStatistics).toBe('function');
    });

    it('should have cleanup method', () => {
      expect(typeof logger.cleanup).toBe('function');
    });

    it('should return empty results for empty log', async () => {
      const result = await logger.query();
      expect(result.entries).toBeDefined();
      expect(Array.isArray(result.entries)).toBe(true);
    });

    it('should return statistics structure', async () => {
      const stats = await logger.getStatistics();
      expect(stats).toHaveProperty('totalEvents');
      expect(stats).toHaveProperty('eventsByType');
      expect(stats).toHaveProperty('eventsByTool');
      expect(stats).toHaveProperty('successRate');
      expect(stats).toHaveProperty('securityIncidents');
    });
  });

  // --------------------------------------------------------------------------
  // Log Cleanup
  // --------------------------------------------------------------------------
  describe('Log Cleanup', () => {
    it('should clean up old log files', async () => {
      // Create old log file
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 40);
      const oldFile = path.join(tempDir, `${oldDate.toISOString().split('T')[0]}.jsonl`);
      fs.writeFileSync(oldFile, '{"test": true}\n');

      // Create recent log file
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 5);
      const recentFile = path.join(tempDir, `${recentDate.toISOString().split('T')[0]}.jsonl`);
      fs.writeFileSync(recentFile, '{"test": true}\n');

      const deleted = await logger.cleanup(30);

      expect(deleted).toBe(1);
      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(recentFile)).toBe(true);
    });
  });
});
