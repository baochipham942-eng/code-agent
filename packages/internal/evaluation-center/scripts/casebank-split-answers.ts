#!/usr/bin/env npx tsx

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Document, isMap, isSeq, parseDocument } from 'yaml';
import {
  findRepositoryRoot,
  resolveAnswerSideRoot,
} from '@host/testing/answerSide';
import { loadTestSuite } from '@host/testing/testCaseLoader';

interface PlannedFile {
  sourcePath: string;
  sourceRelative: string;
  answerPath: string;
  answers: Array<{ id: string; expect?: unknown; expectations?: unknown }>;
  deletions: Array<{ start: number; end: number }>;
}

function parseMode(argv: string[]): 'check' | 'write' {
  const modes = argv.slice(2).filter((arg) => arg === '--check' || arg === '--write');
  if (modes.length !== 1) throw new Error('用法: casebank-split-answers.ts --check | --write');
  return modes[0] === '--write' ? 'write' : 'check';
}

async function yamlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && /\.ya?ml$/u.test(entry.name)) files.push(target);
    }
  };
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function nonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);
}

function lineStart(source: string, offset: number): number {
  const previousNewline = source.lastIndexOf('\n', Math.max(0, offset - 1));
  return previousNewline < 0 ? 0 : previousNewline + 1;
}

function planFile(repoRoot: string, answerRoot: string, sourcePath: string, source: string): PlannedFile | null {
  const document = parseDocument(source);
  if (document.errors.length > 0) throw document.errors[0];
  const casesNode = document.get('cases', true);
  if (!isSeq(casesNode)) throw new Error(`${sourcePath}: cases 必须是数组`);
  const suite = document.toJS() as { cases?: Array<Record<string, unknown>> };
  const rawCases = suite.cases ?? [];
  const answers: PlannedFile['answers'] = [];
  const deletions: PlannedFile['deletions'] = [];

  for (let index = 0; index < casesNode.items.length; index += 1) {
    const caseNode = casesNode.items[index];
    const rawCase = rawCases[index];
    if (!isMap(caseNode) || !rawCase || typeof rawCase.id !== 'string') {
      throw new Error(`${sourcePath}: case ${index} 结构无效`);
    }
    const answer: PlannedFile['answers'][number] = { id: rawCase.id };
    for (const key of ['expect', 'expectations'] as const) {
      if (!nonEmpty(rawCase[key])) continue;
      answer[key] = rawCase[key];
      const pair = caseNode.items.find(
        (item) => (item.key as { value?: unknown } | null)?.value === key,
      );
      const editablePair = pair as {
        key?: { range?: [number, number, number] };
        value?: { range?: [number, number, number] };
      } | undefined;
      const keyOffset = editablePair?.key?.range?.[0];
      const valueEnd = editablePair?.value?.range?.[1];
      if (keyOffset === undefined || valueEnd === undefined) {
        throw new Error(`${sourcePath}: ${rawCase.id}.${key} 缺少可编辑源码位置`);
      }
      deletions.push({ start: lineStart(source, keyOffset), end: valueEnd });
    }
    if (Object.keys(answer).length > 1) answers.push(answer);
  }

  if (answers.length === 0) return null;
  const sourceRelative = path.relative(repoRoot, sourcePath).split(path.sep).join('/');
  return {
    sourcePath,
    sourceRelative,
    answerPath: path.join(answerRoot, 'answers', ...sourceRelative.split('/')),
    answers,
    deletions,
  };
}

function removeRanges(source: string, deletions: PlannedFile['deletions']): string {
  return [...deletions]
    .sort((left, right) => right.start - left.start)
    .reduce((content, deletion) => `${content.slice(0, deletion.start)}${content.slice(deletion.end)}`, source);
}

function answerDocument(plan: PlannedFile): string {
  const document = new Document({
    version: 1,
    source: plan.sourceRelative,
    cases: plan.answers,
  });
  return document.toString({ lineWidth: 0 });
}

function answerSnapshot(cases: Awaited<ReturnType<typeof loadTestSuite>>['cases']): unknown {
  return cases.map((testCase) => ({
    id: testCase.id,
    expect: testCase.expect,
    expectations: testCase.expectations,
  }));
}

async function withAnswerEnv<T>(value: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.NEO_EVAL_ANSWERS_DIR;
  process.env.NEO_EVAL_ANSWERS_DIR = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.NEO_EVAL_ANSWERS_DIR;
    else process.env.NEO_EVAL_ANSWERS_DIR = previous;
  }
}

