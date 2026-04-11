// ============================================================================
// Plugin Validator - Structured validation for plugin manifests and entries
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { PluginPermission, PluginCapability } from './types';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationWarning {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const VALID_PERMISSIONS: PluginPermission[] = [
  'filesystem', 'network', 'shell', 'clipboard', 'notification', 'storage',
];

const VALID_CAPABILITIES: PluginCapability[] = [
  'tools', 'skills', 'theme', 'language',
];

const SEMVER_REGEX = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;

// ----------------------------------------------------------------------------
// Manifest Validation
// ----------------------------------------------------------------------------

/**
 * Validate a plugin manifest object
 */
export function validateManifest(manifest: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  if (manifest === null || manifest === undefined || typeof manifest !== 'object') {
    errors.push({ field: 'manifest', message: 'Manifest must be a non-null object' });
    return { valid: false, errors, warnings };
  }

  const m = manifest as Record<string, unknown>;

  // Required: id
  if (!m.id && !m.name) {
    errors.push({ field: 'id', message: "Missing required field 'id' (or 'name' as fallback)" });
  } else if (m.id && typeof m.id !== 'string') {
    errors.push({ field: 'id', message: "'id' must be a string" });
  } else if (!m.id && m.name && typeof m.name !== 'string') {
    errors.push({ field: 'name', message: "'name' must be a string when used as id fallback" });
  }

  // Required: version
  if (!m.version) {
    errors.push({ field: 'version', message: "Missing required field 'version'" });
  } else if (typeof m.version !== 'string') {
    errors.push({ field: 'version', message: "'version' must be a string" });
  } else if (!SEMVER_REGEX.test(m.version)) {
    warnings.push({ field: 'version', message: `Version '${m.version}' is not valid semver` });
  }

  // Optional: main
  if (m.main !== undefined && typeof m.main !== 'string') {
    errors.push({ field: 'main', message: "'main' must be a string" });
  }

  // Optional: name
  if (m.name !== undefined && typeof m.name !== 'string') {
    warnings.push({ field: 'name', message: "'name' should be a string" });
  }

  // Optional: description
  if (m.description !== undefined && typeof m.description !== 'string') {
    warnings.push({ field: 'description', message: "'description' should be a string" });
  }

  // Optional: author
  if (m.author !== undefined && typeof m.author !== 'string') {
    warnings.push({ field: 'author', message: "'author' should be a string" });
  }

  // Optional: permissions
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) {
      errors.push({ field: 'permissions', message: "'permissions' must be an array" });
    } else {
      for (const perm of m.permissions) {
        if (!VALID_PERMISSIONS.includes(perm as PluginPermission)) {
          warnings.push({
            field: 'permissions',
            message: `Unknown permission '${perm}'. Valid: ${VALID_PERMISSIONS.join(', ')}`,
          });
        }
      }
    }
  }

  // Optional: capabilities
  if (m.capabilities !== undefined) {
    if (!Array.isArray(m.capabilities)) {
      errors.push({ field: 'capabilities', message: "'capabilities' must be an array" });
    } else {
      for (const cap of m.capabilities) {
        if (!VALID_CAPABILITIES.includes(cap as PluginCapability)) {
          warnings.push({
            field: 'capabilities',
            message: `Unknown capability '${cap}'. Valid: ${VALID_CAPABILITIES.join(', ')}`,
          });
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ----------------------------------------------------------------------------
// Entry Validation
// ----------------------------------------------------------------------------

/**
 * Validate that the plugin entry file exists
 */
export async function validateEntry(entryPath: string): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  try {
    await fs.access(entryPath);
  } catch {
    errors.push({
      field: 'main',
      message: `Entry file not found: ${entryPath}`,
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ----------------------------------------------------------------------------
// Skills Directory Validation
// ----------------------------------------------------------------------------

/**
 * Validate the skills directory structure if it exists
 */
export async function validateSkillsDir(pluginDir: string): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  const skillsDir = path.join(pluginDir, 'skills');

  try {
    await fs.access(skillsDir);
  } catch {
    // skills directory is optional
    return { valid: true, errors, warnings };
  }

  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isFile()) continue;
      if (entry.name.startsWith('.')) continue;

      if (entry.isDirectory()) {
        // Skill directories should contain at least one .md file
        const skillDir = path.join(skillsDir, entry.name);
        const files = await fs.readdir(skillDir);
        const hasMd = files.some(f => f.endsWith('.md'));
        if (!hasMd) {
          warnings.push({
            field: `skills/${entry.name}`,
            message: `Skill directory '${entry.name}' has no .md file`,
          });
        }
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push({
      field: 'skills',
      message: `Could not read skills directory: ${message}`,
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ----------------------------------------------------------------------------
// Hook Validation
// ----------------------------------------------------------------------------

/**
 * Validate hook configuration from manifest
 */
export function validateHooks(hooks: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  if (hooks === undefined || hooks === null) {
    return { valid: true, errors, warnings };
  }

  if (!Array.isArray(hooks)) {
    errors.push({ field: 'hooks', message: "'hooks' must be an array" });
    return { valid: false, errors, warnings };
  }

  for (let i = 0; i < hooks.length; i++) {
    const hook = hooks[i];
    const prefix = `hooks[${i}]`;

    if (typeof hook !== 'object' || hook === null) {
      errors.push({ field: prefix, message: 'Hook entry must be an object' });
      continue;
    }

    const h = hook as Record<string, unknown>;

    if (!h.event || typeof h.event !== 'string') {
      errors.push({ field: `${prefix}.event`, message: "Hook must have a string 'event' field" });
    }

    if (h.toolMatcher !== undefined && typeof h.toolMatcher !== 'string') {
      warnings.push({ field: `${prefix}.toolMatcher`, message: "'toolMatcher' should be a string" });
    }

    if (h.priority !== undefined && typeof h.priority !== 'number') {
      warnings.push({ field: `${prefix}.priority`, message: "'priority' should be a number" });
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ----------------------------------------------------------------------------
// Combined Validation
// ----------------------------------------------------------------------------

/**
 * Run all validations for a plugin directory.
 * Merges errors/warnings from manifest, entry, skills, and hooks.
 */
export async function validatePlugin(
  pluginDir: string,
  manifest: unknown
): Promise<ValidationResult> {
  const allErrors: ValidationError[] = [];
  const allWarnings: ValidationWarning[] = [];

  // 1. Validate manifest
  const manifestResult = validateManifest(manifest);
  allErrors.push(...manifestResult.errors);
  allWarnings.push(...manifestResult.warnings);

  // If manifest is fundamentally invalid, skip further checks
  if (!manifestResult.valid) {
    return { valid: false, errors: allErrors, warnings: allWarnings };
  }

  const m = manifest as Record<string, unknown>;

  // 2. Validate entry file
  const entryFile = (typeof m.main === 'string' ? m.main : 'index.js');
  const entryPath = path.join(pluginDir, entryFile);
  const entryResult = await validateEntry(entryPath);
  allErrors.push(...entryResult.errors);
  allWarnings.push(...entryResult.warnings);

  // 3. Validate skills directory
  const skillsResult = await validateSkillsDir(pluginDir);
  allErrors.push(...skillsResult.errors);
  allWarnings.push(...skillsResult.warnings);

  // 4. Validate hooks if present
  if (m.hooks !== undefined) {
    const hooksResult = validateHooks(m.hooks);
    allErrors.push(...hooksResult.errors);
    allWarnings.push(...hooksResult.warnings);
  }

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}

/**
 * Format validation result into a human-readable string
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];

  for (const err of result.errors) {
    lines.push(`ERROR [${err.field}]: ${err.message}`);
  }
  for (const warn of result.warnings) {
    lines.push(`WARN  [${warn.field}]: ${warn.message}`);
  }

  return lines.join('\n');
}
