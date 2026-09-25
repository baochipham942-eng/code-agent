import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { parseShellCommand } from './commandParse';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import {
  hasOfficialSkillSections,
  OFFICIAL_SKILL_SECTION_BLOCKED_CODE,
} from './skillOfficialSectionGuard';

export interface SkillOfficialShellGuardResult {
  allowed: boolean;
  error?: string;
  code?: typeof OFFICIAL_SKILL_SECTION_BLOCKED_CODE;
  path?: string;
}

function expandControlledShellVars(rawPath: string, workingDirectory: string): string | undefined {
  const expanded = rawPath
    .replaceAll(/\$\{HOME\}|\$HOME\b/g, os.homedir())
    .replaceAll(/\$\{PWD\}|\$PWD\b/g, workingDirectory);
  return /[$`*?{}]/.test(expanded) ? undefined : expanded;
}

function resolveShellTarget(rawPath: string, workingDirectory: string): string | undefined {
  const expanded = expandControlledShellVars(rawPath, workingDirectory);
  if (!expanded) return undefined;
  const tildeExpanded = expanded === '~'
    ? os.homedir()
    : expanded.startsWith('~/')
      ? path.join(os.homedir(), expanded.slice(2))
      : expanded;
  try {
    return resolveCanonicalRunPath(path.isAbsolute(tildeExpanded)
      ? tildeExpanded
      : path.resolve(workingDirectory, tildeExpanded));
  } catch {
    return undefined;
  }
}

/**
 * Shell writes cannot preserve an official section without inspecting the resulting file.
 * Fail closed for every statically resolved write target that already contains one.
 */
export async function guardShellOfficialSkillWrites(
  command: string,
  workingDirectory: string,
): Promise<SkillOfficialShellGuardResult> {
  const parsed = parseShellCommand(command);
  const seen = new Set<string>();
  for (const target of parsed.writeTargets) {
    // Keep the lexical basename check before canonicalization so a symlink named
    // SKILL.md cannot turn into a differently named target and bypass the guard.
    if (path.basename(target.path) !== 'SKILL.md') continue;
    const resolved = resolveShellTarget(target.path, workingDirectory);
    if (!resolved) {
      return {
        allowed: false,
        error: 'SKILL.md writes with unresolved paths are blocked because the official section cannot be checked. Resolve the path and use the native file tools for content outside the official section.',
        code: OFFICIAL_SKILL_SECTION_BLOCKED_CODE,
        path: target.path,
      };
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    let content: string;
    try {
      content = await fs.readFile(resolved, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (hasOfficialSkillSections(content)) {
      return {
        allowed: false,
        error: 'SKILL.md official section is protected; use the native file tools for content outside the official section.',
        code: OFFICIAL_SKILL_SECTION_BLOCKED_CODE,
        path: resolved,
      };
    }
  }
  return { allowed: true };
}
