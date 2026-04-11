// ============================================================================
// Policy Loader - Load and merge security policies from multiple sources
// ============================================================================
//
// Priority (highest to lowest):
//   1. System: /etc/code-agent/policy.toml
//   2. User:   ~/.code-agent/policy.toml
//   3. Project: ./code-agent-policy.toml
//
// Merge rules:
//   - Higher priority overrides scalar values
//   - denied/disabled lists are UNION'd (any level can deny)
//   - allowed lists use highest priority non-empty value

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';
import {
  type SecurityPolicy,
  createDefaultPolicy,
  parseSimpleToml,
  policyFromToml,
} from './policyFile';
import { getUserConfigDir } from '../config/configPaths';

const logger = createLogger('PolicyLoader');

const POLICY_FILENAME = 'code-agent-policy.toml';

// ----------------------------------------------------------------------------
// Policy loading
// ----------------------------------------------------------------------------

/**
 * Get all candidate policy file paths in priority order (lowest to highest)
 */
function getPolicyPaths(projectDir: string): string[] {
  return [
    // 3. Project level (lowest priority)
    path.join(projectDir, POLICY_FILENAME),
    // 2. User level
    path.join(getUserConfigDir(), 'policy.toml'),
    // 1. System level (highest priority)
    '/etc/code-agent/policy.toml',
  ];
}

/**
 * Try to read and parse a single policy file
 */
function loadSinglePolicy(filePath: string): Partial<SecurityPolicy> | null {
  try {
    if (!fs.existsSync(filePath)) return null;

    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseSimpleToml(content);
    const policy = policyFromToml(parsed);

    logger.info('Loaded policy file', { path: filePath });
    return policy;
  } catch (error) {
    logger.warn('Failed to parse policy file, skipping', { path: filePath, error });
    return null;
  }
}

/**
 * Merge two string arrays as a union (deduplicated)
 */
function mergeUnion(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * Merge a higher-priority policy into the base policy
 *
 * - Scalar values: override
 * - Denied/disabled lists: union (any level can deny)
 * - Allowed lists: override only if non-empty
 */
function mergePolicy(base: SecurityPolicy, override: Partial<SecurityPolicy>): SecurityPolicy {
  const merged = { ...base };

  if (override.network) {
    merged.network = {
      allow: override.network.allow,
      allowed_domains: override.network.allowed_domains.length > 0
        ? override.network.allowed_domains
        : base.network.allowed_domains,
    };
  }

  if (override.filesystem) {
    merged.filesystem = {
      writable_paths: override.filesystem.writable_paths.length > 0
        ? override.filesystem.writable_paths
        : base.filesystem.writable_paths,
      // denied = union
      denied_paths: mergeUnion(
        base.filesystem.denied_paths,
        override.filesystem.denied_paths
      ),
      denied_file_patterns: mergeUnion(
        base.filesystem.denied_file_patterns,
        override.filesystem.denied_file_patterns
      ),
    };
  }

  if (override.execution) {
    merged.execution = {
      allow_shell: override.execution.allow_shell,
      // denied = union
      denied_commands: mergeUnion(
        base.execution.denied_commands,
        override.execution.denied_commands
      ),
      allowed_command_prefixes: override.execution.allowed_command_prefixes.length > 0
        ? override.execution.allowed_command_prefixes
        : base.execution.allowed_command_prefixes,
    };
  }

  if (override.tools) {
    merged.tools = {
      // disabled = union
      disabled: mergeUnion(base.tools.disabled, override.tools.disabled),
      // always_confirm = union
      always_confirm: mergeUnion(base.tools.always_confirm, override.tools.always_confirm),
    };
  }

  if (override.model) {
    merged.model = {
      allowed_providers: override.model.allowed_providers.length > 0
        ? override.model.allowed_providers
        : base.model.allowed_providers,
      code_restricted_providers: mergeUnion(
        base.model.code_restricted_providers,
        override.model.code_restricted_providers
      ),
    };
  }

  if (override.audit) {
    merged.audit = {
      log_all_tool_calls: override.audit.log_all_tool_calls || base.audit.log_all_tool_calls,
      log_path: override.audit.log_path || base.audit.log_path,
    };
  }

  return merged;
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * Load and merge policy files from all sources
 *
 * Files are loaded in priority order (project -> user -> system).
 * Higher priority overrides scalars; denied lists are union'd.
 * Returns default (permissive) policy if no files exist.
 */
export function loadPolicy(projectDir: string): SecurityPolicy {
  let policy = createDefaultPolicy();
  const paths = getPolicyPaths(projectDir);
  let loadedCount = 0;

  // Paths are ordered lowest to highest priority
  for (const filePath of paths) {
    const partial = loadSinglePolicy(filePath);
    if (partial) {
      policy = mergePolicy(policy, partial);
      loadedCount++;
    }
  }

  if (loadedCount > 0) {
    logger.info('Policy loaded from files', { count: loadedCount });
  } else {
    logger.debug('No policy files found, using defaults');
  }

  return policy;
}

/**
 * Check if any policy file exists for the given project
 */
export function hasPolicyFile(projectDir: string): boolean {
  return getPolicyPaths(projectDir).some(p => fs.existsSync(p));
}
