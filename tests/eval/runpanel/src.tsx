import React from 'react';
import { createRoot } from 'react-dom/client';
import type { ElectronAPI } from '@shared/ipc';
import { EVALUATION_CHANNELS } from '@internal-evaluation/shared/evaluationChannels';
import { UNKNOWN_EVAL_RUN_STAMP } from '@shared/contract/evaluation';
import type {
  EvalExperimentDetail,
  EvalExperimentListItem,
  EvalRunEvent,
  EvalRunPanelProbe,
} from '@shared/contract/evaluation';
import { EXPECTATION_TYPE_CATALOG } from '../../../src/host/testing/expectationCatalog';
import { EvalCenterPage } from '@internal-evaluation/renderer/evalCenter/EvalCenterPage';
import { useEvalCenterStore } from '@internal-evaluation/renderer/stores/evalCenterStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useAuthStore } from '../../../src/renderer/stores/authStore';
import '../../../src/renderer/styles/global.css';

type Scenario = 'a1' | 'a2' | 'a8' | 'a12' | 'c2' | 'c1a' | 'c1b-disabled' | 'c1b-ready' | 'c1c';
type Theme = 'light' | 'dark';
type EventListener = (event: EvalRunEvent) => void;

const params = new URLSearchParams(window.location.search);
const scenario = (params.get('scenario') ?? 'a1') as Scenario;
const theme = (params.get('theme') ?? 'dark') as Theme;
const rootElement = document.documentElement;
rootElement.dataset.theme = theme;
rootElement.className = theme;

const probe: EvalRunPanelProbe = {
  environment: {
    available: true,
    message: '评测环境已就绪',
    packaged: false,
    platform: 'darwin',
    osJail: { enabled: false, available: true, active: false },
  },
  model: 'deepseek-chat',
  provider: 'deepseek',
  priceTableVersion: 1,
  estimatedCostPerCaseUsd: 0.0021,
  judge: { model: 'glm-4.7', provider: 'zhipu', estimatedCostPerCaseUsd: 0.01 },
  aiReview: [
    { dim: 'task_completed', requiresExpectation: false, calibration: { state: 'calibrated', kappa: 0.71, pairs: 34, computedAt: '2026-08-30', goldSource: 'deterministic_shadow' } },
    { dim: 'tool_choice', requiresExpectation: true, calibration: { state: 'uncalibrated', reason: 'no_record' } },
    { dim: 'confirmed_before_acting', requiresExpectation: false, calibration: { state: 'uncalibrated', reason: 'not_enough_pairs', pairs: 12, goldSource: 'deterministic_shadow' } },
    { dim: 'no_extra_changes', requiresExpectation: true, calibration: { state: 'uncalibrated', reason: 'prompt_changed' } },
    { dim: 'self_tested', requiresExpectation: true, calibration: { state: 'uncalibrated', reason: 'superseded' } },
  ],
  splitCounts: { 'held-in': 76, 'held-out': 52, safety: 12 },
  quickCheck: { tags: ['core-path'], maxCases: 12 },
  productionArm: {
    name: 'production-default@sys-v45', model: 'deepseek-chat', provider: 'deepseek',
    harness: { name: 'production', contextCompression: true, compressionPipeline: true, scaffoldProfile: false, thinkingInjection: true, hooksEnabled: true, toolMode: 'deferred' },
    memory: { longTerm: true }, skills: ['data-cleaning', 'xlsx'],
  },
  skills: ['data-cleaning', 'xlsx', 'docx', 'web'],
};

function experiment(
  id: string,
  timestamp: number,
  config: Record<string, unknown>,
  summary: EvalExperimentListItem['summary'],
): EvalExperimentListItem {
  return {
    id,
    name: `run-${id}`,
    timestamp,
    model: 'deepseek-chat',
    provider: 'deepseek',
    scope: 'full',
    source: 'eval',
    gitCommit: 'abcdef0123456789',
    config,
    summary,
  };
}

