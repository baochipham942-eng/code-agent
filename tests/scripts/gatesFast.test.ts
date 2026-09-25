import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import policy from '../../scripts/lib/gates-fast-policy.json';
import {
  assertExactFiles, selectTests, validateFiles, validateReport, renderReceipt, digest,
  validateBudgetPolicy, validateGateBudgetCoverage, extractGateIds, commandDeadline, budgetFailure,
} from '../../scripts/lib/gates-fast-contract.mjs';

const root = path.resolve(__dirname, '../..');
describe('fast gate fail-closed contracts', () => {
  it('rejects missing, extra, duplicate and empty actual selections before execution', () => {
    for (const actual of [[], ['a'], ['a', 'b', 'c'], ['a', 'a', 'b']]) {
      expect(() => assertExactFiles(['a', 'b'], actual, 'before execution')).toThrow('file set != policy list');
    }
    expect(() => assertExactFiles(['a', 'b'], ['b', 'a'], 'before execution')).not.toThrow();
    expect(() => assertExactFiles([], [], 'before execution')).toThrow();
  });
  it('rejects wildcard, missing, out-of-root and oversized exact lists', () => {
    for (const files of [[], ['tests/unit/*.test.ts'], ['tests/../escape.test.ts'], ['tests/absent.test.ts'], Array(13).fill(policy.baseline[0])]) {
      expect(() => validateFiles(root, files, 12)).toThrow();
    }
    validateFiles(root, policy.baseline, 12);
  });
  it('requires semantic manual registration for unmapped business paths', () => {
    const changed = ['src/host/agent/newBehavior.ts'];
    expect(() => selectTests(policy, changed)).toThrow('unregistered PR paths');
    expect(() => selectTests(policy, ['packages/eval-harness/src/graders/ForbiddenPatterns.ts'])).toThrow('unregistered PR paths');
    expect(() => selectTests(policy, ['src/host/testing/gaiaScorer.ts'])).toThrow('unregistered PR paths');
    const selected = selectTests(policy, changed, [{ paths: changed, files: [policy.baseline[0]], reason: 'Validates emitted event contract' }]);
    expect(selected.files).toEqual([...policy.baseline].sort());
    expect(() => selectTests(policy, changed, [{ paths: changed, files: [policy.baseline[0]], reason: '' }])).toThrow();
  });
  it('rejects desktop smoke, broken fixtures and native tests before execution', () => {
    for (const file of [
      'tests/smoke/multiAgentBrowserIsolation.smoke.test.ts',
      'tests/e2e/claude-e2e/fixtures/bug-logic-array/src/utils/array.test.ts',
      'tests/unit/graphStore.test.ts',
      'tests/node_modules/example/example.test.ts',
    ]) {
      const selected = selectTests(policy, [file]);
      expect(() => validateFiles(root, selected.files, 12)).toThrow(`FAIL: test path is excluded from fast execution: ${file}`);
    }
  });
  it('unions explicit rules, both rename paths and changed tests', () => {
    const changed = ['src/host/prompts/old.ts', 'src/renderer/slots/new.ts', 'tests/unit/newBehavior.test.ts'];
    const selected = selectTests(policy, changed);
    expect(selected.files).toContain('tests/scripts/promptGateEvidence.test.ts');
    expect(selected.files).toContain('tests/renderer/slots/slotRegistry.test.tsx');
    expect(selected.files).toContain('tests/unit/newBehavior.test.ts');
    expect(selected.testsTypecheck).toBe(true);
    expect(selectTests(policy, ['package.json']).packages).toEqual(policy.packages);
  });
  it('matches deleted/renamed paths but only executes surviving test files', () => {
    const oldFile = 'tests/unit/oldBehavior.test.ts';
    const newFile = 'tests/unit/newBehavior.test.ts';
    const renamed = selectTests(policy, [oldFile, newFile], [], [oldFile]);
    expect(renamed.files).not.toContain(oldFile);
    expect(renamed.files).toContain(newFile);
    expect(selectTests(policy, [oldFile], [], [oldFile]).files).toEqual([...policy.baseline].sort());
    const oldPromptTest = 'src/host/prompts/old.test.ts';
    expect(selectTests(policy, [oldPromptTest], [], [oldPromptTest]).files).toContain('tests/scripts/promptGateEvidence.test.ts');
    // Missing files without a Git deletion must never silently fall out of selection.
    const missing = selectTests(policy, [oldFile]);
    expect(() => validateFiles(root, missing.files, 12)).toThrow('FAIL: selected test missing or unreadable');
  });
  it('distinguishes fast-policy changes from full-lock changes', () => {
    expect(selectTests(policy, ['scripts/gates-fast.mjs']).files).not.toContain('tests/scripts/gatesLocalLock.test.ts');
    expect(selectTests(policy, ['scripts/lib/gates-local-lock.mjs']).files).toContain('tests/scripts/gatesLocalLock.test.ts');
  });
  it('a new e2e spec selects the axe wiring ratchet within the 12-file cap', () => {
    const selected = selectTests(policy, ['tests/e2e/x.spec.ts']);
    expect(selected.matchedRules).toContain('axe-e2e-wiring');
    expect(selected.files).toContain('tests/scripts/a11yAxeRatchet.test.ts');
    expect(selected.files).toHaveLength(policy.baseline.length + 1);
    validateFiles(root, selected.files, 12);
  });
  it('journey probes occupy one file slot each and stay off unrelated host paths', () => {
    const journeyIds = [
      'perf-journey-cold-start',
      'perf-journey-first-token',
      'perf-journey-long-session',
      'perf-journey-session-switch',
    ];
    for (const id of journeyIds) {
      const rule = policy.rules.find((entry) => entry.id === id);
      expect(rule, id).toBeTruthy();
      expect(rule?.files, id).toHaveLength(1);
    }
    const unrelated = selectTests(policy, ['src/host/prompts/old.ts']);
    expect(unrelated.matchedRules).not.toEqual(expect.arrayContaining(journeyIds));
  });
  it('rejects misleading successful reports: wrong files, zero tests, skipped tests and runtime errors', () => {
    const good = { success: true, numTotalTests: 1, numPassedTests: 1, testResults: [{ name: path.join(root, policy.baseline[0]), status: 'passed', assertionResults: [{ status: 'passed' }] }] };
    expect(validateReport([policy.baseline[0]], good, root).tests).toBe(1);
    for (const bad of [
      { ...good, testResults: [] }, { ...good, numTotalTests: 0 },
      { ...good, numRuntimeErrorTestSuites: 1 }, { ...good, unhandledErrors: [{ message: 'orphan rejection' }] },
      { ...good, testResults: [{ ...good.testResults[0], assertionResults: [] }] },
      { ...good, testResults: [{ ...good.testResults[0], assertionResults: [{ status: 'pending' }] }] },
    ]) expect(() => validateReport([policy.baseline[0]], bad, root)).toThrow();
  });
  it('budgets: per-gate cap and total ceiling are separate limits with separate failure wording', () => {
    expect(() => validateBudgetPolicy(policy)).not.toThrow();
    expect(() => validateBudgetPolicy({ ...policy, budgetMs: 180000 })).toThrow('ship outer timeout');
    expect(() => validateBudgetPolicy({ ...policy, budgetsMs: {} })).toThrow('per-gate budgets');
    expect(() => validateBudgetPolicy({ ...policy, budgetsMs: { ...policy.budgetsMs, vitest: policy.budgetMs + 1 } })).toThrow('budgetsMs.vitest');
    const p = { budgetMs: 100, budgetsMs: { a: 30 } };
    expect(commandDeadline(p, 'a', 10, 5)).toEqual({ limit: 'gate', limitMs: 30, remainingMs: 25, gateId: 'a' });
    expect(commandDeadline(p, 'a', 90, 5)).toEqual({ limit: 'total', limitMs: 100, remainingMs: 10, gateId: 'a' });
    expect(commandDeadline(p, undefined, 40, 0)).toEqual({ limit: 'total', limitMs: 100, remainingMs: 60, gateId: null });
    expect(budgetFailure(commandDeadline(p, 'a', 10, 40), ['node', 'x'])).toBe('FAIL: gate budget 30ms exceeded (gate a) in node x');
    expect(budgetFailure(commandDeadline(p, 'a', 120, 0), ['node', 'x'])).toBe('FAIL: total budget 100ms exhausted (gate a) in node x');
  });
  it('对账 gates-fast.mjs 的 gate() 注册与 budgetsMs，缺项和多余项都 fail-closed', () => {
    const source = `await gate('inputs', true, run);\nawait gate("vitest", true, run);`;
    expect(extractGateIds(source)).toEqual(['inputs', 'vitest']);
    expect(() => validateGateBudgetCoverage({ ...policy, budgetsMs: { inputs: 100 } }, ['inputs', 'vitest']))
      .toThrow('missing budgetsMs key(s): vitest');
    expect(() => validateGateBudgetCoverage({ ...policy, budgetsMs: { inputs: 100, vitest: 100, retired: 100 } }, extractGateIds(source)))
      .toThrow('unknown budgetsMs key(s): retired');
    expect(() => validateGateBudgetCoverage({ ...policy, budgetsMs: { inputs: 100, vitest: 100 } }, ['inputs', 'vitest']))
      .not.toThrow();
    expect(() => extractGateIds("await gate('inputs', true, run); await gate('inputs', false, run);"))
      .toThrow('duplicate gate registration: inputs');
  });
  it('policy leaves 2x headroom over the measured agent-core PR under load (09-15 route-domains TASK run, 3 receipts)', () => {
    // 09-15 负载 ~10 下 TASK 刀逐格实测最大值（tests-typecheck 取单跑 16.7s，vitest 取工单记录的 agentOrchestrator 选中 22.6s）
    const measured: Record<string, number> = {
      inputs: 600, provider: 100, private: 9300, 'src-typecheck': 8800, shell: 100,
      'commit-checks': 11700, vitest: 22600, 'package-typechecks': 7400, 'tests-typecheck': 16700,
    };
    const budgets = policy.budgetsMs as Record<string, number>;
    for (const [id, ms] of Object.entries(measured)) expect(budgets[id], id).toBeGreaterThanOrEqual(ms * 2);
    expect(Object.values(measured).reduce((a, b) => a + b, 0) * 2).toBeLessThanOrEqual(policy.budgetMs);
  });
  it('renders the persisted receipt values and never renders success for a failure', () => {
    const receipt = JSON.parse(JSON.stringify({ schemaVersion: 2, status: 'passed', headSha: 'head', baseSha: 'base', receiptId: 'id', ci: { status: 'pending' }, prNumber: null }));
    expect(renderReceipt(receipt)).toEqual([
      '✓ gates:fast passed required local preflight. schema=2 head=head base=base receipt=id',
      'CI: pending (PR not created; authoritative CI evidence will be bound after creation).',
    ]);
    expect(renderReceipt({ ...receipt, status: 'failed', error: 'budget exceeded' })[0]).toContain('FAILED: budget exceeded');
    expect(digest('private-v1')).not.toBe(digest('private-v2'));
  });
  it('checks committed prompt changes with an empty index using base/head', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-prompt-contract-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
    try {
      git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
      git('config', 'core.hooksPath', '/dev/null');
      fs.mkdirSync(path.join(dir, 'src/host/prompts'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'src/shared/constants'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src/host/prompts/test.ts'), 'export const prompt = "before";\n');
      fs.writeFileSync(path.join(dir, 'src/shared/constants/agent.ts'), "export const PROMPT_VERSION = 'sys-v1';\n");
      git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
      fs.writeFileSync(path.join(dir, 'src/host/prompts/test.ts'), 'export const prompt = "after";\n');
      git('add', '.'); git('commit', '-qm', 'head');
      const script = path.join(root, 'scripts/check-prompt-version-bump.sh');
      expect(() => execFileSync('bash', [script, '--base', base, '--head', 'HEAD'], { cwd: dir, stdio: 'pipe' })).toThrow();
      expect(() => execFileSync('bash', [script], { cwd: dir, stdio: 'pipe' })).not.toThrow();
      fs.writeFileSync(path.join(dir, 'src/shared/constants/agent.ts'), "export const PROMPT_VERSION = 'sys-v2';\n");
      git('add', '.'); git('commit', '-qm', 'bump');
      expect(() => execFileSync('bash', [script, '--base', base, '--head', 'HEAD'], { cwd: dir, stdio: 'pipe' })).not.toThrow();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
