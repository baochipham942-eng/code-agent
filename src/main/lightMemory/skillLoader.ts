// ============================================================================
// Light Memory — Skill Loader (Workstream B)
// ============================================================================
// 对标 Hermes 四层记忆的 Procedural layer:
// 从 ~/.code-agent/memory/skill_*.md 读"可复用流程"，基于用户查询做关键词匹配，
// 把 top N 条注入 system prompt 的 dynamic section。
//
// 设计原则：
// - 读取是纯文件操作，不依赖向量 / embedding
// - 匹配用简单 token overlap，避免引入额外依赖
// - 注入总字符数硬性封顶，避免 token 失控
// - skill 写入走用户自主调用 MemoryWrite(type=skill)，暂不做自动蒸馏
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';
import { MEMORY } from '../../shared/constants';
import { getMemoryDir } from './indexLoader';

const logger = createLogger('SkillLoader');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface SkillMemory {
  /** Filename (e.g., skill_deploy_tauri.md) */
  filename: string;
  /** frontmatter.name */
  name: string;
  /** frontmatter.description — 同时作为关键词匹配源 */
  description: string;
  /** Markdown body (after frontmatter) */
  body: string;
  /** 匹配分数（命中的用户 token 数） */
  matchScore: number;
}

// ----------------------------------------------------------------------------
// Frontmatter parser (minimal, no yaml dep)
// ----------------------------------------------------------------------------

interface ParsedMemory {
  name: string;
  description: string;
  type: string;
  body: string;
}

function parseMemoryFile(content: string): ParsedMemory | null {
  // Expect: ---\nkey: value\n...\n---\n\nbody
  if (!content.startsWith('---')) return null;
  const endIndex = content.indexOf('\n---', 3);
  if (endIndex === -1) return null;

  const frontmatterText = content.slice(3, endIndex).trim();
  const body = content.slice(endIndex + 4).trim();

  const fields: Record<string, string> = {};
  for (const line of frontmatterText.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fields[key] = value;
  }

  if (!fields.name || !fields.type) return null;

  return {
    name: fields.name,
    description: fields.description || '',
    type: fields.type,
    body,
  };
}

// ----------------------------------------------------------------------------
// Tokenization (whitespace + CJK char-level)
// ----------------------------------------------------------------------------

/**
 * 把查询切成 token 集合。策略：
 * - 先按空格/标点切
 * - 每段若是 ASCII 就整段当一个 token（lowercase）
 * - 若含 CJK 字符，额外生成所有 3-gram（与 FTS trigram 对齐，支持中文匹配）
 *
 * 去除太短的 token（< 3 chars）避免 "a"、"是" 这类无意义命中。
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const parts = text.toLowerCase().split(/[\s,.;:!?()[\]{}"'`<>/\\+=*&|~@#$%^]+/);

  for (const part of parts) {
    if (part.length < 3) continue;
    if (/^[\x00-\x7f]+$/.test(part)) {
      // 纯 ASCII token — 整段保留
      tokens.add(part);
    } else {
      // 含 CJK — 生成 3-gram 子串
      for (let i = 0; i <= part.length - 3; i++) {
        tokens.add(part.slice(i, i + 3));
      }
      // 原始整段也加入，便于完整短语命中
      if (part.length <= 20) {
        tokens.add(part);
      }
    }
  }

  return tokens;
}

function countOverlap(queryTokens: Set<string>, skillTokens: Set<string>): number {
  let hits = 0;
  for (const t of queryTokens) {
    if (skillTokens.has(t)) hits++;
  }
  return hits;
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * 读取所有 skill_*.md 文件，根据用户查询做关键词匹配，
 * 返回 top N 条最相关的 skill，总字符数受 MEMORY.SKILL_MAX_INJECTION_CHARS 约束。
 *
 * 当 userQuery 为空或 token 少于阈值时返回空数组（避免把所有 skill 都拽进来）。
 */
export async function loadRelevantSkills(userQuery: string): Promise<SkillMemory[]> {
  const queryTokens = tokenize(userQuery || '');
  if (queryTokens.size < MEMORY.SKILL_MIN_QUERY_TOKENS) {
    return [];
  }

  const memDir = getMemoryDir();
  let entries: string[];
  try {
    entries = await fs.readdir(memDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    logger.warn('Failed to read memory dir', { err });
    return [];
  }

  const skillFiles = entries.filter((f) => f.startsWith('skill_') && f.endsWith('.md'));
  if (skillFiles.length === 0) return [];

  const candidates: SkillMemory[] = [];
  for (const filename of skillFiles) {
    try {
      const content = await fs.readFile(path.join(memDir, filename), 'utf-8');
      const parsed = parseMemoryFile(content);
      if (!parsed || parsed.type !== 'skill') continue;

      // 只匹配 name + description — body 是实现细节，不应贡献召回分数，
      // 否则"npm run build" 这类样板代码会被 "run" 之类的查询误命中
      const matchSource = [parsed.name, parsed.description].join(' ');
      const skillTokens = tokenize(matchSource);
      const score = countOverlap(queryTokens, skillTokens);

      if (score > 0) {
        candidates.push({
          filename,
          name: parsed.name,
          description: parsed.description,
          body: parsed.body,
          matchScore: score,
        });
      }
    } catch (err) {
      logger.debug('Skipping unreadable skill file', { filename, err });
    }
  }

  // Rank by match score (desc)，tie-break by filename for determinism
  candidates.sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    return a.filename.localeCompare(b.filename);
  });

  // Cap by count + total chars
  const selected: SkillMemory[] = [];
  let totalChars = 0;
  for (const c of candidates) {
    if (selected.length >= MEMORY.SKILL_MAX_INJECTION_COUNT) break;
    const cost = estimateCharCost(c);
    if (totalChars + cost > MEMORY.SKILL_MAX_INJECTION_CHARS) break;
    selected.push(c);
    totalChars += cost;
  }

  if (selected.length > 0) {
    logger.debug(
      `[SkillLoader] Selected ${selected.length}/${candidates.length} skills, ~${totalChars} chars`,
    );
  }

  return selected;
}

/**
 * 构造注入 system prompt 的 XML 块。
 * 返回 null 表示没有相关 skill 可注入。
 */
export function buildSkillInjectionBlock(skills: SkillMemory[]): string | null {
  if (skills.length === 0) return null;

  const sections = skills.map((s) => {
    return `### ${s.name}\n${s.description}\n\n${s.body}`;
  });

  return `<relevant_skills>
Past procedures that may apply to the current task. Consult before planning:

${sections.join('\n\n---\n\n')}
</relevant_skills>`;
}

// ----------------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------------

/** 估算一个 skill 注入到 prompt 后的字符数（含 heading 和分隔符） */
function estimateCharCost(skill: SkillMemory): number {
  return skill.name.length + skill.description.length + skill.body.length + 20;
}