const historyRuns: EvalExperimentListItem[] = [
  experiment('20260829-1430', Date.UTC(2026, 7, 29, 6, 30), {
    split: 'held-in', k: 1, caseBankSha: 'abcdef012345', mode: 'real',
  }, { passRate: 0.842, passed: 64, total: 76, completed: true, notRun: 0 }),
  experiment('20260828-1741', Date.UTC(2026, 7, 28, 9, 41), {
    split: 'held-in', k: 1, caseBankSha: 'abcdef012345', mode: 'real',
  }, { passRate: 0.816, passed: 62, total: 76, completed: true, notRun: 0 }),
  experiment('20260828-1105', Date.UTC(2026, 7, 28, 3, 5), {
    split: 'held-in', k: 1, mode: 'real',
  }, { passRate: 0.76, passed: 38, total: 50, completed: false, notRun: 26, aborted: true }),
  experiment('mock-hidden', Date.UTC(2026, 7, 29, 7, 0), {
    split: 'held-in', k: 1, caseBankSha: 'abcdef012345', mode: 'mock',
  }, { passRate: 1, passed: 76, total: 76, completed: true, notRun: 0 }),
];

const compareRun: EvalExperimentListItem = {
  id: '01J6K9EXPERIMENT01', name: 'candidate-v3', timestamp: Date.UTC(2026, 7, 30, 9, 45),
  model: 'deepseek-chat', provider: 'deepseek', scope: 'full', source: 'compare', gitCommit: '0fe06d3144fdf185',
  config: {
    ...UNKNOWN_EVAL_RUN_STAMP, estimatedCostUsd: 0.42,
    compare: {
      baseline: probe.productionArm,
      candidate: { ...probe.productionArm, name: 'candidate-v3', systemPrompt: '优先给出可验证结论。', skills: ['data-cleaning', 'xlsx', 'docx'] },
      diff: ['systemPrompt: sys-v45 → candidate-v3', 'skill: data-cleaning,xlsx → data-cleaning,xlsx,docx'],
    },
  },
  summary: {
    completed: true,
    compare: {
      totalCases: 42, baselineWins: 9, candidateWins: 17, ties: 13, excludedPairs: 3, skillNotActivatedPairs: 1, pValue: 0.039,
      shipGate: {
        state: 'candidate_better', delta: 3, nMin: 30, decisivePairs: 26, pValue: 0.039,
        passRateDiff: 0.08, ciLowerBound: 0.021,
        hardGate: { passed: true, items: [
          { key: 'false_allow', status: 'pass', count: 0 },
          { key: 'false_block', status: 'pass', count: 0 },
          { key: 'approval_bypass', status: 'not_measured' },
        ] },
        calibre: { k: 1, aggregationRuleVersion: 4, promptVersion: 'sys-v45' }, reasons: ['candidate_win_rate'],
      },
    },
  },
};

const compareDetail: EvalExperimentDetail = {
  experiment: compareRun,
  cases: [
    { caseId: 'case-auth-01', status: 'passed', score: 100, durationMs: 842, data: { assignment: { A: 'candidate', B: 'baseline' }, statusA: 'passed', statusB: 'failed', winner: 'candidate', referenceWinner: 'A', skillActivations: { baseline: 0, candidate: 2 } } },
    { caseId: 'case-sheet-07', status: 'failed', score: 60, durationMs: 1_204, data: { assignment: { A: 'baseline', B: 'candidate' }, statusA: 'passed', statusB: 'failed', winner: 'baseline', referenceWinner: 'A', skillActivations: { baseline: 1, candidate: 3 } } },
    { caseId: 'case-replay-04', status: 'passed', score: 100, durationMs: 690, data: { assignment: { A: 'candidate', B: 'baseline' }, statusA: 'passed', statusB: 'passed', winner: 'tie', referenceWinner: 'tie', skillActivations: { baseline: 0, candidate: 1 } } },
    { caseId: 'case-safety-02', status: 'failed', score: 0, durationMs: 0, data: { assignment: { A: 'baseline', B: 'candidate' }, statusA: 'infra_excluded', statusB: 'not_run', winner: 'tie', referenceWinner: 'tie', excludedReason: 'skill_not_activated', skillActivations: { baseline: 0, candidate: 0 } } },
  ],
};

const listeners = new Map<string, Set<EventListener>>();

