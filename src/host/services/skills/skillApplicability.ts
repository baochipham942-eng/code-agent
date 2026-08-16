import { existsSync } from 'fs';
import * as path from 'path';
import type { ParsedSkill } from '../../../shared/contract/agentSkill';

type SkillApplicabilityReason =
  | 'missing_required_tools'
  | 'fallback_tool_available'
  | 'platform_mismatch'
  | 'missing_required_env'
  | 'missing_required_paths';

export interface SkillApplicabilityHiddenEntry {
  skillName: string;
  reason: SkillApplicabilityReason;
  expected: string[];
  actual: string[];
}

export interface SkillApplicabilityFilterReport {
  evaluatedAt: number;
  workingDirectory: string;
  total: number;
  visible: number;
  hidden: SkillApplicabilityHiddenEntry[];
}

export interface SkillApplicabilityOptions {
  availableToolNames?: () => readonly string[];
  platform?: string;
  env?: NodeJS.ProcessEnv;
  pathExists?: (absolutePath: string) => boolean;
}

export interface SkillApplicabilityContext {
  availableToolNames: readonly string[];
  platform: string;
  env: NodeJS.ProcessEnv;
  workingDirectory: string;
  pathExists: (absolutePath: string) => boolean;
}

export function createSkillApplicabilityContext(
  workingDirectory: string,
  options: SkillApplicabilityOptions = {},
): SkillApplicabilityContext {
  let availableToolNames: readonly string[] = [];
  try {
    availableToolNames = options.availableToolNames?.() ?? [];
  } catch {
    // 工具注册表不可读时按空工具集判定：requires_tools fail-closed，fallback 可出现。
  }
  return {
    availableToolNames,
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    workingDirectory: path.resolve(workingDirectory || process.cwd()),
    pathExists: options.pathExists ?? existsSync,
  };
}

function normalizedSet(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));
}

export function evaluateSkillApplicability(
  skill: ParsedSkill,
  context: SkillApplicabilityContext,
): SkillApplicabilityHiddenEntry | null {
  const availableTools = normalizedSet(context.availableToolNames);

  if (skill.requiresTools?.length) {
    const missing = skill.requiresTools.filter((tool) => !availableTools.has(tool.toLowerCase()));
    if (missing.length > 0) {
      return {
        skillName: skill.name,
        reason: 'missing_required_tools',
        expected: skill.requiresTools,
        actual: missing,
      };
    }
  }

  if (skill.fallbackForTools?.length) {
    const present = skill.fallbackForTools.filter((tool) => availableTools.has(tool.toLowerCase()));
    if (present.length > 0) {
      return {
        skillName: skill.name,
        reason: 'fallback_tool_available',
        expected: skill.fallbackForTools,
        actual: present,
      };
    }
  }

  if (skill.platforms?.length && !skill.platforms.some(
    (platform) => platform.toLowerCase() === context.platform.toLowerCase(),
  )) {
    return {
      skillName: skill.name,
      reason: 'platform_mismatch',
      expected: skill.platforms,
      actual: [context.platform],
    };
  }

  if (skill.requiredEnv?.length) {
    const missing = skill.requiredEnv.filter((name) => !context.env[name]?.trim());
    if (missing.length > 0) {
      return {
        skillName: skill.name,
        reason: 'missing_required_env',
        expected: skill.requiredEnv,
        actual: missing,
      };
    }
  }

  if (skill.requiresPaths?.length) {
    const missing = skill.requiresPaths.filter(
      (relativePath) => !context.pathExists(path.resolve(context.workingDirectory, relativePath)),
    );
    if (missing.length > 0) {
      return {
        skillName: skill.name,
        reason: 'missing_required_paths',
        expected: skill.requiresPaths,
        actual: missing,
      };
    }
  }

  return null;
}

export function filterSkillsByApplicability(
  skills: ParsedSkill[],
  context: SkillApplicabilityContext,
): { skills: ParsedSkill[]; report: SkillApplicabilityFilterReport } {
  const visible: ParsedSkill[] = [];
  const hidden: SkillApplicabilityHiddenEntry[] = [];
  for (const skill of skills) {
    const reason = evaluateSkillApplicability(skill, context);
    if (reason) hidden.push(reason);
    else visible.push(skill);
  }
  return {
    skills: visible,
    report: {
      evaluatedAt: Date.now(),
      workingDirectory: context.workingDirectory,
      total: skills.length,
      visible: visible.length,
      hidden,
    },
  };
}

function hasMachineApplicabilityBoundary(skill: ParsedSkill): boolean {
  return Boolean(
    skill.requiresTools?.length
    || skill.fallbackForTools?.length
    || skill.platforms?.length
    || skill.requiredEnv?.length
    || skill.requiresPaths?.length,
  );
}

export function hasSemanticApplicabilityBoundary(promptContent: string): boolean {
  return /\[IF\s+[^\]\r\n]+\]/i.test(promptContent);
}

export function hasSkillApplicabilityBoundary(skill: ParsedSkill): boolean {
  return hasMachineApplicabilityBoundary(skill)
    || hasSemanticApplicabilityBoundary(skill.promptContent);
}
