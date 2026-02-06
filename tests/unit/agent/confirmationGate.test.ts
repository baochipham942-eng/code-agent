// ============================================================================
// ConfirmationGate Tests [E2]
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ConfirmationGate,
  getConfirmationGate,
  resetConfirmationGate,
} from '../../../src/main/agent/confirmationGate';

describe('ConfirmationGate', () => {
  let gate: ConfirmationGate;

  beforeEach(() => {
    resetConfirmationGate();
    gate = new ConfirmationGate();
  });

  // --------------------------------------------------------------------------
  // shouldConfirm
  // --------------------------------------------------------------------------
  describe('shouldConfirm', () => {
    it('should not confirm read operations', () => {
      const result = gate.shouldConfirm(
        { toolName: 'read_file', params: { file_path: '/tmp/a.ts' }, riskLevel: 'low' },
        'session-1'
      );
      expect(result).toBe(false);
    });

    it('should not confirm medium-risk write operations with ask_if_dangerous', () => {
      // ask_if_dangerous 只在 riskLevel=high 时确认
      const result = gate.shouldConfirm(
        { toolName: 'write_file', params: { file_path: '/tmp/a.ts' }, riskLevel: 'medium' },
        'session-1'
      );
      expect(result).toBe(false);
    });

    it('should confirm high-risk write operations', () => {
      const result = gate.shouldConfirm(
        { toolName: 'write_file', params: { file_path: '/etc/passwd' }, riskLevel: 'high' },
        'session-1'
      );
      expect(result).toBe(true);
    });

    it('should confirm dangerous bash commands', () => {
      const result = gate.shouldConfirm(
        { toolName: 'bash', params: { command: 'rm -rf /' }, riskLevel: 'high' },
        'session-1'
      );
      expect(result).toBe(true);
    });

    it('should not confirm safe bash commands', () => {
      const result = gate.shouldConfirm(
        { toolName: 'bash', params: { command: 'ls -la' }, riskLevel: 'low' },
        'session-1'
      );
      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Policy: always_approve
  // --------------------------------------------------------------------------
  describe('always_approve policy', () => {
    it('should skip confirmation for all tools', () => {
      const autoGate = new ConfirmationGate({ policy: 'always_approve' });
      const result = autoGate.shouldConfirm(
        { toolName: 'write_file', params: {}, riskLevel: 'high' },
        'session-1'
      );
      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Policy: always_ask
  // --------------------------------------------------------------------------
  describe('always_ask policy', () => {
    it('should confirm even read operations', () => {
      const strictGate = new ConfirmationGate({ policy: 'always_ask' });
      const result = strictGate.shouldConfirm(
        { toolName: 'read_file', params: {}, riskLevel: 'low' },
        'session-1'
      );
      expect(result).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Session Approval Memory
  // --------------------------------------------------------------------------
  describe('Session Approval', () => {
    it('should remember session-level approvals', () => {
      const sessionGate = new ConfirmationGate({ policy: 'session_approve' });

      // 首次应该需要确认
      expect(
        sessionGate.shouldConfirm(
          { toolName: 'write_file', params: {}, riskLevel: 'medium' },
          'session-1'
        )
      ).toBe(true);

      // 记录批准
      sessionGate.recordApproval('session-1', 'write_file');

      // 同一会话不再需要确认
      expect(
        sessionGate.shouldConfirm(
          { toolName: 'write_file', params: {}, riskLevel: 'medium' },
          'session-1'
        )
      ).toBe(false);

      // 不同会话仍需确认
      expect(
        sessionGate.shouldConfirm(
          { toolName: 'write_file', params: {}, riskLevel: 'medium' },
          'session-2'
        )
      ).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Risk Assessment
  // --------------------------------------------------------------------------
  describe('assessRiskLevel', () => {
    it('should rate write_file as medium risk', () => {
      const level = gate.assessRiskLevel('write_file', { file_path: '/tmp/a.ts' });
      expect(level).toBe('medium');
    });

    it('should rate dangerous bash as high risk', () => {
      const level = gate.assessRiskLevel('bash', { command: 'rm -rf /important' });
      expect(level).toBe('high');
    });

    it('should rate read_file as low risk', () => {
      const level = gate.assessRiskLevel('read_file', {});
      expect(level).toBe('low');
    });
  });

  // --------------------------------------------------------------------------
  // buildPreview
  // --------------------------------------------------------------------------
  describe('buildPreview', () => {
    it('should build diff preview for edit_file', () => {
      const preview = gate.buildPreview('edit_file', {
        file_path: '/tmp/a.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
      });
      expect(preview).toBeDefined();
      expect(preview!.type).toBe('diff');
      expect(preview!.summary).toBeTruthy();
    });

    it('should build command preview for bash', () => {
      const preview = gate.buildPreview('bash', { command: 'npm install' });
      expect(preview).toBeDefined();
      expect(preview!.type).toBe('command');
      expect(preview!.summary).toContain('npm install');
    });

    it('should return generic preview for non-write tools', () => {
      const preview = gate.buildPreview('read_file', { file_path: '/tmp/a.ts' });
      expect(preview).toBeDefined();
      if (preview) {
        expect(preview.type).toBe('generic');
      }
    });
  });

  // --------------------------------------------------------------------------
  // Singleton
  // --------------------------------------------------------------------------
  describe('Singleton', () => {
    it('should return same instance', () => {
      const a = getConfirmationGate();
      const b = getConfirmationGate();
      expect(a).toBe(b);
    });
  });
});
