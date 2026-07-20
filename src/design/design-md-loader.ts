import { existsSync, readFileSync } from 'fs';
import path from 'path';

const DESIGN_MD = 'DESIGN.md';
const MAX_EXCERPT_CHARS = 200;

export function findDesignMd(cwd: string): string | null {
  if (!cwd || typeof cwd !== 'string') {
    return null;
  }
  const filePath = path.join(cwd, DESIGN_MD);
  return existsSync(filePath) ? filePath : null;
}

export function readDesignMdSummary(cwd: string): string | null {
  const filePath = findDesignMd(cwd);
  if (!filePath) {
    return null;
  }
  try {
    const summary = getDesignMdSummary(readFileSync(filePath, 'utf-8'));
    return summary ? `${DESIGN_MD}: ${summary}` : null;
  } catch {
    return null;
  }
}

export function getDesignMdSummary(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return '';
  }

  const frontmatter = extractFrontmatter(trimmed);
  const withoutFrontmatter = frontmatter
    ? trimmed.slice(frontmatter.endIndex).trim()
    : trimmed;
  const heading = withoutFrontmatter.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
  const excerptSource = withoutFrontmatter
    .replace(/^#{1,6}\s+.+$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const excerpt = excerptSource.slice(0, MAX_EXCERPT_CHARS);

  const parts = [
    frontmatter?.summary,
    heading ? `heading: ${heading}` : undefined,
    excerpt ? `excerpt: ${excerpt}` : undefined,
  ].filter((part): part is string => Boolean(part));

  return parts.join(' | ');
}

function extractFrontmatter(content: string): { summary: string; endIndex: number } | null {
  if (!content.startsWith('---')) {
    return null;
  }

  const endMatch = content.slice(3).match(/\n---\s*(\n|$)/);
  if (endMatch?.index === undefined) {
    return null;
  }

  const bodyStart = 3;
  const bodyEnd = bodyStart + endMatch.index;
  const body = content.slice(bodyStart, bodyEnd).trim();
  const summary = body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join('; ');

  return {
    summary: summary ? `frontmatter: ${summary}` : '',
    endIndex: bodyEnd + endMatch[0].length,
  };
}
