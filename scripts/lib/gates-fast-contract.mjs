import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { minimatch } from 'minimatch';

export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function assertExactFiles(expected, actual, phase) {
  const sorted = (files) => [...files].sort();
  if (!expected.length || !actual.length || new Set(actual).size !== actual.length
      || JSON.stringify(sorted(expected)) !== JSON.stringify(sorted(actual))) {
    throw new Error(`FAIL: ${phase} file set != policy list; expected=${JSON.stringify(sorted(expected))} actual=${JSON.stringify(sorted(actual))}`);
  }
}

export function validateFiles(root, files, maxFiles) {
  if (!files.length || files.length > maxFiles) throw new Error(`FAIL: selected ${files.length} files; allowed 1..${maxFiles}; never truncate`);
  for (const file of files) {
    if (typeof file !== 'string' || !/^(tests|src)\/.*\.test\.tsx?$/.test(file)
        || /[\\*?[\]{}!\n\r]/.test(file) || file.split('/').includes('..')) {
      throw new Error(`FAIL: not an exact repository test path: ${file}`);
    }
    let target;
    try { target = fs.realpathSync(path.join(root, file)); }
    catch (error) { throw new Error(`FAIL: selected test missing or unreadable: ${file}`, { cause: error }); }
    if (!target.startsWith(`${fs.realpathSync(root)}${path.sep}`) || !fs.statSync(target).isFile()) {
      throw new Error(`FAIL: test outside repository: ${file}`);
    }
  }
}

export function selectTests(policy, changed, regressions = [], deletedFiles = []) {
  const deleted = new Set(deletedFiles);
  const files = new Set(policy.baseline);
  const covered = new Set();
  const matchedRules = [];
  const matches = (file, patterns) => patterns.some((pattern) => minimatch(file, pattern, { dot: true }));
  for (const rule of policy.rules) {
    const hits = changed.filter((file) => matches(file, rule.paths));
    if (hits.length) {
      matchedRules.push(rule.id);
      hits.forEach((file) => covered.add(file));
      rule.files.forEach((file) => files.add(file));
    }
  }
  for (const entry of regressions) {
    if (!entry.reason?.trim() || !entry.files?.length || entry.files.length > 3 || !entry.paths?.length) {
      throw new Error('FAIL: manual regression needs reason, 1..3 exact files and changed paths');
    }
    for (const file of entry.paths) {
      if (!changed.includes(file)) throw new Error(`FAIL: manual regression path absent from PR: ${file}`);
      covered.add(file);
    }
    entry.files.forEach((file) => files.add(file));
  }
  for (const file of changed) {
    if (/\.test\.tsx?$/.test(file)) {
      // Keep old names above for policy matching; only Git-confirmed deletions
      // are omitted. An unexpectedly missing added/modified test still fails.
      if (!deleted.has(file)) files.add(file);
      covered.add(file);
    }
    // Documentation is the sole explicit non-code classification.
    if (/\.md$/.test(file)) covered.add(file);
  }
  const unknown = changed.filter((file) => !covered.has(file));
  if (unknown.length) throw new Error(`FAIL: unregistered PR paths need --regressions <json> with semantic reason: ${unknown.join(', ')}`);
  return {
    files: [...files].sort(), matchedRules,
    packages: policy.packages.filter((pkg) => changed.some((file) => file.startsWith(`${pkg}/`) || matches(file, policy.sharedPackageInputs))),
    testsTypecheck: changed.some((file) => matches(file, policy.testsTypecheckInputs)),
  };
}

export function validateReport(expected, report, root) {
  assertExactFiles(expected, report.testResults.map((result) => path.relative(root, result.name).split(path.sep).join('/')), 'reported');
  if (!report.success || report.numFailedTests || report.numFailedTestSuites || report.numRuntimeErrorTestSuites
      || report.unhandledErrors?.length || !report.numTotalTests
      || report.testResults.some((result) => result.status !== 'passed' || !result.assertionResults.length
        || result.assertionResults.some((test) => test.status !== 'passed'))) {
    throw new Error('FAIL: Vitest report has failed, skipped, empty tests or unhandled errors');
  }
  return { files: expected.length, tests: report.numTotalTests, passed: report.numPassedTests, hash: digest(JSON.stringify(report)) };
}

export function renderReceipt(receipt) {
  const local = receipt.status === 'passed'
    ? `✓ gates:fast passed required local preflight. schema=${receipt.schemaVersion} head=${receipt.headSha} base=${receipt.baseSha} receipt=${receipt.receiptId}`
    : `✗ gates:fast FAILED: ${receipt.error}. receipt=${receipt.receiptId}`;
  const ci = receipt.ci.status === 'pending' && receipt.prNumber === null
    ? 'CI: pending (PR not created; authoritative CI evidence will be bound after creation).'
    : `CI: ${receipt.ci.status}`;
  return [local, ci];
}
