// ============================================================================
// instructionRuleSplit — 用户级说明文件（AGENTS.md / CLAUDE.md 等）的确定性拆条
// （N-EXTHISTORY-IMPORT-K1A-FU1）
// ============================================================================
//
// 拆条规则（无模型调用，同输入必得同输出——confirm 路径会重跑 discovery 并按
// 内容 hash 找回条目，非确定性 = 找不回）：
//   - YAML frontmatter 与围栏代码块整段剔除，不产规则；
//   - 标题行只是上下文，不产规则；
//   - 列表项（- / * / + / 1. / 1)）与单句各自成一条规则；
//   - 超过单条注入上限的条目按句读 / 分句标点再拆，仍超的截断加省略号——
//     预览展示的就是真正会被存下并注入的那一行；
//   - 空行与去空白后的重复条目丢弃。

import { SEED_INJECTION } from '../../../shared/constants';

/** 句末标点（CJK 全角直接断句；西文句点等要求后随空白，避免切断 3.14 / URL） */
const CJK_SENTENCE_ENDERS = '。！？；…';
const WESTERN_SENTENCE_ENDERS = '.!?;:';

/** 分句标点：句内再拆用（条目仍超上限时的次级切点） */
const CJK_CLAUSE_MARKS = '，、：';
const WESTERN_CLAUSE_MARKS = ',';

function isSentenceBoundary(text: string, index: number): boolean {
  const ch = text[index] as string;
  if (CJK_SENTENCE_ENDERS.includes(ch)) return true;
  if (WESTERN_SENTENCE_ENDERS.includes(ch)) {
    const next = text[index + 1];
    return next === undefined || /\s/.test(next);
  }
  return false;
}

/** 按句末标点切段，标点保留在段尾 */
function splitSentences(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (isSentenceBoundary(text, i)) {
      parts.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

/** 按分句标点切段，标点保留在段尾 */
function splitClauses(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (CJK_CLAUSE_MARKS.includes(ch) || WESTERN_CLAUSE_MARKS.includes(ch)) {
      parts.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

/** 截断到上限并加省略号——预览里看到的即真正会入库的那一行 */
function truncateWithEllipsis(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3).trimEnd()}...`;
}

/**
 * 一个文本单元 → 规则条目。段落按单句成条；列表项是原子条目（用户写下的
 * 一项就是一条规则），只有超过单条上限时才按句读 / 分句拆开。
 */
function toRules(text: string, atomic: boolean): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (atomic && trimmed.length <= SEED_INJECTION.PER_ITEM_CHARS) return [trimmed];
  const rules: string[] = [];
  for (const sentence of splitSentences(trimmed)) {
    const piece = sentence.trim();
    if (!piece) continue;
    if (piece.length <= SEED_INJECTION.PER_ITEM_CHARS) {
      rules.push(piece);
      continue;
    }
    for (const clause of splitClauses(piece)) {
      rules.push(truncateWithEllipsis(clause.trim(), SEED_INJECTION.PER_ITEM_CHARS));
    }
  }
  return rules;
}

/** 剔除 YAML frontmatter（与 markdown.ts 的解析口径一致） */
function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/** 逐行剔除围栏代码块（``` 或 ~~~；未闭合的栅栏剔到文件尾） */
function stripCodeFences(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const match = line.match(/^\s*(```|~~~)/);
    if (fence) {
      if (match?.[1] === fence) fence = null;
      continue;
    }
    if (match) {
      fence = match[1] as string;
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

interface RuleUnit {
  text: string;
  /** 列表项 = 原子条目；段落 = 按单句成条 */
  atomic: boolean;
}

/** 段落 / 列表项归一：多行软换行并成一段，列表标记与引用标记剥掉 */
function collectUnits(raw: string): RuleUnit[] {
  const units: RuleUnit[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) {
      units.push({ text: paragraph.join(' '), atomic: false });
      paragraph = [];
    }
  };
  for (const line of raw.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped) {
      flush();
      continue;
    }
    if (/^#{1,6}\s/.test(stripped)) {
      // 标题行只是上下文，不产规则，也不并入相邻段落
      flush();
      continue;
    }
    const listItem = stripped.match(/^(?:[-*+]|\d{1,3}[.)])\s+(.*)$/);
    if (listItem) {
      // 列表项各自成条，不与前后段落合并
      flush();
      units.push({ text: listItem[1] as string, atomic: true });
      continue;
    }
    const quoted = stripped.replace(/^>\s?/, '');
    paragraph.push(quoted);
  }
  flush();
  return units;
}

/**
 * 把用户级说明文件正文拆成单条规则。纯函数、零模型调用：
 *   - 输出每条 ≤ SEED_INJECTION.PER_ITEM_CHARS；
 *   - 同一输入两次调用结果完全一致；
 *   - 拆不出规则（纯标题 / 纯代码块 / 空文件）返回 []。
 */
export function splitInstructionRules(raw: string): string[] {
  const body = stripCodeFences(stripFrontmatter(raw));
  const rules: string[] = [];
  const seen = new Set<string>();
  for (const unit of collectUnits(body)) {
    for (const rule of toRules(unit.text, unit.atomic)) {
      const normalized = rule.replace(/\s+/g, ' ').trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      rules.push(normalized);
    }
  }
  return rules;
}
