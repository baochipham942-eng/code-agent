#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, '../..');
const specPath = 'tests/e2e/visual-shotbase.spec.ts';
const snapshotDir = `${specPath}-snapshots`;
const linuxBaselines = [
  `${snapshotDir}/dangerous-command-approval-light-chromium-linux.png`,
  `${snapshotDir}/dangerous-command-approval-dark-chromium-linux.png`,
];

const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const knownArgs = new Set(['--repo-root', '--base-ref']);
const unknownArgs = args.filter((arg, index) => arg.startsWith('--')
  ? !knownArgs.has(arg)
  : index === 0 || !knownArgs.has(args[index - 1]));
if (unknownArgs.length > 0) {
  console.error(`[visual-shotbase-baseline-gate] ✗ 不支持的参数：${unknownArgs.join(', ')}`);
  process.exit(1);
}

const repoRoot = path.resolve(option('--repo-root', defaultRepoRoot));
const baseRef = option('--base-ref', process.env.VISUAL_SHOTBASE_BASE_REF || 'origin/main');

function fail(message) {
  console.error(`[visual-shotbase-baseline-gate] ✗ ${message}`);
  process.exit(1);
}

function git(argsList, options = {}) {
  try {
    return execFileSync('git', argsList, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }).trim();
  } catch (error) {
    const stderr = error?.stderr?.toString().trim();
    fail(`git ${argsList.join(' ')} 失败${stderr ? `：${stderr}` : ''}`);
  }
}

function readCurrent(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  try {
    return fs.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    fail(`读取 ${relativePath} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function readAtRef(ref, relativePath) {
  return git(['show', `${ref}:${relativePath}`]);
}

function screenshotContractTokens(source, label) {
  const sourceFile = ts.createSourceFile(
    specPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const screenshotStatements = [];

  function visit(node) {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'toHaveScreenshot'
    ) {
      let statement = node;
      while (statement.parent && !ts.isExpressionStatement(statement)) {
        statement = statement.parent;
      }
      if (!ts.isExpressionStatement(statement)) {
        fail(`${label} 中的 toHaveScreenshot 不在独立语句内，无法界定截图契约`);
      }
      screenshotStatements.push(statement);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (screenshotStatements.length !== 1) {
    fail(`${label} 应有且只有 1 个 toHaveScreenshot，实际为 ${screenshotStatements.length}`);
  }

  // 从文件开头到截图语句的 token 都会影响画面。扫描时忽略注释和空白，
  // 避免文案注释或格式化触发无意义的 PNG 重录。
  const contractSource = source.slice(0, screenshotStatements[0].end);
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    contractSource,
  );
  const tokens = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    tokens.push(`${token}:${scanner.getTokenText()}`);
  }
  if (tokens.length === 0) fail(`${label} 截图契约 token 为 0，门已空转`);
  return tokens.join('\n');
}

function lines(value) {
  return value ? value.split('\n').filter(Boolean) : [];
}

function changedPathsFrom(baseSha) {
  const changed = new Set(lines(git([
    'diff',
    '--name-only',
    '--diff-filter=ACMR',
    baseSha,
    '--',
    specPath,
    snapshotDir,
  ])));
  for (const untracked of lines(git(['ls-files', '--others', '--exclude-standard', '--', snapshotDir]))) {
    changed.add(untracked);
  }
  return changed;
}

function darwinSnapshotsInWorkingTree() {
  const absoluteDir = path.join(repoRoot, snapshotDir);
  let entries;
  try {
    entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  } catch (error) {
    fail(`读取基线目录 ${snapshotDir} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('-chromium-darwin.png'))
    .map((entry) => `${snapshotDir}/${entry.name}`)
    .sort();
}

git(['rev-parse', '--show-toplevel']);
const baseSha = git(['merge-base', 'HEAD', baseRef]);
if (!baseSha) fail(`HEAD 与 ${baseRef} 的 merge-base 为空`);

const darwinSnapshots = darwinSnapshotsInWorkingTree();
if (darwinSnapshots.length > 0) {
  fail(
    `发现 macOS 视觉基线：${darwinSnapshots.join(', ')}。`
    + '本用例只接受 Playwright 1.60.0 的 Linux/Chromium 产物，不要用 -darwin 后缀冒充 Linux 基线。',
  );
}

const baseContract = screenshotContractTokens(readAtRef(baseSha, specPath), `${baseRef}@${baseSha}`);
const currentContract = screenshotContractTokens(readCurrent(specPath), '当前工作树');
const changedPaths = changedPathsFrom(baseSha);

if (baseContract !== currentContract) {
  const missingBaselines = linuxBaselines.filter((baseline) => !changedPaths.has(baseline));
  if (missingBaselines.length > 0) {
    fail(
      '你改了截图前的页面状态但没重生成基线。'
      + `请在 Playwright 1.60.0 的 Linux/Chromium 环境同步更新 light 和 dark 两张 PNG；当前未变更：${missingBaselines.join(', ')}`,
    );
  }
}

for (const baseline of linuxBaselines) {
  if (!fs.existsSync(path.join(repoRoot, baseline))) {
    fail(`缺少 Linux 视觉基线：${baseline}`);
  }
}

console.log(
  `[visual-shotbase-baseline-gate] ✓ 截图契约与 Linux 基线同步（base=${baseSha.slice(0, 10)}）`,
);
