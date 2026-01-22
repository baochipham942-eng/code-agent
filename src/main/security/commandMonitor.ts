// ============================================================================
// Command Monitor - Runtime command validation and monitoring
// ============================================================================

import { createLogger } from '../services/infra/logger';

const logger = createLogger('CommandMonitor');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Command validation result
 */
export interface ValidationResult {
  /** Whether the command is allowed to execute */
  allowed: boolean;
  /** Reason for blocking (if not allowed) */
  reason?: string;
  /** Risk level of the command */
  riskLevel: 'safe' | 'low' | 'medium' | 'high' | 'critical';
  /** Security flags triggered */
  securityFlags: string[];
  /** Suggested alternative command (if blocked) */
  suggestion?: string;
}

/**
 * Command execution result for audit
 */
export interface ExecutionResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  pid?: number;
}

/**
 * Audit entry for command execution
 */
export interface CommandAuditEntry {
  timestamp: number;
  command: string;
  validation: ValidationResult;
  execution?: {
    exitCode: number;
    duration: number;
    success: boolean;
  };
  sessionId?: string;
}

// ----------------------------------------------------------------------------
// Dangerous Command Patterns
// ----------------------------------------------------------------------------

interface DangerousPattern {
  pattern: RegExp;
  riskLevel: ValidationResult['riskLevel'];
  flag: string;
  reason: string;
  suggestion?: string;
}

