import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { enumerateCaseBank, saveCaseBank } from '../../../src/host/testing/caseBank';
import { filterTestCases, loadAllTestSuites, loadTestSuite } from '../../../src/host/testing/testCaseLoader';

async function makeRepo(): Promise<{ root: string; bank: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'case-bank-'));
  const bank = path.join(root, '.claude', 'test-cases');
  await fs.mkdir(bank, { recursive: true });
  return { root, bank };
}

function suite(id: string, options: { suiteTags?: string[]; caseTags?: string[]; expect?: string } = {}): string {
  const suiteTags = options.suiteTags?.map((tag) => `  - ${tag}`).join('\n');
  const caseTags = options.caseTags?.map((tag) => `      - ${tag}`).join('\n');
  return [
    `name: ${id}-suite`,
    ...(suiteTags ? ['tags:', suiteTags] : []),
    'cases:',
    `  - id: ${id}`,
    '    type: task',
    `    description: ${id}`,
    `    prompt: ${id} prompt`,
    ...(caseTags ? ['    tags:', caseTags] : []),
    ...(options.expect === '{}' ? ['    expect: {}'] : ['    expect:', options.expect ?? '      response_contains: [ok]']),
    '',
  ].join('\n');
}

describe('case bank enumeration and YAML writes', () => {
  it('递归列出默认题、专项题、草稿和坏 YAML，并反查评测集', async () => {
    const { root, bank } = await makeRepo();
    await fs.writeFile(path.join(bank, '01-one.yaml'), suite('root-one'));
    await fs.writeFile(path.join(bank, '02-two.yaml'), suite('root-two'));
    await fs.mkdir(path.join(bank, 'artifact-runnable'), { recursive: true });
    await fs.writeFile(path.join(bank, 'artifact-runnable', 'special.yaml'), suite('special-one'));
    await fs.mkdir(path.join(bank, 'drafts'), { recursive: true });
    await fs.writeFile(path.join(bank, 'drafts', 'draft.yaml'), suite('draft-one', { expect: '{}' }));
    await fs.writeFile(path.join(bank, 'broken.yaml'), 'name: broken\ncases: [\n');
    await fs.writeFile(path.join(root, '.claude', 'eval-splits.json'), JSON.stringify({
      version: 1,
      seed: 'test',
      createdAt: '2026-08-29',
      heldIn: ['root-one'],
      heldOut: ['root-two'],
      control: ['root-one'],
      safety: [],
    }));

    const items = await enumerateCaseBank(root, '2026-08-29');

    expect(items).toHaveLength(5);
    expect(items.find((item) => item.id === 'draft-one')).toMatchObject({ isDraft: true, hasExpect: false });
    expect(items.find((item) => item.id === 'special-one')).toMatchObject({
      relativeDir: 'artifact-runnable',
      isDraft: false,
    });
    expect(items.find((item) => item.id === 'root-one')).toMatchObject({
      splits: ['held-in', 'control'],
    });
    expect(items.find((item) => 'parseError' in item)).toMatchObject({ id: 'broken.yaml' });
  });

  it('suite 标签只进入 inheritedTags，case 标签筛选不匹配继承标签', async () => {
    const { bank } = await makeRepo();
    const file = path.join(bank, '01-tags.yaml');
    await fs.writeFile(file, suite('tagged', { suiteTags: ['suite-tag'], caseTags: ['case-tag'] }));

    const loaded = await loadTestSuite(file);
    expect(loaded.cases[0].tags).toEqual(['case-tag']);
    expect(loaded.cases[0].inheritedTags).toEqual(['suite-tag']);
    expect(filterTestCases(loaded ? [loaded] : [], { filterTags: ['suite-tag'] })).toEqual([]);
    expect(filterTestCases([loaded], { filterTags: ['case-tag'] }).map((item) => item.id)).toEqual(['tagged']);
  });

  it('归档只给目标 case 增加 rotation 两行并保留原注释与顺序', async () => {
    const { root, bank } = await makeRepo();
    const file = path.join(bank, '01-archive.yaml');
    const before = [
      '# header comment',
      'name: archive-suite',
      'cases:',
      '  - id: archive-me',
      '    type: task',
      '    description: archive me',
      '    prompt: archive prompt',
      '    # expectation comment',
      '    expect:',
      '      response_contains: [ok]',
      '',
    ].join('\n');
    await fs.writeFile(file, before);

    await saveCaseBank(root, { action: 'archive', id: 'archive-me' }, '2026-08-29');
    const after = await fs.readFile(file, 'utf8');
    const withoutRotation = after.split('\n').filter((line) => !line.includes('rotation:') && !line.includes('retire_after:')).join('\n');

    expect(withoutRotation).toBe(before);
    expect(after).toContain('    rotation:\n      retire_after: 2026-08-29');
    await expect(enumerateCaseBank(root, '2026-08-29')).resolves.toEqual([
      expect.objectContaining({ id: 'archive-me', retired: true }),
    ]);
  });

  it('草稿只写 drafts，拒绝路径穿越和全题库 id 冲突，默认 loader 不加载', async () => {
    const { root, bank } = await makeRepo();
    await fs.writeFile(path.join(bank, '01-existing.yaml'), suite('existing-id'));

    const result = await saveCaseBank(root, {
      action: 'create-draft',
      id: 'draft-report',
      prompt: '生成报告',
      tags: ['report', 'report'],
    }, '2026-08-29');

    expect(result.file).toBe('drafts/draft-report.yaml');
    const draft = await fs.readFile(path.join(bank, result.file), 'utf8');
    expect(draft).toContain('reviewStatus: pending');
    expect(draft).toContain('expect: {}');
    expect(draft).toContain('introduced: 2026-08-29');
    await expect(saveCaseBank(root, {
      action: 'create-draft',
      id: '../escape',
      prompt: 'escape',
      tags: [],
    }, '2026-08-29')).rejects.toThrow(/只能包含/);
    await expect(saveCaseBank(root, {
      action: 'create-draft',
      id: 'existing-id',
      prompt: 'duplicate',
      tags: [],
    }, '2026-08-29')).rejects.toThrow(/已存在/);

    const defaultSuites = await loadAllTestSuites(bank);
    expect(defaultSuites.flatMap((item) => item.cases).map((item) => item.id)).toEqual(['existing-id']);
  });
});
