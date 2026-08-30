import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { ExperimentAdapter } from '@internal-evaluation/host/evaluation/experimentAdapter';
import type { DatabaseService } from '../../../src/host/services/core/databaseService';
import { ExperimentRepository } from '../../../src/host/services/core/repositories/ExperimentRepository';
import { AnnotationRepository } from '../../../src/host/services/core/repositories/AnnotationRepository';
import { applyAnnotationsSchema } from '../../../src/host/services/core/database/schemaAnnotations';
import { buildEvalExperimentCaseDetail } from '@internal-evaluation/host/evaluation/evalCaseDetail';
import { buildCaseEvidence } from '@internal-evaluation-scripts/lib/eval-case-evidence';
import { EXPECTATION_TYPE_CATALOG } from '../../../src/host/testing/expectationCatalog';
import { UNKNOWN_EVAL_RUN_STAMP, type EvalRunEvent, type EvalExperimentCaseDetail, type ListEvalAnnotationsResult } from '../../../src/shared/contract/evaluation';
import type { TestResult } from '../../../src/host/testing/types';

type Scenario = 'a1' | 'a2' | 'a8' | 'a12' | 'c2' | 'a13a' | 'a13b' | 'a13c'
  | 'a13-annotation-empty' | 'a13-annotation-prefill'
  | 'c1a' | 'c1b-disabled' | 'c1b-ready' | 'c1c';
type Theme = 'light' | 'dark';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = process.env.RUNPANEL_EVIDENCE_DIR ?? path.join(here, 'artifacts', 'screenshots');
const referenceHtml = process.env.RUNPANEL_REFERENCE_HTML;
const scenarioNames = new Set<Scenario>([
  'a1', 'a2', 'a8', 'a12', 'c2', 'a13a', 'a13b', 'a13c',
  'a13-annotation-empty', 'a13-annotation-prefill',
  'c1a', 'c1b-disabled', 'c1b-ready', 'c1c',
]);
const requestedScenarios = (process.env.RUNPANEL_SCENARIOS?.split(',') ?? [...scenarioNames])
  .map((value) => value.trim())
  .filter((value): value is Scenario => scenarioNames.has(value as Scenario));

if (requestedScenarios.length === 0) throw new Error('RUNPANEL_SCENARIOS contains no known scenario.');

if (process.env.NEO_SLOT !== 'runpanel') {
  throw new Error('Run with NEO_SLOT=runpanel so this visual proof never shares dev/dev2/chatprobe.');
}

function baseResult(testId: string): TestResult {
  return {
    testId, description: testId, prompt: '请读取 sales.csv，按区域生成 out/summary.html，并打开确认渲染正常。',
    status: 'failed', score: 0.75, duration: 38_000, startTime: 0, endTime: 38_000,
    toolExecutions: [{ tool: 'write_file', input: { path: 'out/summary.html' }, output: '', success: false, error: '路径写入被拒绝', duration: 120, timestamp: 1 }],
    responses: ['汇总逻辑已经完成，但报告文件没有成功写入。'], errors: [], turnCount: 1,
    expectationResults: [
      { expectation: { type: 'tool_called', description: 'write', params: {} }, passed: true, evidence: { expected: 'write_file', actual: 1 }, duration: 1 },
      { expectation: { type: 'file_exists', description: 'file', params: {} }, passed: false, evidence: { expected: 'out/summary.html', actual: '不存在' }, duration: 1 },
      { expectation: { type: 'command_succeeds', description: 'check', params: {} }, passed: true, evidence: { expected: 0, actual: 0 }, duration: 1 },
      { expectation: { type: 'no_crash', description: 'crash', params: {} }, passed: true, evidence: { expected: true, actual: true }, duration: 1 },
    ],
    trials: [
      { status: 'failed', score: 0, duration_ms: 12_000, failureReason: '缺少预期产物' },
      { status: 'passed', score: 1, duration_ms: 11_000 },
      { status: 'failed', score: 0, duration_ms: 15_000, failureReason: '缺少预期产物' },
    ],
  };
}

