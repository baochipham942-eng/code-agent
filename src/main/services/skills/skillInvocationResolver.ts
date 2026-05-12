import type {
  ParsedSkill,
  SkillContextModifier,
} from '../../../shared/contract/agentSkill';
import { getSkillDiscoveryService } from './skillDiscoveryService';
import { loadSkillContent } from './skillLoader';
import { renderSkillContent } from './skillRenderer';
import { createLogger } from '../infra/logger';

const logger = createLogger('SkillInvocationResolver');

const NAME_PATTERN = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;
const DIRECT_SLASH_PATTERN = /^\s*\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?\s*$/i;
const URL_LIKE_SLASH_PATTERN = /https?:\/\/|\b[\w.-]+\.[a-z]{2,}\//i;
const ALIAS_SPLIT_PATTERN = /[,，、;；|\/\n]/;
const CJK_PATTERN = /[\u3400-\u9fff]/;
const DESCRIPTION_TRIGGER_PATTERNS = [
  /(?:当用户(?:明确)?(?:提到|说|要求|需要|询问|问到)|用户(?:提到|说到)|适用于|用于)([^。.\n]+)/gi,
  /(?:Triggers?|Use when)(?:[^:：。.\n]*)[:：]?\s*([^。.\n]+)/gi,
];
const GENERIC_ALIAS_STOPWORDS = new Set([
  'user',
  'users',
  'when',
  'asks',
  'use',
  'using',
  'need',
  'needs',
  'file',
  'files',
  'code',
  'data',
  'tool',
  'tools',
  'task',
  'tasks',
  '文档',
  '文件',
  '代码',
  '数据',
  '工具',
  '任务',
  '查询',
  '搜索',
  '生成',
  '创建',
  '编辑',
]);

export type SkillInvocationMatchKind = 'slash' | 'inline-slash' | 'alias';
type AliasSource = 'name' | 'frontmatter' | 'metadata' | 'description';

export interface SkillAliasCandidate {
  value: string;
  source: AliasSource;
}

export interface ResolvedSkillInvocation {
  skill: ParsedSkill;
  matchKind: SkillInvocationMatchKind;
  matchedText: string;
  args?: string;
  confidence: number;
  aliases: string[];
  reason: string;
}