function emit(event: EvalRunEvent): void {
  listeners.get(EVALUATION_CHANNELS.RUN_EVENTS)?.forEach((listener) => listener(event));
}

function emitActiveRun(): void {
  const base = { schemaVersion: 3 as const, runId: 'visual-run' };
  emit({
    ...base,
    type: 'run_start',
    ts: 1_000,
    plannedCaseIds: ['case-auth-01', 'case-replay-04', 'case-safety-02', 'case-sheet-07'],
    config: {
      ...UNKNOWN_EVAL_RUN_STAMP,
      evalSet: { ...UNKNOWN_EVAL_RUN_STAMP.evalSet, split: 'held-in' },
      mode: 'real', model: 'deepseek-chat', provider: 'deepseek', scope: 'full', split: 'held-in',
      maxCases: 4, concurrency: 1, gitCommit: 'abcdef0', testCaseDir: '.claude/test-cases',
    },
  });
  emit({ ...base, type: 'case_start', ts: 1_200, testId: 'case-auth-01', description: '登录链路' });
  emit({ ...base, type: 'tool_call', ts: 1_350, testId: 'case-auth-01', tool: 'read_file', input: {} });
  emit({ ...base, type: 'tool_call', ts: 1_500, testId: 'case-auth-01', tool: 'bash', input: {} });
  emit({ ...base, type: 'case_end', ts: 2_100, testId: 'case-auth-01', status: 'passed', score: 1, durationMs: 900 });
  emit({ ...base, type: 'case_start', ts: 2_200, testId: 'case-replay-04', description: '回放链路' });
  emit({ ...base, type: 'case_end', ts: 2_900, testId: 'case-replay-04', status: 'failed', score: 0, durationMs: 700, failureReason: '未找到预期输出' });
  emit({ ...base, type: 'case_end', ts: 3_100, testId: 'case-safety-02', status: 'infra_excluded', score: 0, durationMs: 200 });
  emit({ ...base, type: 'case_start', ts: 3_300, testId: 'case-sheet-07', description: '表格链路' });
};

const bridge = {
  async invoke(channel: string, payload?: unknown): Promise<unknown> {
    if (channel === EVALUATION_CHANNELS.LIST_EXPERIMENTS) {
      if (scenario.startsWith('c1')) return scenario === 'c1a' || scenario === 'c1c' ? [compareRun] : [];
      return scenario === 'a12' ? historyRuns : [];
    }
    if (channel === EVALUATION_CHANNELS.RUN_EVENTS && payload === undefined) return probe;
    if (channel === EVALUATION_CHANNELS.SCORERS_OVERVIEW) {
      return { assertions: EXPECTATION_TYPE_CATALOG, aiReview: probe.aiReview, judge: probe.judge };
    }
    if (channel === EVALUATION_CHANNELS.RUN_SUITE) return { runId: 'visual-run' };
    if (channel === EVALUATION_CHANNELS.LOAD_EXPERIMENT) return compareDetail;
    if (channel === EVALUATION_CHANNELS.RUN_EVENTS) {
      window.setTimeout(emitActiveRun, 0);
      return { runId: 'visual-run', running: true };
    }
    if (channel === EVALUATION_CHANNELS.ABORT_RUN) {
      return { runId: 'visual-run', pid: 101, terminated: true };
    }
    return null;
  },
  on(channel: string, listener: EventListener): () => void {
    const set = listeners.get(channel) ?? new Set<EventListener>();
    set.add(listener);
    listeners.set(channel, set);
    return () => set.delete(listener);
  },
  off(channel: string, listener: EventListener): void {
    listeners.get(channel)?.delete(listener);
  },
} as unknown as ElectronAPI;

window.codeAgentAPI = bridge;
useAuthStore.setState({ user: { id: 'runpanel-admin', email: 'admin@example.com', isAdmin: true } });
useAppStore.setState({ language: 'zh' });
useEvalCenterStore.setState({ tab: scenario === 'c2' ? 'scorers' : scenario.startsWith('c1') ? 'experiments' : 'benchmarks' });

createRoot(document.getElementById('root')!).render(<EvalCenterPage />);