async function writeCaseDrawerFixture(): Promise<{ fixturePath: string; annotationPath: string; reportPath: string }> {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE experiments (id TEXT PRIMARY KEY, name TEXT, timestamp INTEGER, model TEXT, provider TEXT, scope TEXT, config_json TEXT, summary_json TEXT, source TEXT, git_commit TEXT);
    CREATE TABLE experiment_cases (id TEXT PRIMARY KEY, experiment_id TEXT, case_id TEXT, session_id TEXT, status TEXT, score INTEGER, duration_ms INTEGER, data_json TEXT);
  `);
  applyAnnotationsSchema(db, { debug() {}, info() {}, warn() {}, error() {} } as never);
  const repo = new ExperimentRepository(db);
  const annotations = new AnnotationRepository(db);
  const writer: Pick<DatabaseService, 'insertExperiment' | 'insertExperimentCases' | 'updateExperimentSummary'> = {
    insertExperiment: (row) => repo.insertExperiment(row),
    insertExperimentCases: (id, rows) => repo.insertExperimentCases(id, rows),
    updateExperimentSummary: (id, summary) => repo.updateExperimentSummary(id, summary),
  };
  const adapter = new ExperimentAdapter(writer);
  const runId = 'visual-casedrawer-run';
  const config = {
    ...UNKNOWN_EVAL_RUN_STAMP,
    promptVersion: 'sys-v44', mode: 'real' as const, model: 'deepseek-chat', provider: 'deepseek',
    scope: 'full' as const, maxCases: 3, concurrency: 1, gitCommit: 'be7ea7617', testCaseDir: '.claude/test-cases',
  };
  adapter.beginEventRun({ schemaVersion: 3, type: 'run_start', ts: 1, runId, plannedCaseIds: ['TC-026', 'TC-041', 'TC-058'], config });

  const failing = baseResult('TC-026');
  const infra = baseResult('TC-041');
  infra.status = 'infra_excluded';
  infra.failureReason = 'HTTP 429 rate limit';
  infra.expectationResults = [];
  infra.toolExecutions = [];
  infra.responses = [];
  infra.trials = [1, 2, 3].map(() => ({ status: 'infra_excluded' as const, score: 0, duration_ms: 4_000, failureReason: 'HTTP 429 rate limit' }));
  const multi = baseResult('TC-058');
  multi.prompt = '给我建一个 demo.html，里面放一张销售数据表格。';
  multi.simTurns = [
    { ruleId: 'reject-create', action: 'respond', message: '别新建文件，直接在原文件里改。', toolExecutionsBefore: 1, responsesBefore: 1 },
    { ruleId: 'sort-by-region', action: 'respond', message: '现在把表格按区域排序。', toolExecutionsBefore: 2, responsesBefore: 2 },
  ];
  multi.expectationResults = multi.expectationResults?.slice(0, 3);
  multi.trials = undefined;

  const rows: Array<{ result: TestResult; event: Partial<Extract<EvalRunEvent, { type: 'case_end' }>> }> = [
    { result: failing, event: { status: 'failed', failureReason: 'Expected file out/summary.html to exist', failure: { code: 'missing_artifact', dispositions: ['needs_human'], symptoms: ['missing_artifact'] }, trials: 3 } },
    { result: infra, event: { status: 'infra_excluded', failureReason: 'HTTP 429 rate limit', trials: 3 } },
    { result: multi, event: { status: 'failed', failureReason: '输出内容不符合预期', failure: { code: 'wrong_output', dispositions: ['needs_human'], symptoms: ['wrong_output'] } } },
  ];
  for (const [index, item] of rows.entries()) {
    adapter.persistEventCase({
      schemaVersion: 3, type: 'case_end', ts: index + 2, runId, testId: item.result.testId,
      status: item.event.status ?? item.result.status, score: item.result.score, durationMs: item.result.duration,
      ...item.event, evidence: buildCaseEvidence(item.result),
    });
  }
  const reportPath = path.join(here, '.generated-casedrawer-report.md');
  await fs.writeFile(reportPath, '# N-EVAL-CASEDRAWER screenshot fixture\n');
  adapter.finishEventRun(runId, {
    runId, startTime: 1, endTime: 5, duration: 4, total: 3, passed: 0, failed: 2, skipped: 0,
    partial: 0, infraExcluded: 1, averageScore: 0.5, plannedCaseIds: ['TC-026', 'TC-041', 'TC-058'],
    completed: true, notRun: 0, invalidCases: 0, reportFiles: [reportPath],
  });
  const labels: Record<string, string> = { 'TC-026': '缺少预期产物', 'TC-058': '输出内容不符合预期' };
  const details: Record<string, EvalExperimentCaseDetail> = {};
  for (const caseId of ['TC-026', 'TC-041', 'TC-058']) {
    const row = repo.loadExperimentCase(runId, caseId);
    if (!row) throw new Error(`missing persisted visual case ${caseId}`);
    details[caseId] = buildEvalExperimentCaseDetail({
      row, assertionCatalog: EXPECTATION_TYPE_CATALOG,
      ...(labels[caseId] ? { failureLabel: labels[caseId] } : {}),
      caseMetadata: {
        id: caseId, file: 'visual.yaml', relativeDir: '', layer: '任务', type: caseId === 'TC-058' ? 'conversation' : 'task',
        category: 'artifact', tags: caseId === 'TC-058' ? ['multi-turn'] : ['html-report'], inheritedTags: [],
        splits: ['held-in'], turns: caseId === 'TC-058' ? 'simulator' : 1, hasExpect: true, source: 'manual', retired: false, isDraft: false,
      },
    });
  }
  const fixturePath = path.join(here, '.generated-casedrawer.json');
  await fs.writeFile(fixturePath, JSON.stringify(details));
  annotations.insert({
    id: 'visual-annotation-1', experiment_id: runId, case_id: 'TC-026', reviewer_id: 'runpanel-admin',
    overall: 'down', note: '报告文件没有生成，工具调用也失败了。',
    dims_json: JSON.stringify({ task_completed: 'no', tool_choice: 'no', self_tested: 'yes' }),
    consent_scope: 'metadata', calibration_split: null, supersedes_id: null, created_at: Date.now() - 7_200_000,
  });
  const row = annotations.listForCase(runId, 'TC-026')[0];
  if (!row) throw new Error('missing persisted visual annotation');
  const annotation = {
    id: row.id, experimentId: row.experiment_id, caseId: row.case_id, reviewerId: row.reviewer_id,
    overall: row.overall ?? undefined, note: row.note ?? undefined, dims: JSON.parse(row.dims_json),
    consentScope: row.consent_scope, createdAt: row.created_at, mine: true,
  };
  const annotationFixtures: Record<string, ListEvalAnnotationsResult> = {
    'a13-annotation-empty': { annotations: [], latestByReviewer: [] },
    'a13-annotation-prefill': { annotations: [annotation], latestByReviewer: [annotation] },
  };
  const annotationPath = path.join(here, '.generated-annotations.json');
  await fs.writeFile(annotationPath, JSON.stringify(annotationFixtures));
  db.close();
  return { fixturePath, annotationPath, reportPath };
}

async function prepareScenario(page: Page, scenario: Scenario, theme: Theme): Promise<void> {
  await page.goto(`http://127.0.0.1:4189/?scenario=${scenario}&theme=${theme}`);
  if (scenario.startsWith('c1')) {
    await page.getByTestId('eval-experiments-tab').waitFor();
    if (scenario === 'c1b-disabled' || scenario === 'c1b-ready') {
      await page.getByRole('button', { name: '新建实验', exact: true }).first().click();
      await page.getByRole('dialog').waitFor();
      if (scenario === 'c1b-ready') {
        await page.getByPlaceholder('production-default@sys-v45').fill('优先给出可验证结论。');
      }
    }
    if (scenario === 'c1c') {
      await page.getByTestId('experiment-row-01J6K9EXPERIMENT01').click();
      await page.getByTestId('eval-experiment-result').waitFor();
    }
    return;
  }
  if (scenario === 'c2') {
    await page.getByTestId('eval-scorers-tab').waitFor();
    return;
  }
  if (scenario.startsWith('a13')) {
    await page.getByText('日常集 · 每题 1 次 · 题库 abcdef0').waitFor();
    await page.getByRole('dialog').waitFor();
    if (scenario.startsWith('a13-annotation')) {
      await page.getByTestId('eval-case-annotation').scrollIntoViewIfNeeded();
    }
    return;
  }
  await page.getByTestId('eval-benchmarks-tab').waitFor();
  if (scenario === 'a2' || scenario === 'a8') {
    await page.getByRole('button', { name: '开跑', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByTestId('eval-run-confirm').click();
    await page.getByText(/再点一次确认/).waitFor();
  }
  if (scenario === 'a8') {
    await page.getByTestId('eval-run-confirm').click();
    await page.getByTestId('eval-run-active').waitFor();
    await page.getByText('case-sheet-07', { exact: true }).waitFor();
  }
  if (scenario === 'a12') {
    await page.getByText('日常集 · 每题 1 次 · 题库 abcdef0').waitFor();
  }
}

async function captureScenario(page: Page, scenario: Scenario, theme: Theme): Promise<void> {
  await prepareScenario(page, scenario, theme);
  const filename = scenario.startsWith('a13')
    ? scenario.startsWith('a13-annotation')
      ? `N-EVAL-ANNOTQUEUE-2026-08-30-${scenario.replace('a13-annotation-', '')}-${theme}.png`
      : `N-EVAL-CASEDRAWER-2026-08-30-${scenario}-${theme}.png`
    : `${scenario}-${theme}.png`;
  await page.screenshot({ path: path.join(outputDir, filename), fullPage: scenario === 'c2' });
}

async function captureReference(page: Page, scenario: Scenario): Promise<void> {
  if (!referenceHtml || scenario === 'c2') return;
  await page.goto(pathToFileURL(referenceHtml).href);
  const locator = scenario === 'a1'
    ? page.locator('#a1 .appframe').nth(1)
    : scenario === 'a2'
      ? page.locator('#a2 .modal-backdrop').first()
      : page.locator(`#${scenario} .appframe`).first();
  await locator.screenshot({ path: path.join(outputDir, `${scenario}-reference.png`) });
}

await fs.mkdir(outputDir, { recursive: true });
const generatedFixture = await writeCaseDrawerFixture();
const server = await createServer({ configFile: path.join(here, 'vite.config.ts'), logLevel: 'warn' });
await server.listen();
const browser = await chromium.launch({ headless: true });

try {
  for (const scenario of requestedScenarios) {
    for (const theme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
      await captureScenario(page, scenario, theme);
      await page.close();
    }
    if (referenceHtml) {
      const referencePage = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
      await captureReference(referencePage, scenario);
      await referencePage.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
  await fs.rm(generatedFixture.fixturePath, { force: true });
  await fs.rm(generatedFixture.annotationPath, { force: true });
  await fs.rm(generatedFixture.reportPath, { force: true });
}

console.log(`[runpanel-visual] captured ${requestedScenarios.length * 2} theme screenshots in ${outputDir}`);
