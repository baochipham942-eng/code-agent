#!/usr/bin/env node
/* global console */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const limits = {
  rootDirectories: 19,
  hostDomains: 45,
  testTopLevelDirectories: 24,
  // 134: fetch-poppler.sh 与 fetch-rtk.sh / fetch-uv.sh 同类同层——它产出的
  // scripts/poppler 是 tauri.conf.json 的 bundle resource，符合 scripts/README.md
  // 「根层文件保留条件」的第一条（被 Tauri 配置作为稳定入口直接调用）。
  directScriptFiles: 134,
  workflows: 13,
};

const navigationFiles = [
  'README.md',
  'docs/architecture/repo-map.md',
  'docs/architecture/source-map.md',
  'docs/architecture/overview.md',
  'src/host/README.md',
  'tests/README.md',
  'scripts/README.md',
  '.github/README.md',
];

const requiredPaths = [
  'docs/ARCHITECTURE.md',
  ...navigationFiles,
  'scripts/ci/check-repository-structure.mjs',
  '.github/workflows/repository-structure.yml',
];

function trackedFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
}

function repoPath(relativePath) {
  return path.join(repoRoot, relativePath);
}

function countDirectories(files, prefix, segmentIndex) {
  return new Set(files
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.split('/'))
    .filter((parts) => parts.length > segmentIndex + 1)
    .map((parts) => parts[segmentIndex])).size;
}

function localMarkdownTargets(relativeFile) {
  const content = fs.readFileSync(repoPath(relativeFile), 'utf8');
  const targets = [];
  const pattern = /\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = pattern.exec(content))) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '');
    if (!rawTarget || rawTarget.startsWith('#')) continue;
    if (/^(?:[a-z]+:|\/\/)/i.test(rawTarget)) continue;
    const withoutAnchor = rawTarget.split('#', 1)[0];
    if (withoutAnchor) targets.push(withoutAnchor);
  }
  return targets;
}

function validateNavigationLinks(errors) {
  for (const file of navigationFiles) {
    const baseDir = path.dirname(repoPath(file));
    for (const target of localMarkdownTargets(file)) {
      const resolved = path.resolve(baseDir, decodeURIComponent(target));
      if (!resolved.startsWith(`${repoRoot}${path.sep}`) && resolved !== repoRoot) {
        errors.push(`${file}: link escapes repository: ${target}`);
        continue;
      }
      if (!fs.existsSync(resolved)) {
        errors.push(`${file}: missing link target: ${target}`);
      }
    }
  }
}

function validateArchitectureMap(errors) {
  const content = fs.readFileSync(repoPath('docs/ARCHITECTURE.md'), 'utf8');
  const start = content.indexOf('### 目录结构');
  const end = content.indexOf('### 工具体系', start);
  if (start === -1 || end === -1) {
    errors.push('docs/ARCHITECTURE.md: missing directory structure section');
    return;
  }
  const map = content.slice(start, end);
  for (const stalePath of ['src/main/', 'docs/PRD.md', 'docs/decisions/']) {
    if (map.includes(stalePath)) {
      errors.push(`docs/ARCHITECTURE.md: stale directory map entry: ${stalePath}`);
    }
  }
}

function assertAtMost(errors, label, actual, limit) {
  if (actual > limit) {
    errors.push(`${label}: ${actual} exceeds ratchet ${limit}; reuse an existing category or update the repository map and ratchet intentionally`);
  }
}

const files = trackedFiles();
const errors = [];

for (const requiredPath of requiredPaths) {
  if (!fs.existsSync(repoPath(requiredPath))) {
    errors.push(`missing required repository navigation path: ${requiredPath}`);
  }
}

validateNavigationLinks(errors);
validateArchitectureMap(errors);

const rootDirectories = new Set(files
  .filter((file) => file.includes('/'))
  .map((file) => file.split('/')[0])).size;
const hostDomains = countDirectories(files, 'src/host/', 2);
const testTopLevelDirectories = countDirectories(files, 'tests/', 1);
const directScriptFiles = files.filter((file) => file.startsWith('scripts/')
  && file.split('/').length === 2
  && file !== 'scripts/README.md').length;
const workflows = files.filter((file) => file.startsWith('.github/workflows/')).length;

assertAtMost(errors, 'tracked root directories', rootDirectories, limits.rootDirectories);
assertAtMost(errors, 'src/host top-level domains', hostDomains, limits.hostDomains);
assertAtMost(errors, 'tests top-level directories', testTopLevelDirectories, limits.testTopLevelDirectories);
assertAtMost(errors, 'direct scripts files', directScriptFiles, limits.directScriptFiles);
assertAtMost(errors, 'GitHub workflows', workflows, limits.workflows);

if (errors.length > 0) {
  console.error('[repository-structure] FAILED');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('[repository-structure] PASS');
console.log(JSON.stringify({
  rootDirectories,
  hostDomains,
  testTopLevelDirectories,
  directScriptFiles,
  workflows,
  checkedNavigationFiles: navigationFiles.length,
}, null, 2));
