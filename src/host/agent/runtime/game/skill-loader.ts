/**
 * Skill loader — 读取 skills/<name>/SKILL.md，解析 YAML frontmatter + markdown body。
 *
 * 与 Claude Code Skills（progressive disclosure）模式一致 — frontmatter 是 metadata，
 * body 是按需展开的内容。skill 体里支持 `extractSection(body, '## Generation Contract')`
 * 这种小节抽取，实现"先 metadata 决定要不要加载，再按需读 body 的具体段落"。
 *
 * 使用 js-yaml 做 frontmatter 解析（已经在依赖里）。
 */

import { promises as fsp } from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import { SKILL_LOADER_DEFAULTS } from '@shared/constants';

import type { ArtifactKind, PredicateExpr, VerbId } from './types';

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

/**
 * SKILL.md frontmatter — 必填字段 + verb 声明。
 *
 * 设计选择：declared_verbs 用 snake_case 的 yaml key + 对应到 VerbDeclaration 的字段。
 * 这是给人类作者写的格式，loader 不在这一层做语义校验（Phase 3 再加 strict schema check）。
 */
export interface SkillFrontmatter {
  /** Skill 唯一名（与目录名一致） */
  name: string;
  /** 一句话描述 — 给 LLM 看的（soft dispatch by description match） */
  description: string;
  /** 该 skill 服务的 artifact kind */
  artifact_kind: ArtifactKind;
  /** 可选 subtype — game kind 才有 */
  subtype?: string;
  /** 声明的 verbs — Phase 3 之后由 SubtypeChecker 解析 */
  declared_verbs?: SkillVerbDeclaration[];
  /** 任意附加字段 — 不让 yaml 噪音破坏类型，提供 escape hatch */
  [key: string]: unknown;
}

/**
 * 给作者写的 verb 形态 — yaml-friendly。Loader 不验证 verb id 合法性
 * （那是 SubtypeChecker 注册时的事），但保留类型契约方便上层消费。
 */
export interface SkillVerbDeclaration {
  verb: VerbId;
  selector: string;
  success: PredicateExpr;
  liveness?: PredicateExpr;
  required?: boolean;
}

/** 加载后的完整 manifest — frontmatter + body + 来源路径 */
export interface SkillManifest {
  frontmatter: SkillFrontmatter;
  body: string;
  /** SKILL.md 的绝对路径 — 用于错误提示和 resolve 相邻 reference 文件 */
  path: string;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * 加载单个 skill 目录 — 必须存在 SKILL.md。
 *
 * 抛出条件:
 * - SKILL.md 不存在
 * - frontmatter 缺失或不是合法 yaml
 * - frontmatter 缺 name / description / artifact_kind 任一必填字段
 */
export async function loadSkill(skillDir: string): Promise<SkillManifest> {
  const manifestPath = path.join(skillDir, SKILL_LOADER_DEFAULTS.MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await fsp.readFile(manifestPath, 'utf8');
  } catch (err) {
    throw new Error(
      `Skill manifest not found at ${manifestPath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    throw new Error(`Skill manifest ${manifestPath} missing YAML frontmatter`);
  }
  const fm = parsed.frontmatter;
  // 必填字段校验 — 失败时给出清晰路径
  for (const required of ['name', 'description', 'artifact_kind'] as const) {
    if (typeof fm[required] !== 'string' || (fm[required] as string).length === 0) {
      throw new Error(
        `Skill manifest ${manifestPath} missing required frontmatter field "${required}"`,
      );
    }
  }
  return {
    frontmatter: fm,
    body: parsed.body,
    path: manifestPath,
  };
}

/**
 * 一层目录扫描 — skillsRoot/<name>/SKILL.md。
 * 子目录里没 SKILL.md 的会跳过（不当错误，方便 README/_template 这种辅助目录共存）。
 */
export async function loadAllSkills(skillsRoot: string): Promise<SkillManifest[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(skillsRoot);
  } catch (err) {
    throw new Error(
      `Skills root not readable at ${skillsRoot}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const manifests: SkillManifest[] = [];
  for (const entry of entries) {
    // 跳过隐藏目录和 _template / _* 这种约定的辅助目录
    if (entry.startsWith('.') || entry.startsWith('_')) continue;
    const dir = path.join(skillsRoot, entry);
    const stat = await fsp.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const manifestPath = path.join(dir, SKILL_LOADER_DEFAULTS.MANIFEST_FILENAME);
    const exists = await fsp
      .stat(manifestPath)
      .then((s) => s.isFile())
      .catch(() => false);
    if (!exists) continue;
    manifests.push(await loadSkill(dir));
  }
  return manifests;
}

// ---------------------------------------------------------------------------
// Progressive disclosure helper
// ---------------------------------------------------------------------------

/**
 * 从 markdown body 中按 heading 名称抽取一段。
 *
 * 例：headingName='Generation Contract' 会匹配 '## Generation Contract' 或更深层 heading，
 * 返回从该 heading 之后到下一个**同级或更高级** heading 之前的文本（不含 heading 本身）。
 *
 * 找不到返回 undefined；多次出现取第一段。
 */
export function extractSection(body: string, headingName: string): string | undefined {
  const lines = body.split(/\r?\n/);
  const target = headingName.trim();
  // heading 行：'^#{1,6} <name>$'
  let foundLevel = -1;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2].trim() === target) {
      foundLevel = m[1].length;
      start = i + 1;
      break;
    }
  }
  if (foundLevel === -1) return undefined;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m && m[1].length <= foundLevel) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

interface ParsedFrontmatter {
  frontmatter: SkillFrontmatter;
  body: string;
}

/**
 * 解析 markdown 顶部的 `---` … `---` YAML frontmatter。
 * 没 frontmatter 返回 null，由调用方决定是错误还是允许。
 */
function parseFrontmatter(raw: string): ParsedFrontmatter | null {
  const delim = SKILL_LOADER_DEFAULTS.FRONTMATTER_DELIMITER;
  const lines = raw.split(/\r?\n/);
  // 跳过开头空行
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || lines[i].trim() !== delim) return null;
  const fmStart = i + 1;
  let fmEnd = -1;
  for (let j = fmStart; j < lines.length; j++) {
    if (lines[j].trim() === delim) {
      fmEnd = j;
      break;
    }
  }
  if (fmEnd === -1) return null;
  const yamlText = lines.slice(fmStart, fmEnd).join('\n');
  let parsed: unknown;
  try {
    parsed = yaml.load(yamlText);
  } catch (err) {
    throw new Error(`Invalid YAML frontmatter: ${(err as Error).message}`, { cause: err });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Frontmatter YAML must parse to an object');
  }
  const body = lines.slice(fmEnd + 1).join('\n').replace(/^\s+/, '');
  return {
    frontmatter: parsed as SkillFrontmatter,
    body,
  };
}
