#!/usr/bin/env node
/* global console */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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
    : process.env.GITHUB_STEP_SUMMARY
      ? path.resolve('docs/stability/flaky-ledger.jsonl')
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

function findDiagnostics(report) {
  if (!Array.isArray(report.testDiagnostics)) fail('diagnostic JSON is missing testDiagnostics[]');
  return report.testDiagnostics.map((test, index) => {
    if (typeof test?.file !== 'string' || typeof test?.test !== 'string') {
      fail(`diagnostic JSON testDiagnostics[${index}] is missing file or test`);
    }
    if (!Number.isInteger(test.retryCount) || test.retryCount < 0) {
      fail(`diagnostic JSON testDiagnostics[${index}].retryCount is not a non-negative integer`);
    }
    return {
      file: test.file,
      test: test.test,
      retryCount: test.retryCount,
      flaky: test.flaky === true,
    };
  }).filter((test) => test.retryCount > 0);
}

function findUnhandledErrors(report) {
  if (!Array.isArray(report.unhandledErrors)) fail('diagnostic JSON is missing unhandledErrors[]');
  return report.unhandledErrors.map((error, index) => {
    if (typeof error?.name !== 'string' || typeof error?.message !== 'string') {
      fail(`diagnostic JSON unhandledErrors[${index}] is missing name or message`);
    }
    for (const field of ['file', 'test', 'stack']) {
      if (error[field] !== undefined && typeof error[field] !== 'string') {
        fail(`diagnostic JSON unhandledErrors[${index}].${field} is not a string`);
      }
    }
    return {
      name: error.name,
      message: error.message,
      ...(error.file ? { file: error.file } : {}),
      ...(error.test ? { test: error.test } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    };
  });
}

function markdown(job, flakes, unhandledErrors) {
  const heading = `### Vitest flake ledger: ${job} (${flakes.length})`;
  const retryLines = flakes.length
    ? flakes.map((flake) => `- ${flake.file}:${flake.test}:${flake.retryCount}${flake.flaky ? ' (flaky=true)' : ''}`)
    : ['retryCount>0: 0'];
  const unhandledLines = [
    `unhandled errors: ${unhandledErrors.length}`,
    ...unhandledErrors.map((error) => `- ${error.file ?? '<unknown file>'}:${error.name}:${error.message}`),
  ];
  return `${heading}\n\n${[...retryLines, ...unhandledLines].join('\n')}\n`;
}

function gitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const sha = result.status === 0 ? result.stdout.trim() : '';
  if (!sha) fail('cannot resolve sha from GITHUB_SHA or git rev-parse HEAD');
  return sha;
}

const { job, ledger, command } = parseArgs(process.argv.slice(2));
const outputRoot = process.env.RUNNER_TEMP ?? os.tmpdir();
mkdirSync(outputRoot, { recursive: true });
const outputFile = path.join(outputRoot, `vitest-report-flake-ledger-${process.pid}.json`);
const diagnosticFile = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), `vitest-flake-diagnostics-${process.pid}.json`);
const reporter = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'vitest-flake-diagnostic-reporter.mjs');
const vitestArgs = [...command, '--reporter=default', '--reporter=json', `--reporter=${reporter}`, `--outputFile.json=${outputFile}`];
const result = spawnSync(vitestArgs[0], vitestArgs.slice(1), {
  stdio: 'inherit',
  env: { ...process.env, VITEST_FLAKE_LEDGER_DIAGNOSTICS_FILE: diagnosticFile },
});

if (!existsSync(outputFile)) fail(`JSON reporter did not create ${outputFile}`);

try {
  JSON.parse(readFileSync(outputFile, 'utf8'));
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

const flakes = findDiagnostics(diagnostics);
const unhandledErrors = findUnhandledErrors(diagnostics);
const summary = markdown(job, flakes, unhandledErrors);
process.stdout.write(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

if (flakes.length || unhandledErrors.length) {
  mkdirSync(path.dirname(ledger), { recursive: true });
  const at = new Date().toISOString();
  const sha = gitSha();
  const runId = process.env.GITHUB_RUN_ID;
  const records = flakes.map((flake) => ({
    at,
    sha,
    job,
    file: flake.file,
    test: flake.test,
    retryCount: flake.retryCount,
    ...(runId ? { runId } : {}),
  }));
  records.push(...unhandledErrors.map((error) => ({
    at,
    sha,
    job,
    kind: 'unhandled-error',
    ...(error.file ? { file: error.file } : {}),
    ...(error.test ? { test: error.test } : {}),
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(runId ? { runId } : {}),
  })));
  appendFileSync(ledger, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

if (result.error) fail(`could not start ${vitestArgs[0]}: ${result.error.message}`);
if (typeof result.status === 'number') process.exit(result.status);
process.exit(1);
