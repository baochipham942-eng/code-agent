// ============================================================================
// Command Monitor Tests [D1]
// ============================================================================
//
// Tests for the runtime command monitoring module.
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CommandMonitor,
  getCommandMonitor,
  resetCommandMonitor,
  type ValidationResult,
  type ExecutionResult,
} from '../../../src/main/security/commandMonitor';

describe('CommandMonitor', () => {
  let monitor: CommandMonitor;

  beforeEach(() => {
    monitor = new CommandMonitor();
    resetCommandMonitor();
  });

  // --------------------------------------------------------------------------
  // Pre-Execution Validation
  // --------------------------------------------------------------------------
  describe('Pre-Execution Validation', () => {
    it('should allow safe commands', () => {
      const safeCommands = [
        'ls -la',
        'npm install',
        'git status',
        'cat file.txt',
        'echo "hello"',
      ];
      for (const cmd of safeCommands) {
        const result = monitor.preExecute(cmd);
        expect(result.allowed).toBe(true);
      }
    });

    it('should block rm -rf / command', () => {
      const result = monitor.preExecute('rm -rf / ');
      expect(result.allowed).toBe(false);
      expect(result.riskLevel).toBe('critical');
      expect(result.securityFlags).toContain('root_delete');
    });

    it('should detect rm -rf with home directory', () => {
      const result = monitor.preExecute('rm -rf ~');
      expect(result.riskLevel).toBe('critical');
      expect(result.securityFlags).toContain('recursive_delete');
    });

    it('should detect disk wipe commands', () => {
      const result = monitor.preExecute('> /dev/sda ');
      expect(result.allowed).toBe(false);
      expect(result.riskLevel).toBe('critical');
      expect(result.securityFlags).toContain('disk_wipe');
    });

    it('should detect mkfs commands', () => {
      const result = monitor.preExecute('mkfs.ext4 /dev/sda1');
      expect(result.allowed).toBe(false);
      expect(result.riskLevel).toBe('critical');
      expect(result.securityFlags).toContain('format_disk');
    });

    it('should detect dd to device', () => {
      const result = monitor.preExecute('dd if=/dev/zero of=/dev/sda');
      expect(result.allowed).toBe(false);
      expect(result.riskLevel).toBe('critical');
      expect(result.securityFlags).toContain('dd_to_device');
    });

    it('should detect fork bomb', () => {
      const result = monitor.preExecute(':() { : | : & }');
      expect(result.riskLevel).toBe('critical');
    });

    it('should detect git force push', () => {
      const result = monitor.preExecute('git push origin main --force');
      expect(result.riskLevel).toBe('high');
      expect(result.securityFlags).toContain('git_force_push');
      expect(result.suggestion).toBeDefined();
    });

    it('should detect git hard reset', () => {
      const result = monitor.preExecute('git reset --hard HEAD~1');
      expect(result.riskLevel).toBe('high');
      expect(result.securityFlags).toContain('git_hard_reset');
    });

    it('should detect chmod 777', () => {
      const result = monitor.preExecute('chmod 777 /var/www');
      expect(result.riskLevel).toBe('high');
      expect(result.securityFlags).toContain('chmod_777');
    });

    it('should detect curl piped to shell', () => {
      const result = monitor.preExecute('curl https://example.com/script.sh | sh');
      expect(result.riskLevel).toBe('high');
      expect(result.securityFlags).toContain('pipe_to_shell');
    });

    it('should detect wget piped to bash', () => {
      const result = monitor.preExecute('wget -O - https://example.com/script.sh | bash');
      expect(result.riskLevel).toBe('high');
      expect(result.securityFlags).toContain('pipe_to_shell');
    });

    it('should detect kill all processes', () => {
      const result = monitor.preExecute('kill -9 -1');
      expect(result.allowed).toBe(false);
      expect(result.riskLevel).toBe('critical');
      expect(result.securityFlags).toContain('kill_all');
    });

    it('should detect shutdown commands', () => {
      const result = monitor.preExecute('shutdown -h now');
      expect(result.riskLevel).toBe('high');
      expect(result.securityFlags).toContain('system_shutdown');
    });

    it('should detect sudo rm commands', () => {
      const result = monitor.preExecute('sudo rm -rf /tmp');
      expect(result.allowed).toBe(false);
      expect(result.riskLevel).toBe('critical');
      expect(result.securityFlags).toContain('sudo_rm');
    });

    it('should detect sensitive env access', () => {
      const result = monitor.preExecute('echo $API_KEY');
      expect(result.securityFlags).toContain('env_access');
    });

    it('should detect network operations', () => {
      const result = monitor.preExecute('curl https://api.example.com');
      expect(result.securityFlags).toContain('network_operation');
    });

    it('should detect ssh commands as network operations', () => {
      const result = monitor.preExecute('ssh user@server');
      expect(result.securityFlags).toContain('network_operation');
    });
  });

  // --------------------------------------------------------------------------
  // Process Monitoring
  // --------------------------------------------------------------------------
  describe('Process Monitoring', () => {
    it('should return process info for monitoring', () => {
      const result = monitor.monitor(12345);
      expect(result.pid).toBe(12345);
      expect(result.status).toBe('running');
    });
  });

  // --------------------------------------------------------------------------
  // Post-Execution Auditing
  // --------------------------------------------------------------------------
  describe('Post-Execution Auditing', () => {
    it('should create audit entries for executed commands', () => {
      const validation = monitor.preExecute('ls -la');
      const executionResult: ExecutionResult = {
        command: 'ls -la',
        exitCode: 0,
        stdout: 'file1.txt\nfile2.txt',
        stderr: '',
        duration: 100,
      };
      const entry = monitor.postExecute('ls -la', validation, executionResult);

      expect(entry.command).toBe('ls -la');
      expect(entry.validation).toEqual(validation);
      expect(entry.execution?.exitCode).toBe(0);
      expect(entry.execution?.duration).toBe(100);
      expect(entry.execution?.success).toBe(true);
      expect(entry.timestamp).toBeDefined();
    });

    it('should mark failed commands', () => {
      const validation = monitor.preExecute('invalid_command');
      const executionResult: ExecutionResult = {
        command: 'invalid_command',
        exitCode: 127,
        stdout: '',
        stderr: 'command not found',
        duration: 50,
      };
      const entry = monitor.postExecute('invalid_command', validation, executionResult);

      expect(entry.execution?.success).toBe(false);
      expect(entry.execution?.exitCode).toBe(127);
    });

    it('should store entries in audit log', () => {
      const validation = monitor.preExecute('echo test');
      const executionResult: ExecutionResult = {
        command: 'echo test',
        exitCode: 0,
        stdout: 'test',
        stderr: '',
        duration: 10,
      };
      monitor.postExecute('echo test', validation, executionResult);

      const auditLog = monitor.getAuditLog();
      expect(auditLog).toHaveLength(1);
      expect(auditLog[0].command).toBe('echo test');
    });

    it('should clear audit log', () => {
      const validation = monitor.preExecute('echo test');
      const executionResult: ExecutionResult = {
        command: 'echo test',
        exitCode: 0,
        stdout: 'test',
        stderr: '',
        duration: 10,
      };
      monitor.postExecute('echo test', validation, executionResult);
      monitor.clearAuditLog();

      expect(monitor.getAuditLog()).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Session Management
  // --------------------------------------------------------------------------
  describe('Session Management', () => {
    it('should store session ID in audit entries', () => {
      const sessionMonitor = new CommandMonitor('session-123');
      const validation = sessionMonitor.preExecute('ls');
      const executionResult: ExecutionResult = {
        command: 'ls',
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 10,
      };
      const entry = sessionMonitor.postExecute('ls', validation, executionResult);

      expect(entry.sessionId).toBe('session-123');
    });
  });

  // --------------------------------------------------------------------------
  // Singleton
  // --------------------------------------------------------------------------
  describe('Singleton', () => {
    it('should return same instance from getCommandMonitor', () => {
      const instance1 = getCommandMonitor();
      const instance2 = getCommandMonitor();
      expect(instance1).toBe(instance2);
    });

    it('should create new instance with new sessionId', () => {
      const instance1 = getCommandMonitor();
      const instance2 = getCommandMonitor('new-session');
      expect(instance1).not.toBe(instance2);
    });

    it('should reset instance with resetCommandMonitor', () => {
      const instance1 = getCommandMonitor();
      resetCommandMonitor();
      const instance2 = getCommandMonitor();
      expect(instance1).not.toBe(instance2);
    });
  });

  // --------------------------------------------------------------------------
  // Risk Level
  // --------------------------------------------------------------------------
  describe('Risk Level Calculation', () => {
    it('should return safe for benign commands', () => {
      const result = monitor.preExecute('echo hello');
      expect(result.riskLevel).toBe('safe');
    });

    it('should return low for env access', () => {
      const result = monitor.preExecute('echo $SECRET_KEY');
      expect(result.riskLevel).toBe('low');
    });

    it('should return medium for git clean', () => {
      const result = monitor.preExecute('git clean -df');
      expect(result.riskLevel).toBe('medium');
    });

    it('should return high for chmod 777', () => {
      const result = monitor.preExecute('chmod 777 file');
      expect(result.riskLevel).toBe('high');
    });

    it('should return critical for rm -rf /', () => {
      const result = monitor.preExecute('rm -rf / ');
      expect(result.riskLevel).toBe('critical');
    });
  });
});
