// ============================================================================
// SKILL.md Parser - Agent Skills Standard
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import type {
  ParsedSkill,
  SkillFrontmatter,
  SkillSource,
} from '../../../shared/types/agentSkill';
import {
  SkillParseError,
  SkillValidationError,
} from '../../../shared/types/agentSkill';

// Frontmatter 正则：匹配 --- 开头和结尾的 YAML 块
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

// Skill name 格式验证：小写字母开头，只包含小写字母、数字和单个连字符
const SKILL_NAME_REGEX = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

/**
 * 解析 SKILL.md 文件
 *
 * @param skillDir - 包含 SKILL.md 的目录路径
 * @param source - Skill 来源
 * @returns 解析后的 ParsedSkill 对象
 * @throws SkillParseError 如果文件不存在或格式错误
 * @throws SkillValidationError 如果字段验证失败
 */
export async function parseSkillMd(
  skillDir: string,
  source: SkillSource
): Promise<ParsedSkill> {
  const skillPath = path.join(skillDir, 'SKILL.md');

  // 1. 读取文件
  let content: string;
  try {
    content = await fs.readFile(skillPath, 'utf-8');
  } catch (error) {
    throw new SkillParseError(
      `Failed to read SKILL.md: ${error instanceof Error ? error.message : 'Unknown error'}`,
      skillPath,
      error
    );
  }

  // 2. 提取 frontmatter
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    throw new SkillParseError(
      'Invalid SKILL.md format: missing or malformed YAML frontmatter',
      skillPath
    );
  }

  const [, frontmatterYaml, markdownBody] = match;

  // 3. 解析 YAML
  let frontmatter: SkillFrontmatter;
  try {
    frontmatter = yaml.parse(frontmatterYaml) as SkillFrontmatter;
  } catch (error) {
    throw new SkillParseError(
      `Failed to parse YAML frontmatter: ${error instanceof Error ? error.message : 'Unknown error'}`,
      skillPath,
      error
    );
  }

  // 4. 验证必填字段
  if (!frontmatter.name) {
    throw new SkillValidationError(
      'Missing required field: name',
      'name',
      undefined
    );
  }

  if (!frontmatter.description) {
    throw new SkillValidationError(
      'Missing required field: description',
      'description',
      undefined
    );
  }

  // 5. 验证 name 格式
  validateSkillName(frontmatter.name);

  // 6. 验证 description 长度
  if (frontmatter.description.length > 1024) {
    throw new SkillValidationError(
      'Description exceeds maximum length of 1024 characters',
      'description',
      frontmatter.description.length
    );
  }

  // 7. 解析 allowed-tools
  const allowedTools = parseAllowedTools(frontmatter['allowed-tools']);

  // 8. 构建 ParsedSkill
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    license: frontmatter.license,
    compatibility: frontmatter.compatibility,
    metadata: frontmatter.metadata,
    promptContent: markdownBody.trim(),
    basePath: skillDir,
    allowedTools,
    disableModelInvocation: frontmatter['disable-model-invocation'] ?? false,
    userInvocable: frontmatter['user-invocable'] ?? true,
    model: frontmatter.model,
    executionContext: frontmatter.context ?? 'inline',
    agent: frontmatter.agent,
    argumentHint: frontmatter['argument-hint'],
    source,
    // 依赖字段
    bins: frontmatter.bins,
    envVars: frontmatter['env-vars'],
    references: frontmatter.references,
  };
}

/**
 * 验证 Skill name 格式
 */
function validateSkillName(name: string): void {
  // 检查长度
  if (name.length < 1 || name.length > 64) {
    throw new SkillValidationError(
      'Skill name must be between 1 and 64 characters',
      'name',
      name
    );
  }

  // 检查格式
  if (!SKILL_NAME_REGEX.test(name)) {
    throw new SkillValidationError(
      'Skill name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens',
      'name',
      name
    );
  }

  // 检查连续连字符
  if (name.includes('--')) {
    throw new SkillValidationError(
      'Skill name cannot contain consecutive hyphens',
      'name',
      name
    );
  }
}

/**
 * 解析 allowed-tools 字段
 * 支持空格分隔的工具名列表
 */
function parseAllowedTools(allowedTools: string | undefined): string[] {
  if (!allowedTools) {
    return [];
  }

  return allowedTools
    .split(/\s+/)
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
}

/**
 * 检查目录是否包含有效的 SKILL.md
 */
export async function hasSkillMd(dir: string): Promise<boolean> {
  try {
    const skillPath = path.join(dir, 'SKILL.md');
    await fs.access(skillPath);
    return true;
  } catch {
    return false;
  }
}
