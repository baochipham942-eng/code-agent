#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  NotRun,
  assertEnv,
  createLegContext,
  resolveEnv,
  validateLeg,
} from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scenarioDir = path.join(here, 'scenarios');

function usage() {
  return `Usage: node scripts/scenario/run.mjs <scenario-id> [options]

Run a real-machine scenario against an already-running Agent Neo Dev slot.

Arguments:
  <scenario-id>              Scenario id from scripts/scenario/scenarios/

Options:
  --all                      Run all scenarios (serially).
  --cost free                Only run free scenarios.
  --cost-ack                 Required for paid scenarios in non-interactive runs.
  --slot <N>                 Dev slot; defaults to NEO_SLOT or 1.
  --require-commit <sha>     Require this commit to be an ancestor of the app build.
  --expect <pass|fail|not_run>
                             Exit 0 only when the observed verdict matches.
  --scenario-file <path>     Load one explicit scenario file (validation use).
  -h, --help                 Show this help.

Exit codes: 0 PASS, 1 FAIL, 2 NOT_RUN, 3 SCENARIO_INVALID.
Reports: scripts/scenario/.out/<id>-<timestamp>/report.json`;
}

function parseArgs(argv) {
  const options = { all: false, cost: null, costAck: false, slot: null, requireCommit: null, expect: null, scenarioFile: null, id: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { help: true };
    if (arg === '--all') options.all = true;
    else if (arg === '--cost-ack') options.costAck = true;
    else if (arg === '--cost' || arg === '--slot' || arg === '--require-commit' || arg === '--expect' || arg === '--scenario-file') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--cost') options.cost = value;
      if (arg === '--slot') options.slot = Number.parseInt(value, 10);
      if (arg === '--require-commit') options.requireCommit = value;
      if (arg === '--expect') options.expect = value;
      if (arg === '--scenario-file') options.scenarioFile = value;
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (!options.id) options.id = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (options.expect && !['pass', 'fail', 'not_run'].includes(options.expect)) throw new Error('--expect must be pass, fail, or not_run');
  if (options.cost && !['free', 'paid'].includes(options.cost)) throw new Error('--cost must be free or paid');
  if (!options.all && !options.id && !options.scenarioFile) throw new Error('A scenario id, --all, or --scenario-file is required');
  if (options.all && (options.id || options.scenarioFile)) throw new Error('--all cannot be combined with a scenario id or --scenario-file');
  return options;
}

function stamp() { return new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z'); }
function codeFor(verdict) { return verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : verdict === 'NOT_RUN' ? 2 : 3; }

async function loadScenario(options) {
  let scenarioPath;
  if (options.scenarioFile) scenarioPath = path.resolve(options.scenarioFile);
  else scenarioPath = path.join(scenarioDir, `${options.id}.mjs`);
  if (!fs.existsSync(scenarioPath)) throw new Error(`Scenario file not found: ${scenarioPath}`);
  const imported = await import(pathToFileURL(scenarioPath).href);
  return { scenario: imported.default, scenarioPath };
}

function staticValidation(scenario) {
  const invalid = [];
  if (!scenario || typeof scenario !== 'object') invalid.push('default export must be an object');
  if (!scenario?.id || typeof scenario.id !== 'string') invalid.push('scenario id is required');
  if (!scenario?.legs || typeof scenario.legs !== 'object') invalid.push('legs are required');
  for (const legName of ['negative', 'positive']) {
    if (typeof scenario?.legs?.[legName] !== 'function') invalid.push(`missing ${legName} leg`);
  }
  return invalid;
}

async function runScenario({ scenario, scenarioPath, options }) {
  const outDir = path.join(here, '.out', `${scenario?.id || 'invalid'}-${stamp()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const report = {
    id: scenario?.id || null,
    module: scenario?.module || null,
    scenarioPath,
    startedAt: new Date().toISOString(),
    verdict: null,
    reason: null,
    environment: null,
    health: null,
    legs: {},
    teardownClean: true,
    invalid: [],
  };
  const staticInvalid = staticValidation(scenario);
  if (staticInvalid.length) {
    report.verdict = 'SCENARIO_INVALID'; report.reason = 'scenario_shape_invalid'; report.invalid.push(...staticInvalid);
    return writeReport(outDir, report);
  }

  const env = resolveEnv({ slot: options.slot });
  report.environment = { ...env, token: env.token ? '[present]' : null };
  if (scenario.cost === 'paid' && !process.stdin.isTTY && !options.costAck) {
    report.verdict = 'NOT_RUN'; report.reason = 'cost_ack_required';
    report.evidence = { cost: scenario.cost, hint: 'Run with --cost-ack after the nightly cost authorization is in place.' };
    return writeReport(outDir, report);
  }
  let checked;
  try {
    checked = await assertEnv(env, { requireCommit: options.requireCommit });
    report.health = checked.health;
  } catch (error) {
    if (error instanceof NotRun) {
      report.verdict = 'NOT_RUN'; report.reason = error.reason; report.evidence = error.evidence;
      return writeReport(outDir, report);
    }
    throw error;
  }

  for (const legName of ['negative', 'positive']) {
    const ctx = createLegContext({ env, api: checked.api, outDir, scenario, legName });
    const leg = { verdict: null, reason: null, evidence: null, assertions: ctx.assertions, startedAt: new Date().toISOString() };
    try {
      await scenario.legs[legName](ctx);
      leg.verdict = ctx.assertions.every((assertion) => assertion.ok) ? 'PASS' : 'FAIL';
    } catch (error) {
      if (error instanceof NotRun) {
        leg.verdict = 'NOT_RUN'; leg.reason = error.reason; leg.evidence = error.evidence;
      } else {
        leg.verdict = 'FAIL'; leg.reason = 'leg_exception'; leg.evidence = { message: error instanceof Error ? error.stack || error.message : String(error) };
      }
    } finally {
      const finish = await ctx.finish();
      leg.finishedAt = new Date().toISOString();
      leg.teardown = finish;
      report.teardownClean &&= finish.teardownClean;
      report.invalid.push(...validateLeg({ legName, assertions: ctx.assertions, openedEvents: finish.streams.length }));
      if (finish.streams.some((stream) => stream.receivedCount === 0)) {
        leg.verdict = 'NOT_RUN'; leg.reason = 'sse_no_events'; leg.evidence = { streams: finish.streams };
      }
    }
    report.legs[legName] = leg;
  }
  if (report.invalid.length) {
    report.verdict = 'SCENARIO_INVALID'; report.reason = 'scenario_assertion_contract_invalid';
  } else if (!report.teardownClean) {
    report.verdict = 'FAIL'; report.reason = 'teardown_failed';
  } else if (Object.values(report.legs).some((leg) => leg.verdict === 'FAIL')) {
    report.verdict = 'FAIL'; report.reason = 'assertion_failed';
  } else if (Object.values(report.legs).every((leg) => leg.verdict === 'PASS')) {
    report.verdict = 'PASS';
  } else {
    report.verdict = 'NOT_RUN';
    report.reason = Object.values(report.legs).find((leg) => leg.reason)?.reason || 'leg_not_run';
  }
  return writeReport(outDir, report);
}

function writeReport(outDir, report) {
  report.finishedAt = new Date().toISOString();
  const reportPath = path.join(outDir, 'report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`scenario ${report.id || path.basename(report.scenarioPath)}: ${report.verdict}${report.reason ? ` (${report.reason})` : ''}`);
  console.log(`report: ${reportPath}`);
  return { report, reportPath };
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(`error: ${error.message}\n\n${usage()}`); return 3; }
  if (options.help) { console.log(usage()); return 0; }
  const loaded = [];
  if (options.all) {
    for (const file of fs.readdirSync(scenarioDir).filter((name) => name.endsWith('.mjs')).sort()) {
      const imported = await import(pathToFileURL(path.join(scenarioDir, file)).href);
      if (!options.cost || imported.default?.cost === options.cost) loaded.push({ scenario: imported.default, scenarioPath: path.join(scenarioDir, file) });
    }
  } else loaded.push(await loadScenario(options));
  if (!loaded.length) { console.error('No scenarios match the requested selection.'); return 3; }
  const results = [];
  for (const item of loaded) results.push(await runScenario({ ...item, options }));
  const verdict = results.some(({ report }) => report.verdict === 'SCENARIO_INVALID') ? 'SCENARIO_INVALID'
    : results.some(({ report }) => report.verdict === 'FAIL') ? 'FAIL'
      : results.some(({ report }) => report.verdict === 'NOT_RUN') ? 'NOT_RUN' : 'PASS';
  if (options.expect) return verdict.toLowerCase() === options.expect ? 0 : 1;
  return codeFor(verdict);
}

main().then((exitCode) => { process.exitCode = exitCode; }).catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
