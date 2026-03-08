// ============================================================================
// Policy Enforcer - Runtime enforcement of security policies
// ============================================================================
//
// Integrates with the hook system to block policy-violating tool calls
// before they reach user-defined hooks (cannot be overridden).

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';
import { loadPolicy, hasPolicyFile } from './policyLoader';
import type { SecurityPolicy } from './policyFile';

const logger = createLogger('PolicyEnforcer');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface PolicyCheckResult {
  allowed: boolean;
  reason?: string;
  /** Which policy section triggered the block */
  section?: string;
}

// ----------------------------------------------------------------------------
// PolicyEnforcer
// ----------------------------------------------------------------------------

export class PolicyEnforcer {
  private policy: SecurityPolicy;
  private projectDir: string;
  private logStream: fs.WriteStream | null = null;
  private active: boolean;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    this.active = hasPolicyFile(projectDir);
    this.policy = loadPolicy(projectDir);

    if (this.active && this.policy.audit.log_all_tool_calls) {
      this.initAuditLog();
    }
  }

  /**
   * Whether a policy file was found and enforcement is active
   */
  get isActive(): boolean {
    return this.active;
  }

  /**
   * Reload policy from disk (e.g., after file change)
   */
  reload(): void {
    this.active = hasPolicyFile(this.projectDir);
    this.policy = loadPolicy(this.projectDir);
    logger.info('Policy reloaded', { active: this.active });
  }

  // --------------------------------------------------------------------------
  // Check methods
  // --------------------------------------------------------------------------

  /**
   * Check if a URL is allowed by network policy
   */
  checkNetwork(url: string): PolicyCheckResult {
    if (!this.active) return { allowed: true };

    const { network } = this.policy;

    if (!network.allow) {
      return {
        allowed: false,
        reason: 'Network access is disabled by policy',
        section: 'network',
      };
    }

    if (network.allowed_domains.length > 0) {
      try {
        const hostname = new URL(url).hostname;
        const domainAllowed = network.allowed_domains.some(domain => {
          // Support wildcard subdomains: *.github.com
          if (domain.startsWith('*.')) {
            const suffix = domain.slice(1); // .github.com
            return hostname.endsWith(suffix) || hostname === domain.slice(2);
          }
          return hostname === domain;
        });

        if (!domainAllowed) {
          return {
            allowed: false,
            reason: `Domain "${hostname}" is not in the allowed domains whitelist`,
            section: 'network',
          };
        }
      } catch {
        // Invalid URL, let it pass (will fail at network layer anyway)
      }
    }

    return { allowed: true };
  }

  /**
   * Check if a file path is allowed for the given access mode
   */
  checkFilePath(filePath: string, mode: 'read' | 'write'): PolicyCheckResult {
    if (!this.active) return { allowed: true };

    const { filesystem } = this.policy;
    const normalizedPath = this.normalizePath(filePath);

    // Check denied paths first (highest priority)
    for (const pattern of filesystem.denied_paths) {
      if (this.matchGlob(normalizedPath, this.normalizePath(pattern))) {
        return {
          allowed: false,
          reason: `Path "${filePath}" is denied by policy (pattern: ${pattern})`,
          section: 'filesystem',
        };
      }
    }

    // Check denied file patterns
    const basename = path.basename(filePath);
    for (const pattern of filesystem.denied_file_patterns) {
      if (this.matchGlob(basename, pattern)) {
        return {
          allowed: false,
          reason: `File "${basename}" matches denied pattern "${pattern}"`,
          section: 'filesystem',
        };
      }
    }

    // For write mode, check writable_paths
    if (mode === 'write' && filesystem.writable_paths.length > 0) {
      const isWritable = filesystem.writable_paths.some(pattern =>
        this.matchGlob(normalizedPath, this.normalizePath(pattern))
      );

      if (!isWritable) {
        return {
          allowed: false,
          reason: `Path "${filePath}" is not in writable paths`,
          section: 'filesystem',
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Check if a shell command is allowed
   */
  checkCommand(command: string): PolicyCheckResult {
    if (!this.active) return { allowed: true };

    const { execution } = this.policy;

    if (!execution.allow_shell) {
      return {
        allowed: false,
        reason: 'Shell execution is disabled by policy',
        section: 'execution',
      };
    }

    // Check denied command patterns (regex)
    for (const pattern of execution.denied_commands) {
      try {
        const regex = new RegExp(pattern);
        if (regex.test(command)) {
          return {
            allowed: false,
            reason: `Command matches denied pattern "${pattern}"`,
            section: 'execution',
          };
        }
      } catch {
        // Invalid regex, skip
        logger.warn('Invalid denied_commands regex pattern', { pattern });
      }
    }

    // Check allowed command prefixes (if specified, only these are allowed)
    if (execution.allowed_command_prefixes.length > 0) {
      const trimmed = command.trim();
      const isAllowed = execution.allowed_command_prefixes.some(prefix =>
        trimmed.startsWith(prefix)
      );

      if (!isAllowed) {
        return {
          allowed: false,
          reason: `Command does not match any allowed prefix`,
          section: 'execution',
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Check if a tool is allowed
   */
  checkTool(toolName: string): PolicyCheckResult {
    if (!this.active) return { allowed: true };

    const { tools } = this.policy;

    if (tools.disabled.includes(toolName)) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" is disabled by policy`,
        section: 'tools',
      };
    }

    return { allowed: true };
  }

  /**
   * Check if a model provider is allowed
   */
  checkProvider(provider: string): PolicyCheckResult {
    if (!this.active) return { allowed: true };

    const { model } = this.policy;

    if (model.allowed_providers.length > 0 && !model.allowed_providers.includes(provider)) {
      return {
        allowed: false,
        reason: `Provider "${provider}" is not in the allowed list`,
        section: 'model',
      };
    }

    return { allowed: true };
  }

  /**
   * Check if a tool always requires confirmation regardless of bypass mode
   */
  requiresConfirmation(toolName: string): boolean {
    if (!this.active) return false;
    return this.policy.tools.always_confirm.includes(toolName);
  }

  /**
   * Log a tool call for audit purposes
   */
  logToolCall(
    toolName: string,
    params: Record<string, unknown>,
    result: 'allowed' | 'blocked',
    reason?: string
  ): void {
    if (!this.active || !this.policy.audit.log_all_tool_calls) return;

    const entry = {
      timestamp: new Date().toISOString(),
      toolName,
      params: this.sanitizeParams(params),
      result,
      reason,
    };

    const line = JSON.stringify(entry) + '\n';

    if (this.logStream) {
      this.logStream.write(line);
    } else {
      logger.debug('Audit (no stream)', entry);
    }
  }

  /**
   * Get the current loaded policy (for debugging/display)
   */
  getPolicy(): SecurityPolicy {
    return this.policy;
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private initAuditLog(): void {
    try {
      const logPath = path.isAbsolute(this.policy.audit.log_path)
        ? this.policy.audit.log_path
        : path.join(this.projectDir, this.policy.audit.log_path);

      const logDir = path.dirname(logPath);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      this.logStream = fs.createWriteStream(logPath, { flags: 'a' });
      logger.info('Audit log initialized', { path: logPath });
    } catch (error) {
      logger.warn('Failed to initialize audit log', { error });
    }
  }

  /**
   * Normalize a path, expanding ~ to home directory
   */
  private normalizePath(p: string): string {
    const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
    if (p.startsWith('~/') || p === '~') {
      return path.join(home, p.slice(2));
    }
    if (p.startsWith('./')) {
      return path.join(this.projectDir, p.slice(2));
    }
    if (!path.isAbsolute(p)) {
      return path.join(this.projectDir, p);
    }
    return p;
  }

  /**
   * Simple glob matching supporting * and **
   */
  private matchGlob(filepath: string, pattern: string): boolean {
    // Convert glob to regex
    let regexStr = '^';
    let i = 0;

    while (i < pattern.length) {
      const char = pattern[i];

      if (char === '*') {
        if (pattern[i + 1] === '*') {
          // ** matches any path segment
          if (pattern[i + 2] === '/') {
            regexStr += '(?:.*/)?';
            i += 3;
          } else {
            regexStr += '.*';
            i += 2;
          }
        } else {
          // * matches anything except /
          regexStr += '[^/]*';
          i++;
        }
      } else if (char === '?') {
        regexStr += '[^/]';
        i++;
      } else if ('.+^${}()|[]\\'.includes(char)) {
        regexStr += '\\' + char;
        i++;
      } else {
        regexStr += char;
        i++;
      }
    }

    regexStr += '$';

    try {
      return new RegExp(regexStr).test(filepath);
    } catch {
      return false;
    }
  }

  /**
   * Remove potentially sensitive values from params before logging
   */
  private sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' && value.length > 500) {
        sanitized[key] = value.substring(0, 500) + '...[truncated]';
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let instance: PolicyEnforcer | null = null;

export function getPolicyEnforcer(projectDir?: string): PolicyEnforcer | null {
  if (!instance && projectDir) {
    instance = new PolicyEnforcer(projectDir);
    // Only keep active instance
    if (!instance.isActive) {
      instance = null;
    }
  }
  return instance;
}

export function resetPolicyEnforcer(): void {
  if (instance) {
    instance.dispose();
    instance = null;
  }
}
