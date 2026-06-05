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
} from '../../../shared/contract/agentSkill';
import {
  SkillParseError,
  SkillValidationError,
} from '../../../shared/contract/agentSkill';

// Frontmatter 正则：匹配 --- 开头和结尾的 YAML 块
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

// GAP-007: 已知 frontmatter 字段清单（与 SkillFrontmatter 契约同步）。
// 未知字段静默忽略会造成"假护栏"（如 alowed-tools 拼写错误导致限权失效），必须告警。
const KNOWN_FRONTMATTER_FIELDS = new Set([
  'name',
  'description',
  'aliases',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
  'disable-model-invocation',
  'user-invocable',
  'strict-toolset',
  'model',
  'context',
  'agent',
  'argument-hint',
  'bins',
  'env-vars',
  'references',
]);

/**
 * Levenshtein 编辑距离（用于未知字段的拼写建议）
 */
function editDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/**
 * GAP-007: 检查未知 frontmatter 字段并产生告警。
 * 不 reject（保持向前兼容），但必须让用户看见，避免拼写错误导致配置静默失效。
 */
function collectUnknownFieldWarnings(
  frontmatter: Record<string, unknown>,
  skillPath: string,
): string[] {
  const warnings: string[] = [];
  for (const key of Object.keys(frontmatter)) {
    if (KNOWN_FRONTMATTER_FIELDS.has(key)) continue;

    // 找最接近的已知字段做拼写建议（编辑距离 ≤ 2）
    let suggestion: string | undefined;
    let bestDistance = 3;
    for (const known of KNOWN_FRONTMATTER_FIELDS) {
      const distance = editDistance(key.toLowerCase(), known);
      if (distance < bestDistance) {
        bestDistance = distance;
        suggestion = known;
      }
    }

    const message = suggestion
      ? `Unknown frontmatter field "${key}" is ignored. Did you mean "${suggestion}"?`
      : `Unknown frontmatter field "${key}" is ignored.`;
    warnings.push(message);
    console.warn(`[SkillParser] ${skillPath}: ${message}`);
  }
  return warnings;
}

// Skill name 格式验证：小写字母开头，只包含小写字母、数字和单个连字符
const SKILL_NAME_REGEX = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;
const TOOL_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
const TOOL_SCOPED_PREFIX_REGEX = /^([A-Za-z][A-Za-z0-9_.:-]*)\(([A-Za-z0-9._/@+-]+):\*\)$/;
const ALIAS_SPLIT_REGEX = /[,，、\n]/;

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

  // 7.5 GAP-007: 未知字段告警
  const frontmatterWarnings = collectUnknownFieldWarnings(
    frontmatter as unknown as Record<string, unknown>,
    skillPath,
  );

  // 8. 构建 ParsedSkill
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    aliases: parseAliases(frontmatter.aliases),
    license: frontmatter.license,
    compatibility: frontmatter.compatibility,
    metadata: frontmatter.metadata,
    promptContent: markdownBody.trim(),
    basePath: skillDir,
    allowedTools,
    disableModelInvocation: frontmatter['disable-model-invocation'] ?? false,
    userInvocable: frontmatter['user-invocable'] ?? true,
    strictToolset: frontmatter['strict-toolset'] ?? false,
    model: frontmatter.model,
    executionContext: frontmatter.context ?? 'inline',
    agent: frontmatter.agent,
    argumentHint: frontmatter['argument-hint'],
    source,
    // 依赖字段
    bins: frontmatter.bins,
    envVars: frontmatter['env-vars'],
    references: frontmatter.references,
    ...(frontmatterWarnings.length > 0 ? { frontmatterWarnings } : {}),
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

function parseAliases(value: SkillFrontmatter['aliases']): string[] | undefined {
  if (value === undefined) return undefined;

  const rawAliases = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(ALIAS_SPLIT_REGEX)
      : [value as unknown];

  const aliases: string[] = [];
  for (const alias of rawAliases) {
    if (typeof alias !== 'string') {
      throw new SkillValidationError(
        'aliases must be a string or an array of strings',
        'aliases',
        alias,
      );
    }

    const normalized = alias.trim();
    if (normalized) aliases.push(normalized);
  }

  return aliases.length > 0 ? Array.from(new Set(aliases)) : undefined;
}

/**
 * 解析 allowed-tools 字段
 * 支持数组格式，或空格/逗号分隔的字符串格式
 */
function parseAllowedTools(allowedTools: string | string[] | undefined): string[] {
  if (!allowedTools) {
    return [];
  }

  const entries = Array.isArray(allowedTools)
    ? allowedTools
    : allowedTools.split(/[\s,]+/);

  return entries
    .map((tool) => {
      if (typeof tool !== 'string') {
        throw new SkillValidationError(
          'allowed-tools entries must be strings',
          'allowed-tools',
          tool
        );
      }
      return tool.trim();
    })
    .filter((tool) => tool.length > 0)
    .map((tool) => {
      validateAllowedToolSpecifier(tool);
      return tool;
    });
}

function validateAllowedToolSpecifier(tool: string): void {
  if (TOOL_NAME_REGEX.test(tool) || TOOL_SCOPED_PREFIX_REGEX.test(tool)) {
    return;
  }

  throw new SkillValidationError(
    'allowed-tools entries must be tool names or scoped prefixes like Bash(git:*)',
    'allowed-tools',
    tool
  );
}

/**
 * 仅解析 SKILL.md 的元数据（frontmatter），不加载 promptContent
 * 用于发现阶段的延迟加载，节省内存和 token
 *
 * @param skillDir - 包含 SKILL.md 的目录路径
 * @param source - Skill 来源
 * @returns 解析后的 ParsedSkill 对象（promptContent 为空，loaded 为 false）
 */
export async function parseSkillMetadataOnly(
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

  const [, frontmatterYaml] = match;

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

  // 7.5 GAP-007: 未知字段告警
  const frontmatterWarnings = collectUnknownFieldWarnings(
    frontmatter as unknown as Record<string, unknown>,
    skillPath,
  );

  // 8. 构建 ParsedSkill（不加载 promptContent）
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    aliases: parseAliases(frontmatter.aliases),
    license: frontmatter.license,
    compatibility: frontmatter.compatibility,
    metadata: frontmatter.metadata,
    promptContent: '',
    basePath: skillDir,
    allowedTools,
    disableModelInvocation: frontmatter['disable-model-invocation'] ?? false,
    userInvocable: frontmatter['user-invocable'] ?? true,
    strictToolset: frontmatter['strict-toolset'] ?? false,
    model: frontmatter.model,
    executionContext: frontmatter.context ?? 'inline',
    agent: frontmatter.agent,
    argumentHint: frontmatter['argument-hint'],
    source,
    bins: frontmatter.bins,
    envVars: frontmatter['env-vars'],
    references: frontmatter.references,
    loaded: false,
    ...(frontmatterWarnings.length > 0 ? { frontmatterWarnings } : {}),
  };
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
