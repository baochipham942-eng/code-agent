#!/usr/bin/env node
/* global console */
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout, clearTimeout } from 'node:timers';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { tsImport } from 'tsx/esm/api';
import { digest, selectTests, validateFiles, validateReport, renderReceipt } from './lib/gates-fast-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const started = performance.now();
const policyPath = 'scripts/lib/gates-fast-policy.json';
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
const receipt = {
  schemaVersion: 2, receiptId: randomUUID(), repo: null, workorder: null,
  status: 'failed', startedAt: new Date().toISOString(), finishedAt: null,
  headSha: null, treeSha: null, baseSha: null, mergeBaseSha: null,
  policyVersion: policy.version, policyHash: null, lockHash: null, privateInputsHash: null,
  nodeVersion: process.version, packageManager: null,
  signer: { kind: 'unsigned-local', identity: null }, prNumber: null, ci: { status: 'pending', runs: [] },
  queueDurationMs: 0, slot: { kind: 'independent-process', pid: process.pid },
  gates: [], commands: [], selectedFiles: [], report: null,
};
let output = path.join(root, '.reports/gates-fast', `${receipt.receiptId}.json`);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-fast-'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000 }).trim();
let privateRoot;
let initial;

function hashFiles(files) {
  return digest(JSON.stringify(files.sort().map((file) => [file, digest(fs.readFileSync(path.join(root, file)))])));
}
function hashPrivate() {
  const values = [];
  function visit(directory, relative = '') {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(relative, item.name);
      const full = path.join(directory, item.name);
      if (item.isDirectory()) visit(full, name);
      else if (item.isFile()) values.push([name, digest(fs.readFileSync(full))]);
      else throw new Error(`FAIL: private input is not a regular file/directory: ${name}`);
    }
  }
  visit(privateRoot);
  return digest(JSON.stringify(values));
}
function snapshot() {
  if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('FAIL: clean committed HEAD required');
  return {
    headSha: git('rev-parse', 'HEAD'), treeSha: git('rev-parse', 'HEAD^{tree}'),
    baseSha: git('rev-parse', `${options.base}^{commit}`),
    policyHash: hashFiles([policyPath, 'vitest.fast.config.ts', 'vitest.config.ts', 'scripts/gates-fast.mjs', 'scripts/lib/gates-fast-contract.mjs']),
    lockHash: hashFiles(git('ls-files').split('\n').filter((file) => /(^|\/)package-lock\.json$/.test(file))),
    privateInputsHash: hashPrivate(),
    installedHash: hashFiles(['node_modules/.package-lock.json', ...receipt.packageChecks.flatMap((pkg) => pkg === 'vercel-api' ? ['vercel-api/node_modules/.package-lock.json'] : [])]),
    regressionsHash: digest(options.regressions ? fs.readFileSync(options.regressions) : JSON.stringify(regressions)),
  };
}
function checkDependencies(prefix = '') {
  const lock = JSON.parse(fs.readFileSync(path.join(root, prefix, 'package-lock.json'), 'utf8'));
  const installed = JSON.parse(fs.readFileSync(path.join(root, prefix, 'node_modules/.package-lock.json'), 'utf8'));
  for (const [name, info] of Object.entries(lock.packages)) {
    if (name && installed.packages[name] && info.version !== installed.packages[name].version) {
      throw new Error(`FAIL: installed dependency differs from lock: ${prefix}/${name}`);
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, prefix, 'package.json'), 'utf8'));
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const expected = lock.packages[`node_modules/${name}`]?.version;
    const actual = JSON.parse(fs.readFileSync(path.join(root, prefix, 'node_modules', name, 'package.json'), 'utf8')).version;
    if (!expected || expected !== actual) throw new Error(`FAIL: missing/incorrect installed dependency: ${prefix}/${name}`);
  }
}
async function command(argv, env = {}) {
  const began = performance.now();
  const record = { argv, startedAt: new Date().toISOString(), exit: null, durationMs: 0 };
  receipt.commands.push(record);
  const remaining = policy.budgetMs - (performance.now() - started);
  if (remaining <= 0) throw new Error('FAIL: budget exceeded (60000ms)');
  await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: root, detached: true, stdio: 'inherit', env: { ...process.env, npm_config_offline: 'true', ...env } });
    let timedOut = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, remaining);
    const interrupted = () => { timedOut = true; kill(); };
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);
    const cleanup = () => { clearTimeout(timer); process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted); record.durationMs = Math.round(performance.now() - began); };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code, signal) => {
      cleanup(); record.exit = code; record.signal = signal;
      if (timedOut || code !== 0) reject(new Error(`FAIL: ${timedOut ? '60000ms budget/interruption' : `exit ${code}`} in ${argv.join(' ')}`));
      else resolve();
    });
  });
}
async function gate(id, applicable, run) {
  const record = { id, budgetMs: policy.budgetsMs[id], status: applicable ? 'running' : 'not-applicable', reason: applicable ? 'required by policy/PR paths' : 'no matching PR paths', durationMs: 0 };
  receipt.gates.push(record);
  if (!applicable) return;
  const began = performance.now();
  console.log(`▶ gates:fast ${id}`);
  try { await run(); record.status = 'passed'; }
  catch (error) { record.status = 'failed'; throw error; }
  finally { record.durationMs = Math.round(performance.now() - began); record.overBudget = record.durationMs > record.budgetMs; }
}
const options = { base: 'origin/main' };
let regressions = [];
try {
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]; const value = process.argv[i + 1];
    if (!['--base', '--workorder', '--receipt', '--regressions'].includes(key) || !value || value.startsWith('--')) throw new Error(`FAIL: unknown/missing argument ${key}`);
    options[key.slice(2)] = value;
  }
  if (options.receipt) output = path.resolve(options.receipt);
  if (output.startsWith(`${root}${path.sep}`) && !output.startsWith(`${path.join(root, '.reports/gates-fast')}${path.sep}`)) {
    output = path.join(root, '.reports/gates-fast', `${receipt.receiptId}.json`);
    throw new Error('FAIL: receipt must be outside source or under .reports/gates-fast');
  }
  if (policy.budgetMs !== 60000 || policy.maxFiles !== 12) throw new Error('FAIL: first-version policy requires 60000ms and 12-file maximum');
  if (options.regressions) regressions = JSON.parse(fs.readFileSync(options.regressions, 'utf8'));
  await gate('inputs', true, async () => {
    const { resolveAnswerSideRoot } = await tsImport(path.join(root, 'src/host/testing/answerSide.ts'), import.meta.url);
    privateRoot = resolveAnswerSideRoot(root);
    if (!privateRoot) throw new Error('FAIL: private inputs missing');
    // Freeze head/base before anything reads the diff: a commit landing between diff and
    // snapshot must fail the run, never get a receipt bound to a HEAD it was not selected for.
    receipt.headSha = git('rev-parse', 'HEAD^{commit}'); receipt.treeSha = git('rev-parse', 'HEAD^{tree}');
    receipt.baseSha = git('rev-parse', `${options.base}^{commit}`);
    receipt.mergeBaseSha = git('merge-base', receipt.headSha, receipt.baseSha);
    if (receipt.baseSha !== receipt.mergeBaseSha) throw new Error('FAIL: HEAD is behind base; rebase before fast gates');
    // Disabling rename detection deliberately exposes old AND new names.
    const diff = git('diff', '--no-renames', '--name-status', '-z', receipt.baseSha, receipt.headSha).split('\0').filter(Boolean);
    receipt.changedFiles = diff.filter((_value, index) => index % 2 === 1);
    receipt.deletedFiles = receipt.changedFiles.filter((_file, index) => diff[index * 2] === 'D');
    const selected = selectTests(policy, receipt.changedFiles, regressions, receipt.deletedFiles);
    validateFiles(root, selected.files, policy.maxFiles);
    receipt.selectedFiles = selected.files;
    receipt.matchedRules = selected.matchedRules;
    receipt.manualRegressions = regressions;
    receipt.packageChecks = selected.packages;
    receipt.testsTypecheck = selected.testsTypecheck;
    checkDependencies();
    if (selected.packages.includes('vercel-api')) checkDependencies('vercel-api');
    initial = snapshot();
    if (initial.headSha !== receipt.headSha || initial.treeSha !== receipt.treeSha) throw new Error('FAIL: HEAD moved during test selection; receipt invalid');
    Object.assign(receipt, initial);
    receipt.repo = git('config', '--get', 'remote.origin.url');
    receipt.workorder = options.workorder ?? null;
    receipt.packageManager = { name: 'npm', version: execFileSync('npm', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim() };
  });
  await gate('provider', true, () => command(['bash', 'scripts/check-provider-symmetry.sh', '--quiet']));
  await gate('private', true, () => command([process.execPath, 'scripts/ci/check-casebank-answers.mjs', '--require-private']));
  await gate('src-typecheck', true, () => command(['npm', 'run', 'typecheck']));
  await gate('shell', true, () => command([process.execPath, 'scripts/shell-fail-loud-lint.mjs']));
  await gate('commit-checks', true, async () => {
    await command(['bash', 'scripts/check-prompt-version-bump.sh', '--base', receipt.baseSha, '--head', receipt.headSha]);
    const tsFiles = receipt.changedFiles.filter((file) => /\.tsx?$/.test(file) && fs.existsSync(file));
    for (const file of tsFiles) await command(['bash', 'scripts/check-hardcoded-models.sh', '--file', file]);
    const lintFiles = tsFiles.filter((file) => !file.startsWith('admin-console/') && !file.startsWith('docs/'));
    if (lintFiles.length) await command([process.execPath, 'node_modules/eslint/bin/eslint.js', ...lintFiles]);
  });
  await gate('vitest', true, async () => {
    const manifest = path.join(temp, 'selection.json'); const report = path.join(temp, 'vitest.json');
    fs.writeFileSync(manifest, JSON.stringify({ files: receipt.selectedFiles, maxFiles: policy.maxFiles }));
    await command([process.execPath, 'node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.fast.config.ts'], { GATES_FAST_MANIFEST: manifest, GATES_FAST_REPORT: report });
    receipt.report = validateReport(receipt.selectedFiles, JSON.parse(fs.readFileSync(report, 'utf8')), root);
  });
  await gate('package-typechecks', receipt.packageChecks.length > 0, async () => {
    for (const pkg of receipt.packageChecks) await command(['npm', '--prefix', pkg, 'run', 'typecheck']);
  });
  await gate('tests-typecheck', receipt.testsTypecheck, () => command([process.execPath, 'scripts/tsc-tests-ratchet.mjs']));
  if (JSON.stringify(initial) !== JSON.stringify(snapshot())) throw new Error('FAIL: inputs changed during gates:fast; receipt invalid');
  if (performance.now() - started > policy.budgetMs) throw new Error('FAIL: 60000ms budget exceeded');
  receipt.status = 'passed';
} catch (error) {
  receipt.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  for (const id of Object.keys(policy.budgetsMs)) {
    if (!receipt.gates.some((gate) => gate.id === id)) receipt.gates.push({ id, status: 'not-run', reason: 'earlier gate failed', durationMs: 0, budgetMs: policy.budgetsMs[id] });
  }
  receipt.finishedAt = new Date().toISOString();
  receipt.durationMs = Math.round(performance.now() - started);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  // Render only from the persisted receipt, including failures. No success grep contract.
  for (const line of renderReceipt(JSON.parse(fs.readFileSync(output, 'utf8')))) console.log(line);
  console.log(`Receipt: ${output}`);
  fs.rmSync(temp, { recursive: true, force: true });
}
