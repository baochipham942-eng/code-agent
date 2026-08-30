import React from 'react';
import { createRoot } from 'react-dom/client';
import type { ElectronAPI } from '@shared/ipc';
import { IPC_CHANNELS } from '@shared/ipc';
import { UNKNOWN_EVAL_RUN_STAMP } from '@shared/contract/evaluation';
import type {
  EvalExperimentListItem,
  EvalRunEvent,
  EvalRunPanelProbe,
} from '@shared/contract/evaluation';
import { EvalCenterPage } from '../../../src/renderer/components/features/evalCenter/EvalCenterPage';
import { EXPECTATION_TYPE_CATALOG } from '../../../src/host/testing/expectationCatalog';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useAuthStore } from '../../../src/renderer/stores/authStore';
import '../../../src/renderer/styles/global.css';

type Scenario = 'a1' | 'a2' | 'a8' | 'a12' | 'c2';
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

const listeners = new Map<string, Set<EventListener>>();

function emit(event: EvalRunEvent): void {
  listeners.get(IPC_CHANNELS.EVALUATION_RUN_EVENTS)?.forEach((listener) => listener(event));
}

function emitActiveRun(): void {
  const base = { schemaVersion: 2 as const, runId: 'visual-run' };
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
    if (channel === IPC_CHANNELS.EVALUATION_LIST_EXPERIMENTS) {
      return scenario === 'a12' ? historyRuns : [];
    }
    if (channel === IPC_CHANNELS.EVALUATION_RUN_EVENTS && payload === undefined) return probe;
    if (channel === IPC_CHANNELS.EVALUATION_SCORERS_OVERVIEW) {
      return { assertions: EXPECTATION_TYPE_CATALOG, aiReview: probe.aiReview, judge: probe.judge };
    }
    if (channel === IPC_CHANNELS.EVALUATION_RUN_SUITE) return { runId: 'visual-run' };
    if (channel === IPC_CHANNELS.EVALUATION_RUN_EVENTS) {
      window.setTimeout(emitActiveRun, 0);
      return { runId: 'visual-run', running: true };
    }
    if (channel === IPC_CHANNELS.EVALUATION_ABORT_RUN) {
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
useAppStore.setState({ language: 'zh', evalCenterTab: scenario === 'c2' ? 'scorers' : 'benchmarks' });

createRoot(document.getElementById('root')!).render(<EvalCenterPage />);
