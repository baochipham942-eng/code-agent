import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findRepositoryRoot,
  resolveAnswerSideFile,
  resolveAnswerSideRoot,
} from '../../../src/host/testing/answerSide';
import { loadEvalSplits, saveEvalSplits, splitsPath } from '../../../src/host/testing/ci/sampleSplits';
import { loadTestSuite } from '../../../src/host/testing/testCaseLoader';

const roots: string[] = [];
const previousAnswerDir = process.env.NEO_EVAL_ANSWERS_DIR;

afterEach(async () => {
  if (previousAnswerDir === undefined) delete process.env.NEO_EVAL_ANSWERS_DIR;
  else process.env.NEO_EVAL_ANSWERS_DIR = previousAnswerDir;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function gitRepo(parent?: string): Promise<string> {
  const root = parent ?? await tempRoot('answer-side-repo-');
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  return root;
}

function suite(cases: Array<{ id: string; answer?: string }>): string {
  return [
    'name: answer-side-suite',
    'cases:',
    ...cases.flatMap(({ id, answer }) => [
      `  - id: ${id}`,
      '    type: task',
      `    prompt: ${id}`,
      ...(answer ? ['    expect:', `      response_contains: [${answer}]`] : []),
    ]),
    '',
  ].join('\n');
}

async function writeAnswer(
  answerRoot: string,
  source: string,
  cases: Array<{ id: string; answer?: string }>,
): Promise<string> {
  const target = path.join(answerRoot, 'answers', ...source.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, [
    'version: 1',
    `source: ${source}`,
    'cases:',
    ...cases.flatMap(({ id, answer }) => [
      `  - id: ${id}`,
      ...(answer ? ['    expect:', `      response_contains: [${answer}]`] : []),
    ]),
    '',
  ].join('\n'));
  return target;
}

function split(ids: string[]) {
  return {
    version: 1 as const,
    seed: 'answer-side-test',
    createdAt: '2026-09-02',
    heldIn: ids,
    heldOut: [],
    control: [],
    safety: [],
  };
}

describe('answer-side resolver and loader merge', () => {
  it('env 指向不存在目录时 fail-loud', async () => {
    const root = await gitRepo();
    process.env.NEO_EVAL_ANSWERS_DIR = path.join(root, 'missing');
    expect(() => resolveAnswerSideRoot(root)).toThrow(/NEO_EVAL_ANSWERS_DIR.*不存在/);
  });

  it('env=none 强制禁用兄弟目录', async () => {
    const parent = await tempRoot('answer-side-none-');
    const root = await gitRepo(path.join(parent, 'code-agent'));
    await fs.mkdir(path.join(parent, 'code-agent-private-archive', 'eval'), { recursive: true });
    process.env.NEO_EVAL_ANSWERS_DIR = 'none';
    expect(resolveAnswerSideRoot(root)).toBeNull();
  });

  it('命中仓库兄弟目录，且没有 .git 时纯内联模式返回 null', async () => {
    delete process.env.NEO_EVAL_ANSWERS_DIR;
    const parent = await tempRoot('answer-side-sibling-');
    const root = await gitRepo(path.join(parent, 'code-agent'));
    const answerRoot = path.join(parent, 'code-agent-private-archive', 'eval');
    await fs.mkdir(path.join(root, 'nested'), { recursive: true });
    await fs.mkdir(answerRoot, { recursive: true });
    expect(resolveAnswerSideRoot(path.join(root, 'nested'))).toBe(answerRoot);

    const plain = await tempRoot('answer-side-plain-');
    expect(findRepositoryRoot(plain)).toBeNull();
    expect(resolveAnswerSideRoot(plain)).toBeNull();
  });

  it('合并私档答案、保留纯内联，并拒绝双份答案', async () => {
    const root = await gitRepo();
    const source = '.claude/test-cases/suite.yaml';
    const file = path.join(root, ...source.split('/'));
    const answerRoot = path.join(root, 'private-eval');
    process.env.NEO_EVAL_ANSWERS_DIR = answerRoot;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.mkdir(answerRoot, { recursive: true });

    await fs.writeFile(file, suite([{ id: 'side-only' }]));
    const answerFile = await writeAnswer(answerRoot, source, [{ id: 'side-only', answer: 'side' }]);
    await expect(loadTestSuite(file)).resolves.toMatchObject({
      cases: [{ id: 'side-only', expect: { response_contains: ['side'] } }],
    });

    delete process.env.NEO_EVAL_ANSWERS_DIR;
    const inlineFile = path.join(await tempRoot('answer-side-inline-'), 'inline.yaml');
    await fs.writeFile(inlineFile, suite([{ id: 'inline-only', answer: 'inline' }]));
    await expect(loadTestSuite(inlineFile)).resolves.toMatchObject({
      cases: [{ id: 'inline-only', expect: { response_contains: ['inline'] } }],
    });

    process.env.NEO_EVAL_ANSWERS_DIR = answerRoot;
    await fs.writeFile(file, suite([{ id: 'side-only', answer: 'inline' }]));
    await expect(loadTestSuite(file)).rejects.toThrow(
      new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*${answerFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  });

  it('答案文件缺 id 时标为 answer_side_missing，requireHardened 也不丢题', async () => {
    const root = await gitRepo();
    const source = '.claude/test-cases/suite.yaml';
    const file = path.join(root, ...source.split('/'));
    const answerRoot = path.join(root, 'private-eval');
    process.env.NEO_EVAL_ANSWERS_DIR = answerRoot;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.mkdir(answerRoot, { recursive: true });
    await fs.writeFile(file, suite([{ id: 'present' }, { id: 'missing' }]));
    const answerFile = await writeAnswer(answerRoot, source, [{ id: 'present', answer: 'ok' }]);

    const loaded = await loadTestSuite(file);
    expect(loaded.cases).toHaveLength(2);
    expect(loaded.cases[1]).toMatchObject({
      id: 'missing',
      answerSide: 'missing',
      answerSidePath: answerFile,
      answerSideRoot: answerRoot,
    });
  });

  it('splits 在答案根可解析时跟随私档，否则回落公开夹具路径', async () => {
    const root = await gitRepo();
    const answerRoot = path.join(root, 'private-eval');
    await fs.mkdir(answerRoot, { recursive: true });
    process.env.NEO_EVAL_ANSWERS_DIR = answerRoot;
    await saveEvalSplits(root, split(['private-case']));
    expect(splitsPath(root)).toBe(path.join(answerRoot, 'eval-splits.json'));
    await expect(loadEvalSplits(root)).resolves.toEqual(split(['private-case']));

    delete process.env.NEO_EVAL_ANSWERS_DIR;
    const plain = await tempRoot('answer-side-splits-fallback-');
    await saveEvalSplits(plain, split(['fixture-case']));
    expect(splitsPath(plain)).toBe(path.join(plain, '.claude', 'eval-splits.json'));
    await expect(loadEvalSplits(plain)).resolves.toEqual(split(['fixture-case']));
  });

  it('软链题库目录按真实路径配答案侧（主仓 .code-agent/test-cases -> .claude/test-cases）', async () => {
    const root = await gitRepo();
    const source = '.claude/test-cases/suite.yaml';
    const canonical = path.join(root, ...source.split('/'));
    const answerRoot = path.join(root, 'private-eval');
    process.env.NEO_EVAL_ANSWERS_DIR = answerRoot;
    await fs.mkdir(path.dirname(canonical), { recursive: true });
    await fs.mkdir(path.join(root, '.code-agent'), { recursive: true });
    await fs.symlink(path.join('..', '.claude', 'test-cases'), path.join(root, '.code-agent', 'test-cases'), 'dir');
    await fs.mkdir(answerRoot, { recursive: true });
    await fs.writeFile(canonical, suite([{ id: 'linked' }]));
    await writeAnswer(answerRoot, source, [{ id: 'linked', answer: 'side' }]);

    const linked = path.join(root, '.code-agent', 'test-cases', 'suite.yaml');
    expect(resolveAnswerSideFile(linked)?.source).toBe(source);
    await expect(loadTestSuite(linked)).resolves.toMatchObject({
      cases: [{ id: 'linked', expect: { response_contains: ['side'] } }],
    });
  });
});