const DANGEROUS_PATTERNS: DangerousPattern[] = [
  // File system destruction
  {
    pattern: /rm\s+(-[rRf]+\s+)*[\/~]/,
    riskLevel: 'critical',
    flag: 'recursive_delete',
    reason: 'Recursive deletion from root or home directory',
    suggestion: 'Specify a more precise path or use trash instead of rm',
  },
  {
    pattern: /rm\s+-rf?\s+\*/,
    riskLevel: 'critical',
    flag: 'wildcard_delete',
    reason: 'Recursive deletion with wildcard',
  },
  {
    pattern: /rm\s+-rf?\s+\.\s*$/,
    riskLevel: 'critical',
    flag: 'current_dir_delete',
    reason: 'Deleting current directory',
  },

  // Disk operations
  {
    pattern: />\s*\/dev\/sd[a-z]/,
    riskLevel: 'critical',
    flag: 'disk_overwrite',
    reason: 'Writing directly to disk device',
  },
  {
    pattern: /mkfs\./,
    riskLevel: 'critical',
    flag: 'format_disk',
    reason: 'Formatting disk',
  },
  {
    pattern: /dd\s+if=.*of=\/dev\//,
    riskLevel: 'critical',
    flag: 'dd_to_device',
    reason: 'Direct disk write with dd',
  },

  // Fork bomb
  {
    pattern: /:\(\)\s*\{.*\}/,
    riskLevel: 'critical',
    flag: 'fork_bomb',
    reason: 'Potential fork bomb detected',
  },

  // Git destructive operations
  {
    pattern: /git\s+push\s+.*--force/,
    riskLevel: 'high',
    flag: 'git_force_push',
    reason: 'Force push may overwrite remote history',
    suggestion: 'Use --force-with-lease for safer force push',
  },
  {
    pattern: /git\s+reset\s+--hard/,
    riskLevel: 'high',
    flag: 'git_hard_reset',
    reason: 'Hard reset discards uncommitted changes',
    suggestion: 'Consider git stash before reset',
  },
  {
    pattern: /git\s+clean\s+-[dxf]+/,
    riskLevel: 'medium',
    flag: 'git_clean',
    reason: 'Git clean removes untracked files',
    suggestion: 'Use git clean -n first to preview',
  },

  // Permission changes
  {
    pattern: /chmod\s+(-R\s+)?777/,
    riskLevel: 'high',
    flag: 'chmod_777',
    reason: 'Setting world-writable permissions',
    suggestion: 'Use more restrictive permissions like 755 or 644',
  },
  {
    pattern: /chmod\s+-R\s+/,
    riskLevel: 'medium',
    flag: 'recursive_chmod',
    reason: 'Recursive permission change',
  },
  {
    pattern: /chown\s+-R\s+/,
    riskLevel: 'medium',
    flag: 'recursive_chown',
    reason: 'Recursive ownership change',
  },

  // Privilege escalation
  {
    pattern: /sudo\s+rm\s+-rf?/,
    riskLevel: 'critical',
    flag: 'sudo_rm',
    reason: 'Privileged recursive deletion',
  },
  {
    pattern: /sudo\s+chmod/,
    riskLevel: 'high',
    flag: 'sudo_chmod',
    reason: 'Privileged permission change',
  },

  // Network attacks
  {
    pattern: /curl.*\|\s*(ba)?sh/,
    riskLevel: 'high',
    flag: 'pipe_to_shell',
    reason: 'Piping remote content to shell',
    suggestion: 'Download and review script before executing',
  },
  {
    pattern: /wget.*\|\s*(ba)?sh/,
    riskLevel: 'high',
    flag: 'pipe_to_shell',
    reason: 'Piping remote content to shell',
  },

  // History manipulation
  {
    pattern: /history\s+-c/,
    riskLevel: 'medium',
    flag: 'history_clear',
    reason: 'Clearing command history',
  },

  // Environment tampering
  {
    pattern: /export\s+PATH=["']?[^:$]/,
    riskLevel: 'medium',
    flag: 'path_override',
    reason: 'Overriding PATH environment variable',
  },

  // Sensitive file access
  {
    pattern: /cat\s+.*\/etc\/shadow/,
    riskLevel: 'high',
    flag: 'shadow_access',
    reason: 'Accessing password shadow file',
  },
  {
    pattern: /cat\s+.*\/etc\/passwd/,
    riskLevel: 'medium',
    flag: 'passwd_access',
    reason: 'Accessing password file',
  },

  // SSH key operations
  {
    pattern: /ssh-keygen.*-y.*>/,
    riskLevel: 'medium',
    flag: 'ssh_key_export',
    reason: 'Exporting SSH public key from private key',
  },

  // Process killing
  {
    pattern: /kill\s+-9\s+-1/,
    riskLevel: 'critical',
    flag: 'kill_all',
    reason: 'Killing all processes',
  },
  {
    pattern: /killall\s+-9/,
    riskLevel: 'high',
    flag: 'killall',
    reason: 'Force killing processes by name',
  },

  // System shutdown
  {
    pattern: /shutdown|reboot|halt|poweroff/,
    riskLevel: 'high',
    flag: 'system_shutdown',
    reason: 'System shutdown or reboot command',
  },
];

// Blocked command patterns (never allowed)
const BLOCKED_PATTERNS: DangerousPattern[] = [
  {
    pattern: /rm\s+-rf\s+\/\s*$/,
    riskLevel: 'critical',
    flag: 'root_delete',
    reason: 'Attempting to delete root filesystem',
  },
  {
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/,
    riskLevel: 'critical',
    flag: 'fork_bomb',
    reason: 'Fork bomb detected',
  },
  {
    pattern: />\s*\/dev\/sda\s*$/,
    riskLevel: 'critical',
    flag: 'disk_wipe',
    reason: 'Attempting to wipe primary disk',
  },
];

// ----------------------------------------------------------------------------
// Command Monitor Class
// ----------------------------------------------------------------------------

/**
 * Command Monitor - Validates and monitors command execution
 *
 * Provides three-stage monitoring:
 * 1. preExecute: Validates command before execution
 * 2. monitor: Monitors running process (optional)
 * 3. postExecute: Records execution result for audit
 */
export class CommandMonitor {
  private sessionId?: string;
  private auditLog: CommandAuditEntry[] = [];

  constructor(sessionId?: string) {
    this.sessionId = sessionId;
  }

  /**
   * Validate command before execution
   *
   * @param command - The command to validate
   * @returns Validation result with risk level and security flags
   */
  preExecute(command: string): ValidationResult {
    const securityFlags: string[] = [];
    let highestRiskLevel: ValidationResult['riskLevel'] = 'safe';
    let blockReason: string | undefined;
    let suggestion: string | undefined;

    // Normalize command for pattern matching
    const normalizedCommand = command.trim().toLowerCase();

    // Check blocked patterns first (never allowed)
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.pattern.test(command)) {
        logger.warn('Blocked command detected', {
          command: command.substring(0, 100),
          flag: pattern.flag,
        });
        return {
          allowed: false,
          reason: pattern.reason,
          riskLevel: 'critical',
          securityFlags: [pattern.flag],
        };
      }
    }

    // Check dangerous patterns
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.pattern.test(command)) {
        securityFlags.push(pattern.flag);

        // Track highest risk level
        const riskOrder: ValidationResult['riskLevel'][] = ['safe', 'low', 'medium', 'high', 'critical'];
        if (riskOrder.indexOf(pattern.riskLevel) > riskOrder.indexOf(highestRiskLevel)) {
          highestRiskLevel = pattern.riskLevel;
          blockReason = pattern.reason;
          suggestion = pattern.suggestion;
        }
      }
    }

    // Additional heuristic checks
    if (this.containsSensitiveEnvAccess(command)) {
      securityFlags.push('env_access');
      if (highestRiskLevel === 'safe') {
        highestRiskLevel = 'low';
      }
    }

    if (this.containsNetworkOperation(command)) {
      securityFlags.push('network_operation');
      if (highestRiskLevel === 'safe') {
        highestRiskLevel = 'low';
      }
    }

    // Determine if command should be blocked
    // Critical risk level always blocks, high risk requires explicit approval
    const allowed = highestRiskLevel !== 'critical';

    const result: ValidationResult = {
      allowed,
      riskLevel: highestRiskLevel,
      securityFlags,
      reason: blockReason,
      suggestion,
    };

    logger.debug('Command validation result', {
      command: command.substring(0, 50),
      riskLevel: highestRiskLevel,
      flagCount: securityFlags.length,
    });

    return result;
  }

  /**
   * Monitor running process (placeholder for future implementation)
   *
   * @param pid - Process ID to monitor
   * @returns Process events observable (future: rxjs Observable)
   */
  monitor(pid: number): { pid: number; status: string } {
    // Future: Return Observable for process monitoring
    // For now, just return basic info
    logger.debug('Monitoring process', { pid });
    return { pid, status: 'running' };
  }

  /**
   * Record execution result for audit
   *
   * @param command - The executed command
   * @param validation - Pre-execution validation result
   * @param result - Execution result
   * @returns Audit entry
   */
  postExecute(
    command: string,
    validation: ValidationResult,
    result: ExecutionResult
  ): CommandAuditEntry {
    const entry: CommandAuditEntry = {
      timestamp: Date.now(),
      command,
      validation,
      execution: {
        exitCode: result.exitCode,
        duration: result.duration,
        success: result.exitCode === 0,
      },
      sessionId: this.sessionId,
    };

    this.auditLog.push(entry);

    logger.debug('Command execution recorded', {
      command: command.substring(0, 50),
      exitCode: result.exitCode,
      duration: result.duration,
    });

    return entry;
  }

  /**
   * Get audit log for current session
   */
  getAuditLog(): CommandAuditEntry[] {
    return [...this.auditLog];
  }

  /**
   * Clear audit log
   */
  clearAuditLog(): void {
    this.auditLog = [];
  }

  // Private helper methods

  private containsSensitiveEnvAccess(command: string): boolean {
    const envPatterns = [
      /\$\{?[A-Z_]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[A-Z_]*\}?/i,
      /env\s+[A-Z_]*(?:KEY|SECRET|TOKEN)/i,
      /printenv\s+[A-Z_]*(?:KEY|SECRET)/i,
    ];
    return envPatterns.some(p => p.test(command));
  }

  private containsNetworkOperation(command: string): boolean {
    const networkCommands = ['curl', 'wget', 'nc', 'netcat', 'ssh', 'scp', 'rsync', 'ftp', 'telnet'];
    const normalizedCommand = command.toLowerCase();
    return networkCommands.some(cmd =>
      normalizedCommand.startsWith(cmd + ' ') ||
      normalizedCommand.includes(' ' + cmd + ' ') ||
      normalizedCommand.includes('|' + cmd) ||
      normalizedCommand.includes('| ' + cmd)
    );
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let commandMonitorInstance: CommandMonitor | null = null;

/**
 * Get or create command monitor instance
 */
export function getCommandMonitor(sessionId?: string): CommandMonitor {
  if (!commandMonitorInstance || sessionId) {
    commandMonitorInstance = new CommandMonitor(sessionId);
  }
  return commandMonitorInstance;
}

/**
 * Reset command monitor instance (for testing)
 */
export function resetCommandMonitor(): void {
  commandMonitorInstance = null;
}
