import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RegressionCase } from './regressionTypes';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

export async function loadCase(filePath: string): Promise<RegressionCase> {
  const raw = await fs.readFile(filePath, 'utf8');
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    throw new Error(`Case ${filePath} is missing YAML frontmatter`);
  }
  const [, fmText, body] = match;
  const fm = parseFrontmatter(fmText);

  if (!fm.eval_command) {
    throw new Error(`Case ${filePath} is missing required field: eval_command`);
  }

  return {
    id: String(fm.id ?? path.basename(filePath, '.md')),
    filePath,
    source: String(fm.source ?? ''),
    tags: toStringArray(fm.tags),
    categories: fm.categories ? toStringArray(fm.categories) : undefined,
    relatedRules: toStringArray(fm.related_rules),
    evalCommand: String(fm.eval_command),
    scenario: extractSection(body, '场景'),
    expectedBehavior: extractSection(body, '预期行为'),
  };
}

export async function loadAllCases(dir: string): Promise<RegressionCase[]> {
  const entries = await fs.readdir(dir);
  const caseFiles = entries
    .filter((f) => f.startsWith('reg-') && f.endsWith('.md'))
    .map((f) => path.join(dir, f));
  const cases = await Promise.all(caseFiles.map(loadCase));
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

function parseFrontmatter(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawVal] = m;
    out[key] = parseValue(rawVal.trim());
  }
  return out;
}

function parseValue(raw: string): unknown {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
  }
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v) return [v];
  return [];
}

function extractSection(body: string, heading: string): string {
  const re = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`);
  const m = re.exec(body);
  return m ? m[1].trim() : '';
}
