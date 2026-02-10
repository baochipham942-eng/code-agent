// ============================================================================
// Skill Loader - 依赖检查和 references 加载
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { ParsedSkill, SkillDependencyStatus } from '../../../shared/types/agentSkill';
import { createLogger } from '../infra/logger';

const logger = createLogger('SkillLoader');

/**
 * 检查命令行工具是否可用
 * 使用 execFile 避免 shell 注入
 */
function checkBinAvailable(bin: string): boolean {
  try {
    // 使用 which (Unix) 或 where (Windows) 检查命令是否存在
    const command = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(command, [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查环境变量是否设置
 */
function checkEnvVarExists(envVar: string): boolean {
  return process.env[envVar] !== undefined && process.env[envVar] !== '';
}

/**
 * 检查文件是否存在
 */
async function checkFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Frontmatter 正则：匹配 --- 开头和结尾的 YAML 块
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

/**
 * 按需加载 Skill 的 promptContent
 * 用于延迟加载场景：发现阶段只加载元数据，执行时才加载完整内容
 */
export async function loadSkillContent(skill: ParsedSkill): Promise<void> {
  if (skill.loaded) return;

  const skillPath = path.join(skill.basePath, 'SKILL.md');
  try {
    const content = await fs.readFile(skillPath, 'utf-8');
    const match = content.match(FRONTMATTER_REGEX);
    if (match) {
      skill.promptContent = match[2].trim();
    } else {
      skill.promptContent = content.trim();
    }
    skill.loaded = true;
    logger.info('Loaded skill content on demand', { name: skill.name, path: skillPath });
  } catch (error) {
    logger.error('Failed to load skill content', { name: skill.name, error });
    throw error;
  }
}

/**
 * 检查 Skill 的所有依赖
 */
export async function checkSkillDependencies(
  skill: ParsedSkill
): Promise<SkillDependencyStatus> {
  const missingBins: string[] = [];
  const missingEnvVars: string[] = [];
  const missingReferences: string[] = [];

  // 检查命令行工具
  if (skill.bins && skill.bins.length > 0) {
    for (const bin of skill.bins) {
      if (!checkBinAvailable(bin)) {
        missingBins.push(bin);
      }
    }
  }

  // 检查环境变量
  if (skill.envVars && skill.envVars.length > 0) {
    for (const envVar of skill.envVars) {
      if (!checkEnvVarExists(envVar)) {
        missingEnvVars.push(envVar);
      }
    }
  }

  // 检查引用文件
  if (skill.references && skill.references.length > 0) {
    for (const ref of skill.references) {
      const refPath = path.join(skill.basePath, ref);
      if (!(await checkFileExists(refPath))) {
        missingReferences.push(ref);
      }
    }
  }

  const satisfied = missingBins.length === 0 &&
                    missingEnvVars.length === 0 &&
                    missingReferences.length === 0;

  return {
    satisfied,
    missingBins,
    missingEnvVars,
    missingReferences,
  };
}

/**
 * 加载 Skill 的 reference 文件内容
 */
export async function loadSkillReferences(
  skill: ParsedSkill
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();

  if (!skill.references || skill.references.length === 0) {
    return contents;
  }

  for (const ref of skill.references) {
    const refPath = path.join(skill.basePath, ref);
    try {
      const content = await fs.readFile(refPath, 'utf-8');
      contents.set(ref, content);
      logger.debug('Loaded reference file', { skill: skill.name, ref });
    } catch (error) {
      logger.warn('Failed to load reference file', {
        skill: skill.name,
        ref,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return contents;
}

/**
 * 完整加载 Skill（包括依赖检查和 references）
 */
export async function loadSkillFull(skill: ParsedSkill): Promise<ParsedSkill> {
  // 检查依赖
  const dependencyStatus = await checkSkillDependencies(skill);
  skill.dependencyStatus = dependencyStatus;

  if (!dependencyStatus.satisfied) {
    logger.info('Skill has unsatisfied dependencies', {
      skill: skill.name,
      missingBins: dependencyStatus.missingBins,
      missingEnvVars: dependencyStatus.missingEnvVars,
      missingReferences: dependencyStatus.missingReferences,
    });
  }

  // 加载 references（即使依赖不满足也尝试加载）
  const referenceContents = await loadSkillReferences(skill);
  skill.referenceContents = referenceContents;

  return skill;
}

/**
 * 批量加载 Skills
 */
export async function loadSkillsBatch(skills: ParsedSkill[]): Promise<ParsedSkill[]> {
  const loadedSkills: ParsedSkill[] = [];

  for (const skill of skills) {
    try {
      const loaded = await loadSkillFull(skill);
      loadedSkills.push(loaded);
    } catch (error) {
      logger.error('Failed to load skill', {
        skill: skill.name,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // 即使加载失败，也保留原始 skill
      loadedSkills.push(skill);
    }
  }

  return loadedSkills;
}

/**
 * 获取依赖状态摘要
 */
export function getDependencyStatusSummary(status: SkillDependencyStatus): string {
  if (status.satisfied) {
    return '✅ 所有依赖已满足';
  }

  const issues: string[] = [];

  if (status.missingBins.length > 0) {
    issues.push(`缺少命令: ${status.missingBins.join(', ')}`);
  }
  if (status.missingEnvVars.length > 0) {
    issues.push(`缺少环境变量: ${status.missingEnvVars.join(', ')}`);
  }
  if (status.missingReferences.length > 0) {
    issues.push(`缺少文件: ${status.missingReferences.join(', ')}`);
  }

  return `❌ ${issues.join('; ')}`;
}