export interface SkillInvocationContext {
  block: string;
  contextModifier: SkillContextModifier;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

function hasCjk(value: string): boolean {
  return CJK_PATTERN.test(value);
}

function normalizeAlias(value: string): string {
  return value
    .replace(/^[\s"'`“”‘’《》「」『』【】([{]+/, '')
    .replace(/[\s"'`“”‘’《》「」『』【】)\]}]+$/, '')
    .trim();
}

function isUsefulAlias(alias: string): boolean {
  const normalized = normalizeText(alias);
  if (!normalized || GENERIC_ALIAS_STOPWORDS.has(normalized)) return false;
  if (hasCjk(alias)) return alias.length >= 2 && alias.length <= 24;
  return normalized.length >= 3 && normalized.length <= 48;
}

function splitAliasField(value: string): string[] {
  return value
    .split(ALIAS_SPLIT_PATTERN)
    .map(normalizeAlias)
    .filter(isUsefulAlias);
}

function expandParentheticalAlias(value: string): string[] {
  const normalized = normalizeAlias(value);
  if (!normalized) return [];
  const aliases = [normalized];
  const match = normalized.match(/^(.+?)\((.+?)\)$/);
  if (match) {
    aliases.push(match[1], match[2]);
    aliases.push(...match[2].split(/\s+/));
  }
  return aliases.map(normalizeAlias).filter(isUsefulAlias);
}

function metadataAliasValues(metadata: ParsedSkill['metadata']): string[] {
  if (!metadata) return [];
  const values: string[] = [];
  for (const key of ['alias', 'aliases', 'keyword', 'keywords', 'trigger', 'triggers', 'trigger-phrases']) {
    const value = metadata[key];
    if (typeof value === 'string') {
      values.push(...splitAliasField(value));
    }
  }
  return values;
}

function descriptionTriggerAliases(description: string): string[] {
  const aliases: string[] = [];
  for (const pattern of DESCRIPTION_TRIGGER_PATTERNS) {
    for (const match of description.matchAll(pattern)) {
      const segment = match[1] ?? '';
      const firstClause = segment.split(/(?:时|的时候|场景|，|。|\.)/)[0] ?? segment;
      for (const token of firstClause.split(ALIAS_SPLIT_PATTERN)) {
        aliases.push(...expandParentheticalAlias(token));
      }
    }
  }
  return uniq(aliases);
}

export function getSkillInvocationAliases(skill: ParsedSkill): SkillAliasCandidate[] {
  const candidates: SkillAliasCandidate[] = [];

  candidates.push({ value: skill.name, source: 'name' });
  if (skill.name.includes('-')) {
    candidates.push({ value: skill.name.replace(/-/g, ' '), source: 'name' });
  }

  for (const alias of skill.aliases ?? []) {
    const normalized = normalizeAlias(alias);
    if (isUsefulAlias(normalized)) {
      candidates.push({ value: normalized, source: 'frontmatter' });
    }
  }

  for (const alias of metadataAliasValues(skill.metadata)) {
    candidates.push({ value: alias, source: 'metadata' });
  }

  for (const alias of descriptionTriggerAliases(skill.description)) {
    candidates.push({ value: alias, source: 'description' });
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = normalizeText(candidate.value);
    if (!isUsefulAlias(candidate.value) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractDirectSlashInvocation(message: string): { command: string; args?: string } | null {
  const match = message.match(DIRECT_SLASH_PATTERN);
  if (!match) return null;
  const command = match[1]?.toLowerCase();
  if (!command || !NAME_PATTERN.test(command)) return null;
  const args = match[2]?.trim();
  return { command, ...(args ? { args } : {}) };
}

function includesInlineSlashSkill(message: string, skillName: string): boolean {
  if (URL_LIKE_SLASH_PATTERN.test(message)) return false;
  return message.toLowerCase().includes(`/${skillName.toLowerCase()}`);
}

function aliasScore(source: AliasSource, exactWholeMessage: boolean, alias: string): number {
  let score = 0;
  if (source === 'name') score = 0.86;
  if (source === 'frontmatter') score = 0.9;
  if (source === 'metadata') score = 0.88;
  if (source === 'description') score = 0.8;
  if (exactWholeMessage) score += 0.08;
  score += Math.min(alias.length, 24) / 400;
  return Math.min(score, 0.99);
}

export function resolveSkillInvocationFromSkills(
  message: string,
  skills: ParsedSkill[],
): ResolvedSkillInvocation | null {
  const userInvocableSkills = skills.filter((skill) => skill.userInvocable);

  const direct = extractDirectSlashInvocation(message);
  if (direct) {
    const skill = userInvocableSkills.find((candidate) => candidate.name === direct.command);
    if (skill) {
      const aliases = getSkillInvocationAliases(skill).map((alias) => alias.value);
      return {
        skill,
        matchKind: 'slash',
        matchedText: `/${skill.name}`,
        args: direct.args,
        confidence: 1,
        aliases,
        reason: 'explicit slash command',
      };
    }
  }

  for (const skill of userInvocableSkills) {
    if (includesInlineSlashSkill(message, skill.name)) {
      const aliases = getSkillInvocationAliases(skill).map((alias) => alias.value);
      return {
        skill,
        matchKind: 'inline-slash',
        matchedText: `/${skill.name}`,
        args: message,
        confidence: 0.96,
        aliases,
        reason: 'inline slash command mention',
      };
    }
  }

  const normalizedMessage = normalizeText(message);
  const matches: ResolvedSkillInvocation[] = [];
  for (const skill of userInvocableSkills) {
    for (const alias of getSkillInvocationAliases(skill)) {
      const normalizedAlias = normalizeText(alias.value);
      if (!normalizedMessage.includes(normalizedAlias)) continue;

      const score = aliasScore(alias.source, normalizedMessage === normalizedAlias, alias.value);
      if (score < 0.8) continue;
      matches.push({
        skill,
        matchKind: 'alias',
        matchedText: alias.value,
        args: message,
        confidence: score,
        aliases: getSkillInvocationAliases(skill).map((candidate) => candidate.value),
        reason: `${alias.source} alias matched`,
      });
    }
  }

  matches.sort((a, b) => b.confidence - a.confidence);
  const [best, second] = matches;
  if (!best) return null;
  if (second && second.skill.name !== best.skill.name && best.confidence - second.confidence < 0.12) {
    logger.info('Skill alias match ambiguous; leaving routing to model/tool_search', {
      best: best.skill.name,
      second: second.skill.name,
      bestConfidence: best.confidence,
      secondConfidence: second.confidence,
    });
    return null;
  }

  return best;
}

export async function resolveSkillInvocation(
  message: string,
  workingDirectory: string,
): Promise<ResolvedSkillInvocation | null> {
  const discoveryService = getSkillDiscoveryService();
  await discoveryService.ensureInitialized(workingDirectory || process.cwd());
  return resolveSkillInvocationFromSkills(message, discoveryService.getUserInvocableSkills());
}

function canSkillAutoPreApproveTools(skill: ParsedSkill): boolean {
  return skill.source === 'builtin' || skill.source === 'plugin';
}

export async function buildSkillInvocationContext(
  invocation: ResolvedSkillInvocation,
  workingDirectory: string,
): Promise<SkillInvocationContext> {
  const { skill } = invocation;
  if (!skill.loaded) {
    await loadSkillContent(skill);
  }

  let promptContent = renderSkillContent(skill.promptContent, {
    arguments: invocation.args,
    workingDirectory,
  });

  if (invocation.args) {
    promptContent += `\n\n---\nUser provided arguments: ${invocation.args}`;
  }

  if (skill.source === 'user' || skill.source === 'project') {
    promptContent += `\n\n---\n**自修补**: 如果发现本 skill 的指令过时或有错误（工具名变化、路径错误、逻辑缺陷），直接用 Edit 修改 \`${skill.basePath}/SKILL.md\` 的相应部分。修改后系统自动重载。`;
  }

  const contextModifier: SkillContextModifier = {};
  if (skill.allowedTools.length > 0 && canSkillAutoPreApproveTools(skill)) {
    contextModifier.preApprovedTools = skill.allowedTools;
  }
  if (skill.model) {
    contextModifier.modelOverride = skill.model;
  }

  const block = [
    `<required-skill-invocation name="${skill.name}" match="${invocation.matchKind}" source="${skill.source}">`,
    `The user explicitly invoked or clearly targeted this user-invocable skill. Treat these skill instructions as required for this turn, even if the skill has disable-model-invocation enabled.`,
    `Matched text: ${invocation.matchedText}`,
    `Skill path: ${skill.basePath}/SKILL.md`,
    invocation.args ? `User arguments: ${invocation.args}` : '',
    '<skill-instructions>',
    promptContent,
    '</skill-instructions>',
    '</required-skill-invocation>',
  ].filter(Boolean).join('\n');

  return { block, contextModifier };
}
