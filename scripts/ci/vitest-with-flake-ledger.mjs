#!/usr/bin/env node
/* global console */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

function fail(message) {
  console.error(`vitest flake ledger: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  if (separator === -1) fail('expected -- before the vitest command');

  let job;
  let ledger = process.env.RUNNER_TEMP
    ? path.join(process.env.RUNNER_TEMP, 'flaky-ledger.jsonl')
    : path.join(os.homedir(), '.ship', 'flaky-ledger.jsonl');
  for (let index = 0; index < separator; index += 1) {
    if (argv[index] === '--job') {
      job = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--ledger') {
      ledger = argv[index + 1];
      index += 1;
    } else {
      fail(`unknown option ${argv[index]}`);
    }
  }
  if (!job) fail('--job is required');
  if (!ledger) fail('--ledger requires a path');
  const command = argv.slice(separator + 1);
  if (!command.length) fail('missing vitest command');
  return { job, ledger, command };
}

function findAssertions(report) {
  return (report.testResults ?? []).flatMap((suite) => (suite.assertionResults ?? []).map((test) => ({
    file: suite.name,
    test: test.fullName ?? test.title ?? '(unnamed test)',
    retryCount: test.retryCount ?? 0,
    flaky: test.flaky === true,
  }))).filter((test) => Number(test.retryCount) > 0);
}

function findDiagnostics(report) {
  return (report.testDiagnostics ?? []).filter((test) => Number(test.retryCount) > 0).map((test) => ({
    file: test.file,
    test: test.test,
    retryCount: test.retryCount,
    flaky: test.flaky === true,
  }));
}

function markdown(job, flakes) {
  const heading = `### Vitest flake ledger: ${job} (${flakes.length})`;
  if (!flakes.length) return `${heading}\n\nretryCount>0: 0\n`;
  return `${heading}\n\n${flakes.map((flake) => `- ${flake.file}:${flake.test}:${flake.retryCount}${flake.flaky ? ' (flaky=true)' : ''}`).join('\n')}\n`;
}

function gitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

const { job, ledger, command } = parseArgs(process.argv.slice(2));
const outputFile = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), `vitest-flake-ledger-${process.pid}.json`);
const diagnosticFile = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), `vitest-flake-diagnostics-${process.pid}.json`);
const reporter = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'vitest-flake-diagnostic-reporter.mjs');
const vitestArgs = [...command, '--reporter=default', '--reporter=json', `--reporter=${reporter}`, `--outputFile.json=${outputFile}`];
const result = spawnSync(vitestArgs[0], vitestArgs.slice(1), {
  stdio: 'inherit',
  env: { ...process.env, VITEST_FLAKE_LEDGER_DIAGNOSTICS_FILE: diagnosticFile },
});

if (!existsSync(outputFile)) fail(`JSON reporter did not create ${outputFile}`);

let report;
try {
  report = JSON.parse(readFileSync(outputFile, 'utf8'));
} catch (error) {
  fail(`cannot parse JSON reporter output: ${error instanceof Error ? error.message : String(error)}`);
}

if (!existsSync(diagnosticFile)) fail(`diagnostic reporter did not create ${diagnosticFile}`);
let diagnostics;
try {
  diagnostics = JSON.parse(readFileSync(diagnosticFile, 'utf8'));
} catch (error) {
  fail(`cannot parse diagnostic reporter output: ${error instanceof Error ? error.message : String(error)}`);
}

const flakes = findDiagnostics(diagnostics).length ? findDiagnostics(diagnostics) : findAssertions(report);
const summary = markdown(job, flakes);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
} else {
  process.stdout.write(summary);
}

if (flakes.length) {
  mkdirSync(path.dirname(ledger), { recursive: true });
  const at = new Date().toISOString();
  const sha = gitSha();
  const runId = process.env.GITHUB_RUN_ID;
  appendFileSync(ledger, flakes.map((flake) => JSON.stringify({
    at,
    sha,
    job,
    file: flake.file,
    test: flake.test,
    retryCount: flake.retryCount,
    ...(runId ? { runId } : {}),
  })).join('\n') + '\n');
}

if (result.error) fail(`could not start ${vitestArgs[0]}: ${result.error.message}`);
if (typeof result.status === 'number') process.exit(result.status);
process.exit(1);
