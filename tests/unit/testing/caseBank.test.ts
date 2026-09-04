import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { enumerateCaseBank, saveCaseBank } from '@internal-evaluation/host/testing/caseBank';
import { buildDraftYaml } from '@internal-evaluation/host/evaluation/trajectoryToCase';
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
    expect(items.find((item) => item.id === 'draft-one')).toMatchObject({
      isDraft: true,
      hasExpect: false,
      hardened: false,
    });
    expect(items.find((item) => item.id === 'special-one')).toMatchObject({
      relativeDir: 'artifact-runnable',
      isDraft: false,
    });
    expect(items.find((item) => item.id === 'root-one')).toMatchObject({
      splits: ['held-in', 'control'],
      hardened: true,
    });
    expect(items.find((item) => 'parseError' in item)).toMatchObject({ id: 'broken.yaml' });
  });

  it('suite 标签单独进入 inheritedTags，同时保留基线的标签筛选命中语义', async () => {
    const { bank } = await makeRepo();
    const file = path.join(bank, '01-tags.yaml');
    await fs.writeFile(file, suite('tagged', { suiteTags: ['suite-tag'], caseTags: ['case-tag'] }));

    const loaded = await loadTestSuite(file);
    expect(loaded.cases[0].tags).toEqual(['case-tag']);
    expect(loaded.cases[0].inheritedTags).toEqual(['suite-tag']);
    const baselineExpectedIds = ['tagged'];
    expect(filterTestCases([loaded], { filterTags: ['suite-tag'] }).map((item) => item.id)).toEqual(baselineExpectedIds);
    expect(filterTestCases([loaded], { filterTags: ['case-tag'] }).map((item) => item.id)).toEqual(['tagged']);
  });

  it('退休日前保留、到期后默认跳过，并可显式放回历史题', async () => {
    const { bank } = await makeRepo();
    const file = path.join(bank, '05-rotation.yaml');
    await fs.writeFile(file, [
      'name: rotation-suite',
      'cases:',
      '  - id: legacy-case',
      '    type: task',
      '    prompt: legacy prompt',
      '    expect:',
      '      no_crash: true',
      '    rotation:',
      "      retire_after: '2026-09-30'",
      "      reason: 'legacy-code-assistant-era'",
      '  - id: active-case',
      '    type: task',
      '    prompt: active prompt',
      '    expect:',
      '      no_crash: true',
      '',
    ].join('\n'));
    const loaded = await loadTestSuite(file);

    expect(filterTestCases([loaded], { today: '2026-09-29' }).map((item) => item.id))
      .toEqual(['legacy-case', 'active-case']);

    const retiredSkipped: string[] = [];
    expect(filterTestCases([loaded], { today: '2026-10-01', retiredSkipped }).map((item) => item.id))
      .toEqual(['active-case']);
    expect(retiredSkipped).toEqual(['legacy-case']);

    const replaySkipped: string[] = [];
    expect(filterTestCases([loaded], {
      today: '2026-10-01',
      includeRetired: true,
      retiredSkipped: replaySkipped,
    }).map((item) => item.id)).toEqual(['legacy-case', 'active-case']);
    expect(replaySkipped).toEqual([]);
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

    await saveCaseBank(root, { action: 'archive', id: 'archive-me' }, '2026-08-30');
    const rearchived = await fs.readFile(file, 'utf8');
    expect(rearchived).toContain('    rotation:\n      retire_after: 2026-08-30');
    expect(rearchived).not.toContain('retire_after: 2026-08-29');
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

describe('从会话转成题目的草稿落盘', () => {
  it('带已确认判定标准的草稿：expectations 原样落盘，来源与类型都在，仍是 pending', async () => {
    const { root, bank } = await makeRepo();

    const result = await saveCaseBank(root, {
      action: 'create-draft',
      id: 'draft-fake0001',
      prompt: '在工作目录里读 sales.csv，生成 out/summary.html',
      description: '生成销售报告',
      type: 'multi_step',
      tags: ['harvest-0904'],
      sourceSessionId: 'sess-fake-0001',
      expectations: [
        { type: 'file_exists', params: { path: 'out/summary.html' }, reason: '会话里写了 out/summary.html' },
        { type: 'tool_called', params: { tool: 'Write' }, reason: '会话里调用了 Write' },
      ],
    }, '2026-09-04');

    expect(result.file).toBe('drafts/draft-fake0001.yaml');
    const draft = await fs.readFile(path.join(bank, result.file), 'utf8');
    expect(draft).toContain('sourceSessionId: sess-fake-0001');
    expect(draft).toContain('type: multi_step');
    expect(draft).toContain('description: 生成销售报告');
    // 确认过判定标准也仍是 pending —— 硬化是人把文件移出 drafts/ 并改 reviewed。
    expect(draft).toContain('reviewStatus: pending');

    const suite = await loadTestSuite(path.join(bank, result.file), { requireHardened: false });
    expect(suite.cases[0].expectations).toEqual([
      { type: 'file_exists', description: '会话里写了 out/summary.html', params: { path: 'out/summary.html' } },
      { type: 'tool_called', description: '会话里调用了 Write', params: { tool: 'Write' } },
    ]);
    expect(suite.cases[0].sourceSessionId).toBe('sess-fake-0001');

    const items = await enumerateCaseBank(root, '2026-09-04');
    expect(items[0]).toMatchObject({ hasExpect: true, hardened: false, isDraft: true, source: 'session' });
  });

  it('存为待办：expect 为空且不写 expectations，题库页照旧标「还没有判定标准」', async () => {
    const { root } = await makeRepo();

    await saveCaseBank(root, {
      action: 'create-draft',
      id: 'draft-todo',
      prompt: '待补判定标准的题',
      tags: [],
      sourceSessionId: 'sess-fake-0002',
      pending: true,
      // 存为待办时前端即使误传了确认过的条目也一律不写入。
      expectations: [{ type: 'file_exists', params: { path: 'out/a.txt' }, reason: 'x' }],
    }, '2026-09-04');

    const items = await enumerateCaseBank(root, '2026-09-04');
    expect(items[0]).toMatchObject({ id: 'draft-todo', hasExpect: false, hardened: false });
  });

  it('判定标准的类型和参数不在白名单里一律拒收', async () => {
    const { root } = await makeRepo();
    const base = { action: 'create-draft' as const, id: 'draft-bad', prompt: 'x', tags: [] };

    await expect(saveCaseBank(root, {
      ...base,
      expectations: [{ type: 'custom_script' as never, params: { script: 'rm -rf /' }, reason: '' }],
    }, '2026-09-04')).rejects.toThrow(/不支持的判定标准类型/);

    await expect(saveCaseBank(root, {
      ...base,
      expectations: [{ type: 'file_exists', params: {}, reason: '' }],
    }, '2026-09-04')).rejects.toThrow(/缺少参数 path/);

    await expect(saveCaseBank(root, {
      ...base,
      expectations: [{ type: 'file_exists', params: { path: 'a.txt', timeout_ms: '1' }, reason: '' }],
    }, '2026-09-04')).rejects.toThrow(/多余参数/);
  });

  it('题面或描述含敏感内容一律拒存，给人话理由', async () => {
    const { root } = await makeRepo();

    await expect(saveCaseBank(root, {
      action: 'create-draft',
      id: 'draft-secret',
      prompt: '用这个跑一下：api_key=sk-abcdef1234567890',
      tags: [],
    }, '2026-09-04')).rejects.toThrow(/题目输入含敏感内容，先人工处理后再保存/);

    await expect(saveCaseBank(root, {
      action: 'create-draft',
      id: 'draft-secret-desc',
      prompt: '正常题面',
      description: '会话来自 /Users/someone/work/report',
      tags: [],
    }, '2026-09-04')).rejects.toThrow(/题目描述含敏感内容，先人工处理后再保存/);

    const items = await enumerateCaseBank(root, '2026-09-04');
    expect(items).toEqual([]);
  });
});

describe('CLI 与 UI 两条路径产出的草稿形状一致', () => {
  it('trajectory-to-case 的 YAML 与收题 UI 的 YAML 在共有字段上同形', async () => {
    const { root, bank } = await makeRepo();

    // 路径一：CLI（scripts/trajectory-to-case.ts 用的 buildDraftYaml）
    await fs.mkdir(path.join(bank, 'drafts'), { recursive: true });
    await fs.writeFile(
      path.join(bank, 'drafts', 'draft-cli.yaml'),
      buildDraftYaml({
        id: 'draft-cli',
        source: 'feedback',
        discriminator: 'fb-1',
        prompt: '同一句用户原话',
        sourceSessionId: 'sess-fake-0001',
      }),
    );

    // 路径二：收题 UI（evaluation:save-case → createDraft）
    const uiResult = await saveCaseBank(root, {
      action: 'create-draft',
      id: 'draft-ui',
      prompt: '同一句用户原话',
      sourceSessionId: 'sess-fake-0001',
      tags: [],
    }, '2026-09-04');

    const cli = await loadTestSuite(path.join(bank, 'drafts', 'draft-cli.yaml'), { requireHardened: false });
    const ui = await loadTestSuite(path.join(bank, uiResult.file), { requireHardened: false });

    const sharedShape = (testCase: (typeof cli)['cases'][number]) => ({
      type: testCase.type,
      prompt: testCase.prompt,
      sourceSessionId: testCase.sourceSessionId,
      reviewStatus: testCase.reviewStatus,
      expect: testCase.expect,
    });
    expect(sharedShape(ui.cases[0])).toEqual(sharedShape(cli.cases[0]));
  });
});
