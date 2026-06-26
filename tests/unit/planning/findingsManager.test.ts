import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { FindingsManager } from '../../../src/host/planning/findingsManager';
import { CONFIG_DIR_NEW } from '../../../src/host/config/configPaths';
import type { Finding, PlanningConfig } from '../../../src/host/planning/types';

let workingDirectory: string;
const SESSION_ID = 'sess-find';

const makeConfig = (): PlanningConfig => ({ workingDirectory, sessionId: SESSION_ID });

const findingsFile = () =>
  path.join(workingDirectory, CONFIG_DIR_NEW, 'plans', SESSION_ID, 'findings.md');

type NewFinding = Omit<Finding, 'id' | 'timestamp'>;
const code = (over: Partial<NewFinding> = {}): NewFinding => ({
  category: 'code',
  title: 'Title',
  content: 'Content',
  ...over,
});

beforeEach(async () => {
  workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'findings-'));
});

afterEach(async () => {
  await fs.rm(workingDirectory, { recursive: true, force: true });
});

describe('FindingsManager.add', () => {
  it('assigns an id + timestamp and persists to disk', async () => {
    const mgr = new FindingsManager(makeConfig());
    const finding = await mgr.add(code({ title: 'First' }));

    expect(finding.id).toMatch(/^find-/);
    expect(typeof finding.timestamp).toBe('number');
    expect(await mgr.getCount()).toBe(1);

    const md = await fs.readFile(findingsFile(), 'utf-8');
    expect(md).toContain('FINDINGS_JSON');
    expect(md).toContain('First');
  });
});

describe('FindingsManager.getByCategory + search', () => {
  it('filters findings by category', async () => {
    const mgr = new FindingsManager(makeConfig());
    await mgr.add(code({ category: 'code', title: 'c' }));
    await mgr.add(code({ category: 'architecture', title: 'a' }));

    const archi = await mgr.getByCategory('architecture');
    expect(archi).toHaveLength(1);
    expect(archi[0].title).toBe('a');
  });

  it('search matches title or content case-insensitively', async () => {
    const mgr = new FindingsManager(makeConfig());
    await mgr.add(code({ title: 'Caching Layer', content: 'uses redis' }));
    await mgr.add(code({ title: 'Auth', content: 'uses JWT tokens' }));

    expect((await mgr.search('CACHING')).map((f) => f.title)).toEqual(['Caching Layer']);
    expect((await mgr.search('jwt')).map((f) => f.title)).toEqual(['Auth']);
    expect(await mgr.search('nonexistent')).toEqual([]);
  });
});

describe('FindingsManager.getSummary', () => {
  it('returns empty string when there are no findings', async () => {
    const mgr = new FindingsManager(makeConfig());
    expect(await mgr.getSummary()).toBe('');
  });

  it('groups by category with friendly labels and caps to the newest per category', async () => {
    // Distinct increasing timestamps so "most recent" is deterministic.
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      const mgr = new FindingsManager(makeConfig());
      nowSpy.mockReturnValue(1000);
      await mgr.add(code({ category: 'issue', title: 'Bug A' }));
      nowSpy.mockReturnValue(2000);
      await mgr.add(code({ category: 'issue', title: 'Bug B' }));
      nowSpy.mockReturnValue(3000);
      await mgr.add(code({ category: 'issue', title: 'Bug C' }));
      nowSpy.mockReturnValue(4000);
      await mgr.add(code({ category: 'issue', title: 'Bug D' }));

      const summary = await mgr.getSummary(2);
      expect(summary).toContain('<findings-summary>');
      expect(summary).toContain('Total findings: 4');
      expect(summary).toContain('**Issues Found:**');
      // The 2 newest issues are kept; the 2 oldest are dropped.
      expect(summary).toContain('Bug D');
      expect(summary).toContain('Bug C');
      expect(summary).not.toContain('Bug A');
      expect(summary).not.toContain('Bug B');
      const bulletCount = (summary.match(/^- /gm) ?? []).length;
      expect(bulletCount).toBe(2);
      expect(summary).toContain('</findings-summary>');
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('FindingsManager.delete + clear', () => {
  it('delete removes a finding by id and returns true', async () => {
    const mgr = new FindingsManager(makeConfig());
    const f = await mgr.add(code());
    expect(await mgr.delete(f.id)).toBe(true);
    expect(await mgr.getCount()).toBe(0);
  });

  it('delete returns false for an unknown id', async () => {
    const mgr = new FindingsManager(makeConfig());
    await mgr.add(code());
    expect(await mgr.delete('find-nope')).toBe(false);
    expect(await mgr.getCount()).toBe(1);
  });

  it('clear empties all findings and writes the placeholder markdown', async () => {
    const mgr = new FindingsManager(makeConfig());
    await mgr.add(code());
    await mgr.clear();
    expect(await mgr.getAll()).toEqual([]);
    const md = await fs.readFile(findingsFile(), 'utf-8');
    expect(md).toContain('No findings recorded yet');
  });
});

describe('FindingsManager persistence', () => {
  it('reloads findings from disk in a fresh instance', async () => {
    const first = new FindingsManager(makeConfig());
    await first.add(code({ title: 'Kept', source: 'src/foo.ts' }));

    const second = new FindingsManager(makeConfig());
    const all = await second.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('Kept');
    expect(all[0].source).toBe('src/foo.ts');
  });

  it('renders the source line in markdown when present', async () => {
    const mgr = new FindingsManager(makeConfig());
    await mgr.add(code({ source: 'src/bar.ts' }));
    const md = await fs.readFile(findingsFile(), 'utf-8');
    expect(md).toContain('Source: `src/bar.ts`');
  });

  it('starts fresh when no file exists', async () => {
    const mgr = new FindingsManager(makeConfig());
    expect(await mgr.getAll()).toEqual([]);
  });

  it('falls back to empty when persisted JSON is corrupt', async () => {
    await fs.mkdir(path.dirname(findingsFile()), { recursive: true });
    await fs.writeFile(findingsFile(), '<!-- FINDINGS_JSON: {bad -->', 'utf-8');
    const mgr = new FindingsManager(makeConfig());
    expect(await mgr.getAll()).toEqual([]);
  });

  it('getAll returns a copy, not the internal array', async () => {
    const mgr = new FindingsManager(makeConfig());
    await mgr.add(code());
    const a = await mgr.getAll();
    a.push({} as Finding);
    expect(await mgr.getCount()).toBe(1);
  });
});
