import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/a11y-axe-ratchet.mjs');
const roots: string[] = [];

function buildReport(ruleCounts: Record<string, number>) {
  const violations = Object.entries(ruleCounts).map(([id, count]) => ({
    id,
    impact: 'serious',
    tags: ['wcag2a'],
    description: `${id} description`,
    help: `${id} help`,
    helpUrl: `https://example.invalid/${id}`,
    nodes: Array.from({ length: count }, (_, index) => ({ target: [`#node-${index}`] })),
  }));
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-31T00:00:00Z',
    source: {
      package: '@axe-core/playwright',
      version: '4.13.0',
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    },
    totals: {
      scans: 1,
      rules: Object.keys(ruleCounts).length,
      hits: Object.values(ruleCounts).reduce((sum, count) => sum + count, 0),
    },
    ruleCounts,
    scans: [{
      schemaVersion: 1,
      scanName: 'automatic',
      root: 'document',
      url: 'http://127.0.0.1:4173/',
      scannedAt: '2026-08-31T00:00:00Z',
      testId: 'fixture-test',
      spec: 'tests/e2e/fixture.spec.ts',
      titlePath: ['fixture.spec.ts', 'fixture'],
      projectName: '',
      retry: 0,
      violations,
    }],
  };
}

function fixture({
  baselineCounts = { 'button-name': 2, 'color-contrast': 1 },
  reportCounts = baselineCounts,
}: {
  baselineCounts?: Record<string, number>;
  reportCounts?: Record<string, number>;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'a11y-axe-ratchet-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'test-results/axe'), { recursive: true });
  const baseline = {
    schemaVersion: 1,
    measuredAt: '2026-08-31T00:00:00Z',
    source: 'Swarm full CI fixture',
    ruleCounts: baselineCounts,
  };
  writeFileSync(join(root, 'scripts/a11y-axe-ratchet-baseline.json'), JSON.stringify(baseline));
  writeFileSync(join(root, 'test-results/axe/axe-report.json'), JSON.stringify(buildReport(reportCounts)));
  return { root, baseline };
}

function run(root: string, args: string[] = []) {
  return spawnSync(process.execPath, [script, '--repo-root', root, ...args], { encoding: 'utf8' });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('a11y-axe-ratchet', () => {
  it('规则命中数持平时通过', () => {
    const { root } = fixture();
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Pass: 1 scans; 2 violated rules; 3 violating nodes');
  });

  it('已有规则的节点计数上升时通过并报告波动', () => {
    const { root } = fixture({ reportCounts: { 'button-name': 3, 'color-contrast': 1 } });
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('button-name 计数波动（报告制）：2 -> 3 (+1)');
    expect(result.stdout).toContain('0 new rule types; 1 existing-rule count drifts reported');
  });

  it('新增违规规则类型时阻断', () => {
    const { root } = fixture({ reportCounts: {
      'button-name': 2,
      'color-contrast': 1,
      'nested-interactive': 1,
    } });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('新增违规规则类型：nested-interactive（1 个节点）');
    expect(result.stderr).toContain('运行时可访问性新增了 1 个违规规则类型');
  });

  it('报告产物缺失时 fail loud', () => {
    const { root } = fixture();
    rmSync(join(root, 'test-results/axe/axe-report.json'));
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('自检失败：无法读取 axe 报告');
  });

  it('已有规则的节点计数下降时通过并报告波动', () => {
    const { root } = fixture({ reportCounts: { 'button-name': 1 } });
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('button-name 计数波动（报告制）：2 -> 1 (-1)');
    expect(result.stderr).toContain('color-contrast 计数波动（报告制）：1 -> 0 (-1)');
  });

  it('record 模式输出可直接回填的 CI 基线候选且不读取占位基线', () => {
    const { root } = fixture();
    rmSync(join(root, 'scripts/a11y-axe-ratchet-baseline.json'));
    const result = run(root, ['--record']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Record-only: 1 scans, 2 violated rules, 3 violating nodes');
    expect(result.stdout).toContain('"button-name": 2');
  });

  it('已建立的基线只许降不许升', () => {
    const { root, baseline } = fixture();
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });

    writeFileSync(join(root, 'scripts/a11y-axe-ratchet-baseline.json'), JSON.stringify({
      ...baseline,
      ruleCounts: { ...baseline.ruleCounts, 'button-name': 3 },
    }));
    writeFileSync(join(root, 'test-results/axe/axe-report.json'), JSON.stringify(buildReport({
      'button-name': 3,
      'color-contrast': 1,
    })));
    const result = run(root, ['--compare-baseline', 'HEAD']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('button-name 报告参考计数上调：2 -> 3');
    expect(result.stderr).toContain('axe 基线只许删除规则类型或下调报告参考计数');
  });

  it('基线不得新增规则类型', () => {
    const { root, baseline } = fixture();
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });

    writeFileSync(join(root, 'scripts/a11y-axe-ratchet-baseline.json'), JSON.stringify({
      ...baseline,
      ruleCounts: { ...baseline.ruleCounts, 'nested-interactive': 1 },
    }));
    writeFileSync(join(root, 'test-results/axe/axe-report.json'), JSON.stringify(buildReport({
      ...baseline.ruleCounts,
      'nested-interactive': 1,
    })));
    const result = run(root, ['--compare-baseline', 'HEAD']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('新增基线规则类型：nested-interactive');
  });
});

describe('axe e2e wiring', () => {
  it('当前全部 27 个 spec 走自动 fixture，配置统一挂聚合 reporter', () => {
    const specFiles = readdirSync('tests/e2e')
      .filter((file) => file.endsWith('.spec.ts'))
      .sort();
    expect(specFiles).toHaveLength(27);
    for (const file of specFiles) {
      const source = readFileSync(join('tests/e2e', file), 'utf8');
      expect(source, file).toContain("from './fixtures/axeTest'");
      expect(source, file).not.toContain("from '@playwright/test'");
      expect(source, file).not.toContain('new AxeBuilder');
    }

    for (const config of [
      'tests/e2e/playwright.e2e.config.ts',
      'tests/e2e/playwright.system-chrome.config.ts',
      'tests/e2e/playwright.internal-plugin.config.ts',
    ]) {
      expect(readFileSync(config, 'utf8'), config).toContain("'./fixtures/axeReporter.ts'");
    }
  });

  it('swarm-ci 在跑棘轮前显式抓 origin/main（PR merge 浅克隆没有该引用）', () => {
    // full job 的 checkout 只有 PR merge 提交，不带 origin/main 远程跟踪引用；
    // 不显式 fetch 时棘轮自检 exit 1「Not a valid object name origin/main」。
    const workflow = readFileSync('.github/workflows/swarm-ci.yml', 'utf8');
    const ratchetStep = workflow.slice(
      workflow.indexOf('Check axe runtime accessibility ratchet'),
    );
    const fetchPos = ratchetStep.indexOf('git fetch');
    const runPos = ratchetStep.indexOf('a11y-axe-ratchet.mjs --compare-baseline');
    expect(fetchPos, '棘轮步骤缺少 git fetch origin/main').toBeGreaterThanOrEqual(0);
    expect(runPos, '棘轮步骤缺少 compare-baseline 调用').toBeGreaterThan(fetchPos);
  });

  it('swarm-ci 上传 CI 视觉基线，失败 artifact 保留 screenshot diff 三件套', () => {
    const workflow = readFileSync('.github/workflows/swarm-ci.yml', 'utf8');
    expect(workflow).toContain('tests/e2e/**/*-snapshots/*.png');
    expect(workflow).toContain('test-results/');
  });
});
