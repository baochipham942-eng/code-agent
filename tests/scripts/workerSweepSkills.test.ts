import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');

const skills = [
  {
    directory: 'cross-layer-drift-sweep',
    headings: [
      '## Change axes and blind spots',
      '## Sweep both expressions',
      '## Verify at the observable layer',
    ],
  },
  {
    directory: 'verify-all-runtime-sinks',
    headings: ['## Consumer table', '## Status rules', '## Completion claim'],
  },
] as const;

function parseFrontmatter(source: string): Map<string, string> {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/u);
  expect(match, 'skill must start with YAML frontmatter').not.toBeNull();

  const fields = new Map<string, string>();
  for (const line of match?.[1].split('\n') ?? []) {
    const field = line.match(/^([A-Za-z][\w-]*):\s*(.+)$/u);
    if (field) fields.set(field[1], field[2].trim());
  }
  return fields;
}

function relativeReferences(source: string): string[] {
  const references = new Set<string>();

  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
    const target = match[1].trim();
    if (!/^(?:[a-z][a-z\d+.-]*:|#)/iu.test(target)) references.add(target);
  }

  for (const match of source.matchAll(/`([^`\n]+)`/gu)) {
    const token = match[1].trim();
    if (/^(?:\.\.?(?:\/|$)|\.claude\/|[A-Za-z0-9_.-]+\/)/u.test(token)) {
      references.add(token.replace(/[.,;:]$/u, ''));
    }
  }

  return [...references];
}

function resolveReference(reference: string, skillPath: string): string {
  if (reference.startsWith('./') || reference.startsWith('../')) {
    return path.resolve(path.dirname(skillPath), reference);
  }
  return path.resolve(repoRoot, reference);
}

describe('worker sweep skills', () => {
  for (const skill of skills) {
    it(`${skill.directory} has the required structure and resolvable references`, () => {
      const skillPath = path.join(repoRoot, '.claude', 'skills', skill.directory, 'SKILL.md');
      expect(fs.existsSync(skillPath)).toBe(true);

      const source = fs.readFileSync(skillPath, 'utf8');
      const frontmatter = parseFrontmatter(source);
      expect(frontmatter.get('name')).toBe(skill.directory);
      expect(frontmatter.get('description')).toBeTruthy();

      for (const heading of skill.headings) {
        expect(source).toMatch(new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'mu'));
      }
      for (const reference of relativeReferences(source)) {
        expect(fs.existsSync(resolveReference(reference, skillPath)), reference).toBe(true);
      }

      if (skill.directory === 'verify-all-runtime-sinks') {
        expect(source).toContain('covered');
        expect(source).toContain('not-applicable');
        expect(source).toContain('unknown');
        expect(source).toContain('If any row is unknown, you may not claim the verification is complete.');
      }
    });
  }
});
