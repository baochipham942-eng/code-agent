#!/usr/bin/env node
/* global console */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { tsImport } from 'tsx/esm/api';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sourceRepoRoot = path.resolve(scriptDir, '../..');
const repoRoot = process.cwd();
const requirePrivate = process.argv.slice(2).includes('--require-private');
const unexpectedArgs = process.argv.slice(2).filter((arg) => arg !== '--require-private');

async function filesUnder(root, predicate) {
  const files = [];
  const visit = async (directory) => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && predicate(entry.name)) files.push(target);
    }
  };
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function nonEmpty(value) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);
}

async function readPublicCases(errors) {
  const caseRoot = path.join(repoRoot, '.claude', 'test-cases');
  const bySource = new Map();
  const ids = new Map();
  for (const filePath of await filesUnder(caseRoot, (name) => /\.ya?ml$/u.test(name))) {
    const source = path.relative(repoRoot, filePath).split(path.sep).join('/');
    let parsed;
    try {
      parsed = parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      errors.push(`${source}: YAML 无法解析: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!Array.isArray(parsed?.cases)) {
      errors.push(`${source}: cases 必须是数组`);
      continue;
    }
    const cases = [];
    for (const testCase of parsed.cases) {
      if (typeof testCase?.id !== 'string') {
        errors.push(`${source}: case 缺少 id`);
        continue;
      }
      if (nonEmpty(testCase.expect)) errors.push(`${source}#${testCase.id}: 公开仓存在非空 expect`);
      if (nonEmpty(testCase.expectations)) errors.push(`${source}#${testCase.id}: 公开仓存在非空 expectations`);
      if (ids.has(testCase.id)) errors.push(`公开题目 id 重复: ${testCase.id}（${ids.get(testCase.id)} / ${source}）`);
      ids.set(testCase.id, source);
      cases.push(testCase);
    }
    bySource.set(source, cases);
  }
  return { bySource, ids };
}

async function checkPrivate(publicBank, errors) {
  const { resolveAnswerSideRoot } = await tsImport(
    path.join(sourceRepoRoot, 'src/host/testing/answerSide.ts'),
    import.meta.url,
  );
  const answerRoot = resolveAnswerSideRoot(repoRoot);
  if (!answerRoot) {
    errors.push('未解析到私档答案根');
    return;
  }
  const answersRoot = path.join(answerRoot, 'answers');
  const seenSources = new Set();

  for (const answerPath of await filesUnder(answersRoot, (name) => /\.ya?ml$/u.test(name))) {
    const relative = path.relative(answersRoot, answerPath).split(path.sep).join('/');
    let parsed;
    try {
      parsed = parse(await fs.readFile(answerPath, 'utf8'));
    } catch (error) {
      errors.push(`${answerPath}: YAML 无法解析: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const allowedRootKeys = ['version', 'source', 'cases'];
    const extraRootKeys = Object.keys(parsed ?? {}).filter((key) => !allowedRootKeys.includes(key));
    if (parsed?.version !== 1 || parsed?.source !== relative || !Array.isArray(parsed?.cases) || extraRootKeys.length > 0) {
      errors.push(`${answerPath}: 格式无效（version/source/cases）`);
      continue;
    }
    seenSources.add(relative);
    const publicCases = publicBank.bySource.get(relative);
    if (!publicCases) {
      errors.push(`${answerPath}: 私档 source 没有对应公开 YAML`);
      continue;
    }
    const publicIds = new Set(publicCases.map((item) => item.id));
    const answerIds = new Set();
    for (const answer of parsed.cases) {
      const allowedCaseKeys = ['id', 'expect', 'expectations'];
      const extraCaseKeys = Object.keys(answer ?? {}).filter((key) => !allowedCaseKeys.includes(key));
      if (typeof answer?.id !== 'string' || extraCaseKeys.length > 0) {
        errors.push(`${answerPath}: 答案条目只能包含 id/expect/expectations`);
        continue;
      }
      if (answerIds.has(answer.id)) errors.push(`${answerPath}: 重复答案 id ${answer.id}`);
      answerIds.add(answer.id);
      if (!publicIds.has(answer.id)) errors.push(`${answerPath}: 私档孤儿 id ${answer.id}`);
      if (!nonEmpty(answer.expect) && !nonEmpty(answer.expectations)) {
        errors.push(`${answerPath}: ${answer.id} 没有非空判定标准`);
      }
    }
    for (const id of publicIds) {
      if (!answerIds.has(id)) errors.push(`${answerPath}: 缺少公开题答案 ${id}`);
    }
  }

  for (const source of publicBank.bySource.keys()) {
    if (!seenSources.has(source)) errors.push(`${path.join(answersRoot, ...source.split('/'))}: 缺少答案文件`);
  }

  const loader = await tsImport(
    path.join(sourceRepoRoot, 'src/host/testing/testCaseLoader.ts'),
    import.meta.url,
  );
  const splitting = await tsImport(
    path.join(sourceRepoRoot, 'src/host/testing/ci/sampleSplits.ts'),
    import.meta.url,
  );
  const classification = await tsImport(
    path.join(sourceRepoRoot, 'src/host/testing/testCaseClassification.ts'),
    import.meta.url,
  );
  const mockPolicy = await tsImport(
    path.join(sourceRepoRoot, 'src/host/testing/mockEvalPolicy.ts'),
    import.meta.url,
  );
  const caseRoot = path.join(repoRoot, '.claude', 'test-cases');
  const directories = [
    caseRoot,
    path.join(caseRoot, 'artifact-runnable'),
    path.join(caseRoot, 'goal-contract'),
    path.join(caseRoot, 'user-simulator'),
  ];
  const loaderErrors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => loaderErrors.push(args.map(String).join(' '));
  let groups;
  try {
    groups = await Promise.all(directories.map(async (directory) => (
      loader.filterTestCases(await loader.loadAllTestSuites(directory), {})
    )));
  } finally {
    console.error = originalConsoleError;
  }
  if (loaderErrors.length > 0) errors.push(`loadAllTestSuites 输出 console.error:\n${loaderErrors.join('\n')}`);
  const coreCases = groups[0];
  const redlineCases = coreCases.filter(classification.isRedlineCase);
  const split = await splitting.loadEvalSplits(repoRoot);
  if (!split) {
    errors.push(`${path.join(answerRoot, 'eval-splits.json')}: 私档切分文件不存在`);
    return;
  }
  try {
    splitting.assertValidEvalSplits(split, {
      allCaseIds: coreCases.map((testCase) => testCase.id),
      safetyCaseIds: redlineCases.map((testCase) => testCase.id),
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (coreCases.length !== 140) errors.push(`默认题数应为 140，实际 ${coreCases.length}`);
  if (redlineCases.length !== 12) errors.push(`红线题数应为 12，实际 ${redlineCases.length}`);
  if (!coreCases.every((testCase) => testCase.max_cost_usd === 0.10)) {
    errors.push('并非所有核心 case 的 max_cost_usd 都是 0.10');
  }
  if (split.safety.length !== 12) errors.push(`safety 应为 12，实际 ${split.safety.length}`);
  if (new Set([...split.heldIn, ...split.heldOut, ...split.safety]).size !== 140) {
    errors.push('heldIn + heldOut + safety 去重后必须完整覆盖 140 题');
  }
  try {
    const coverage = mockPolicy.assertMockPolicyCoverage(split.heldIn);
    console.log(`[check-casebank-answers] mock policy: ${coverage.fixture} fixture / ${coverage.realOnly} real-only`);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  console.log(`[check-casebank-answers] loader: ${groups.map((items) => items.length).join(' + ')} cases`);
}

async function main() {
  if (unexpectedArgs.length > 0) throw new Error(`未知参数: ${unexpectedArgs.join(' ')}`);
  const errors = [];
  const publicBank = await readPublicCases(errors);
  try {
    await fs.access(path.join(repoRoot, '.claude', 'eval-splits.json'));
    errors.push('.claude/eval-splits.json 不得留在公开仓');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (requirePrivate) await checkPrivate(publicBank, errors);
  if (errors.length > 0) {
    console.error(`[check-casebank-answers] FAILED (${errors.length})`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[check-casebank-answers] PASS (${requirePrivate ? 'public + private' : 'public'})`);
}

main().catch((error) => {
  console.error(`[check-casebank-answers] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