async function selectAnswerRoot(repoRoot: string, mode: 'check' | 'write'): Promise<string> {
  const configured = process.env.NEO_EVAL_ANSWERS_DIR?.trim();
  if (configured === 'none') throw new Error('NEO_EVAL_ANSWERS_DIR=none 时不能迁移答案侧');
  const resolved = resolveAnswerSideRoot(repoRoot);
  if (resolved) return resolved;
  // 与 ADR-038 的主仓/工作树兄弟目录约定一致；运行时解析仍只在 answerSide.ts。
  const candidates = [
    path.resolve(repoRoot, '..', 'code-agent-private-archive', 'eval'),
    path.resolve(repoRoot, '..', '..', 'code-agent-private-archive', 'eval'),
  ];
  let candidate: string | undefined;
  for (const item of candidates) {
    try {
      await fs.access(path.dirname(item));
      candidate = item;
      break;
    } catch {
      // Try the worktree-layout candidate next.
    }
  }
  if (!candidate) throw new Error('找不到 code-agent-private-archive，无法确定迁移目标');
  if (mode === 'write') await fs.mkdir(candidate, { recursive: true });
  return candidate;
}

async function migrateFile(plan: PlannedFile, source: string, answerRoot: string): Promise<void> {
  const previousAnswer = await fs.readFile(plan.answerPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const before = await withAnswerEnv('none', async () => answerSnapshot((await loadTestSuite(plan.sourcePath)).cases));
  try {
    await fs.mkdir(path.dirname(plan.answerPath), { recursive: true });
    await fs.writeFile(plan.answerPath, answerDocument(plan), 'utf8');
    await fs.writeFile(plan.sourcePath, removeRanges(source, plan.deletions), 'utf8');
    const after = await withAnswerEnv(answerRoot, async () => answerSnapshot((await loadTestSuite(plan.sourcePath)).cases));
    assert.deepStrictEqual(after, before, `${plan.sourceRelative}: 迁移前后答案不一致`);
  } catch (error) {
    await fs.writeFile(plan.sourcePath, source, 'utf8');
    if (previousAnswer) await fs.writeFile(plan.answerPath, previousAnswer);
    else await fs.rm(plan.answerPath, { force: true });
    throw error;
  }
}

async function verifyAlreadyMigrated(
  repoRoot: string,
  answerRoot: string,
  sourcePaths: string[],
): Promise<void> {
  for (const sourcePath of sourcePaths) {
    const sourceRelative = path.relative(repoRoot, sourcePath).split(path.sep).join('/');
    let committedSource: string;
    try {
      committedSource = execFileSync('git', ['show', `HEAD:${sourceRelative}`], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      continue;
    }
    const historicalPlan = planFile(repoRoot, answerRoot, sourcePath, committedSource);
    if (!historicalPlan) continue;
    let actual: unknown;
    try {
      actual = parseDocument(await fs.readFile(historicalPlan.answerPath, 'utf8')).toJS();
    } catch {
      throw new Error(`${sourceRelative}: 已迁移题缺少私档答案文件`);
    }
    const expected = parseDocument(answerDocument(historicalPlan)).toJS();
    assert.deepStrictEqual(actual, expected, `${sourceRelative}: 私档答案与迁移源不一致`);
  }
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv);
  const repoRoot = findRepositoryRoot(process.cwd());
  if (!repoRoot) throw new Error('当前目录不在 Git 仓库内');
  const answerRoot = await selectAnswerRoot(repoRoot, mode);
  const caseRoot = path.join(repoRoot, '.claude', 'test-cases');
  const plans: Array<{ plan: PlannedFile; source: string }> = [];
  const sourcePaths = await yamlFiles(caseRoot);
  for (const sourcePath of sourcePaths) {
    const source = await fs.readFile(sourcePath, 'utf8');
    const plan = planFile(repoRoot, answerRoot, sourcePath, source);
    if (plan) plans.push({ plan, source });
  }

  console.log(`[casebank-split-answers] ${mode}: ${plans.length} 个公开 YAML → ${answerRoot}`);
  for (const { plan } of plans) console.log(`- ${plan.sourceRelative}: ${plan.answers.length} cases`);
  await verifyAlreadyMigrated(repoRoot, answerRoot, sourcePaths);
  if (mode === 'check') return;

  for (const { plan, source } of plans) await migrateFile(plan, source, answerRoot);

  const publicSplits = path.join(repoRoot, '.claude', 'eval-splits.json');
  const privateSplits = path.join(answerRoot, 'eval-splits.json');
  try {
    const splits = await fs.readFile(publicSplits);
    await fs.writeFile(privateSplits, splits);
    await fs.unlink(publicSplits);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.writeFile(
    path.join(answerRoot, 'README.md'),
    '这里保存公开题库对应的判定标准与评测集切分。\n这些内容依据 ADR-038 不进入公开仓，以保持留出集独立性。\n新增答案时，在 answers/ 下对应公开 YAML 的文件里按题目 id 添加 expect 或 expectations。\n',
    'utf8',
  );
  console.log(`[casebank-split-answers] write 完成: ${plans.length} files`);
}

main().catch((error: unknown) => {
  console.error(`[casebank-split-answers] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
