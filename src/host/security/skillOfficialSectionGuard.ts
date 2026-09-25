import path from 'node:path';

export const OFFICIAL_SKILL_SECTION_BEGIN = '<!-- NEO:OFFICIAL-SKILL:BEGIN -->';
export const OFFICIAL_SKILL_SECTION_END = '<!-- NEO:OFFICIAL-SKILL:END -->';
export const OFFICIAL_SKILL_SECTION_BLOCKED_CODE = 'OFFICIAL_SKILL_SECTION_PROTECTED';
const OFFICIAL_SKILL_SECTION_INVALID_CODE = 'OFFICIAL_SKILL_SECTION_INVALID';

interface ParsedOfficialSections {
  blocks: string[];
  error?: string;
}

export interface SkillOfficialSectionGuardResult {
  allowed: boolean;
  error?: string;
  code?: typeof OFFICIAL_SKILL_SECTION_BLOCKED_CODE;
}

export function materializeOfficialSkillSection(content: string): string {
  const normalized = normalizeLineEndings(content);
  const parsed = parseOfficialSections(normalized);
  if (parsed.error) {
    throw new Error(`${OFFICIAL_SKILL_SECTION_INVALID_CODE}: ${parsed.error}`);
  }
  if (parsed.blocks.length > 0) return normalized;

  const frontmatter = normalized.match(/^---\n[\s\S]*?\n---(?:\n|$)/)?.[0] ?? '';
  const body = normalized.slice(frontmatter.length);
  const prefix = frontmatter || '';
  const separator = prefix && !prefix.endsWith('\n') ? '\n' : '';
  const bodyWithEnd = body.endsWith('\n') ? body : `${body}\n`;
  return `${prefix}${separator}${OFFICIAL_SKILL_SECTION_BEGIN}\n${bodyWithEnd}${OFFICIAL_SKILL_SECTION_END}\n`;
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

function parseOfficialSections(content: string): ParsedOfficialSections {
  const normalized = normalizeLineEndings(content);
  const lines = normalized.split('\n');
  const blocks: string[] = [];
  let startLine = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const marker = lines[index].trim();
    if (marker === OFFICIAL_SKILL_SECTION_BEGIN) {
      if (startLine !== -1) {
        return { blocks: [], error: 'official skill section markers cannot be nested' };
      }
      startLine = index;
      continue;
    }
    if (marker === OFFICIAL_SKILL_SECTION_END) {
      if (startLine === -1) {
        return { blocks: [], error: 'official skill section end marker has no matching begin marker' };
      }
      blocks.push(lines.slice(startLine, index + 1).join('\n'));
      startLine = -1;
    }
  }

  if (startLine !== -1) {
    return { blocks: [], error: 'official skill section begin marker has no matching end marker' };
  }
  return { blocks };
}

export function hasOfficialSkillSections(content: string): boolean {
  const parsed = parseOfficialSections(content);
  return parsed.blocks.length > 0
    || content.includes(OFFICIAL_SKILL_SECTION_BEGIN)
    || content.includes(OFFICIAL_SKILL_SECTION_END);
}

function blocked(error: string): SkillOfficialSectionGuardResult {
  return {
    allowed: false,
    error,
    code: OFFICIAL_SKILL_SECTION_BLOCKED_CODE,
  };
}

/**
 * Protect product-owned sections in a SKILL.md while allowing durable notes
 * after the end marker. The exact original block must survive every rewrite.
 */
export function guardSkillOfficialSections(
  filePath: string,
  originalContent: string | undefined,
  nextContent: string,
): SkillOfficialSectionGuardResult {
  if (path.basename(filePath) !== 'SKILL.md') return { allowed: true };

  const next = parseOfficialSections(nextContent);
  if (next.error) return blocked(`SKILL.md official section is malformed: ${next.error}`);

  if (originalContent === undefined) return { allowed: true };

  const original = parseOfficialSections(originalContent);
  if (original.error) return blocked(`SKILL.md official section is malformed: ${original.error}`);
  if (original.blocks.length === 0) return { allowed: true };

  if (next.blocks.length !== original.blocks.length) {
    return blocked('SKILL.md official sections must be preserved exactly; only content outside them may change.');
  }
  for (let index = 0; index < original.blocks.length; index += 1) {
    if (next.blocks[index] !== original.blocks[index]) {
      return blocked('SKILL.md official sections must be preserved exactly; only content outside them may change.');
    }
  }
  return { allowed: true };
}
