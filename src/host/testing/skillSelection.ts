import { SkillDiscoveryService } from '../services/skills/skillDiscoveryService';
import type { TestResult } from './types';

function normalizeSkillNames(skillNames: readonly string[] | undefined): string[] {
  if (!skillNames) return [];
  return [...new Set(skillNames.map((name) => name.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

export function mergeSkillActivations(results: readonly TestResult[]): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const result of results) {
    for (const [name, count] of Object.entries(result.skillActivations ?? {})) {
      merged[name] = (merged[name] ?? 0) + count;
    }
  }
  return merged;
}

export async function validateDiscoverableSkills(
  skillNames: readonly string[] | undefined,
  workingDirectory: string,
  discoverableSkillNames?: readonly string[],
): Promise<string[]> {
  const normalized = normalizeSkillNames(skillNames);
  if (normalized.length === 0) return normalized;

  let availableNames = discoverableSkillNames;
  if (!availableNames) {
    const discovery = new SkillDiscoveryService({ includeClaudeLegacySkills: false });
    await discovery.initialize(workingDirectory);
    availableNames = discovery.getAllSkills().map((skill) => skill.name);
  }
  const available = new Set(availableNames);
  const missing = normalized.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(`实验组指定的能力 ${missing.join('、')} 不存在。`);
  }
  return normalized;
}
