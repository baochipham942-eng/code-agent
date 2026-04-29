import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findDesignMd,
  readDesignMdSummary,
  summarizeDesignMd,
} from '../design-md-loader';

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'design-md-loader-'));
  tmpDirs.push(dir);
  return dir;
}

describe('design-md-loader', () => {
  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it('finds DESIGN.md in the cwd root only', () => {
    const dir = makeTmpDir();
    writeFileSync(path.join(dir, 'DESIGN.md'), '# Principles\nUse quiet UI.', 'utf-8');

    expect(findDesignMd(dir)).toBe(path.join(dir, 'DESIGN.md'));
    expect(readDesignMdSummary(dir)).toContain('DESIGN.md:');
    expect(readDesignMdSummary(dir)).toContain('Principles');
  });

  it('returns null when DESIGN.md is missing', () => {
    const dir = makeTmpDir();
    mkdirSync(path.join(dir, 'nested'));
    writeFileSync(path.join(dir, 'nested', 'DESIGN.md'), '# Nested', 'utf-8');

    expect(findDesignMd(dir)).toBeNull();
  });

  it('returns an empty summary for an empty file', () => {
    expect(summarizeDesignMd('   \n')).toBe('');
  });

  it('summarizes frontmatter, first heading, and the opening body text', () => {
    const summary = summarizeDesignMd([
      '---',
      'title: Admin Console',
      'tone: work-focused',
      '---',
      '# Product Design',
      'Keep density high, use restrained color, and make repeated operator workflows easy to scan.',
    ].join('\n'));

    expect(summary).toContain('frontmatter: title: Admin Console; tone: work-focused');
    expect(summary).toContain('heading: Product Design');
    expect(summary).toContain('excerpt: Keep density high');
  });
});
