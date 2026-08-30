import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from '../../../src/host/platform';
import { EVALUATION_CHANNELS } from '@internal-evaluation/shared/evaluationChannels';

const state = vi.hoisted(() => ({
  denied: false,
  root: '',
  userId: 'reviewer-1',
  loadExperiment: vi.fn(),
}));

vi.mock('../../../src/host/ipc/channelAccessPolicy', () => ({
  getChannelAccessIpcError: () => state.denied
    ? { success: false, error: { code: 'FORBIDDEN', message: 'admin required' } }
    : null,
}));

vi.mock('@internal-evaluation/host/evaluation/evalEnvironment', () => ({
  inspectEvalEnvironment: () => ({ repositoryRoot: state.root }),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ loadExperiment: state.loadExperiment }),
}));

vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => ({ id: state.userId }) }),
}));

import { registerEvaluationBaselineHandlers } from '@internal-evaluation/host/ipc/evaluationBaseline.ipc';

type Handler = (...args: unknown[]) => unknown;

function setup(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  registerEvaluationBaselineHandlers({
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
  } as unknown as IpcMain);
  return handlers;
}

function loadedExperiment(id: string, split = 'held-in', k = 1) {
  const plannedCaseIds = ['case-1', 'case-2'];
  return {
    experiment: {
      id,
      name: id,
      timestamp: 100,
      model: 'model',
      provider: 'provider',
      scope: 'full',
      source: 'eval',
      git_commit: `commit-${id}`,
      config_json: JSON.stringify({
        split,
        k,
        mode: 'real',
        caseBankSha: `bank-${split}`,
        aggregationRuleVersion: 4,
        shape: { skills: [], memory: false, swarm: false, harness: null },
        divergesFromProduction: ['memory'],
      }),
      summary_json: JSON.stringify({
        total: 2,
        passed: 1,
        failed: 1,
        skipped: 0,
        partial: 0,
        avgScore: 0.5,
        duration: 20,
        completed: true,
        plannedCaseIds,
        notRun: 0,
        invalidCases: 0,
        aggregationRule: 'pass_rate_k1',
        aggregationRuleVersion: 4,
      }),
    },
    cases: plannedCaseIds.map((caseId, index) => ({
      case_id: caseId,
      status: index === 0 ? 'passed' : 'failed',
      score: index === 0 ? 1 : 0,
      duration_ms: 10,
      data_json: '{}',
    })),
  };
}

beforeEach(async () => {
  state.root = await mkdtemp(path.join(os.tmpdir(), 'eval-baseline-ipc-'));
  state.denied = false;
  state.userId = 'reviewer-1';
  state.loadExperiment.mockReset();
});

afterEach(async () => {
  await rm(state.root, { recursive: true, force: true });
});

describe('evaluation baseline package-private IPC', () => {
  it('T4：旧轮返回 baseline_legacy_run，admin 门在读取数据库前生效', async () => {
    const handlers = setup();
    state.loadExperiment.mockReturnValue({
      ...loadedExperiment('legacy'),
      experiment: {
        ...loadedExperiment('legacy').experiment,
        summary_json: JSON.stringify({ completed: true, notRun: 0 }),
      },
    });
    await expect(handlers.get(EVALUATION_CHANNELS.SET_BASELINE)!(null, { experimentId: 'legacy' }))
      .resolves.toEqual({ error: 'baseline_legacy_run' });
    await expect(readFile(
      path.join(state.root, '.claude', 'eval-baseline.held-in.k1.json'),
      'utf8',
    )).rejects.toMatchObject({ code: 'ENOENT' });

    state.denied = true;
    state.loadExperiment.mockClear();
    await expect(handlers.get(EVALUATION_CHANNELS.SET_BASELINE)!(null, { experimentId: 'blocked' }))
      .resolves.toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    expect(state.loadExperiment).not.toHaveBeenCalled();
  });

  it('T4/T5：连续设置保留操作记录，两组读回逐题结果', async () => {
    const handlers = setup();
    state.loadExperiment.mockImplementation((id: string) => (
      id === 'safety' ? loadedExperiment(id, 'safety', 2) : loadedExperiment(id)
    ));
    for (const experimentId of ['first', 'second', 'safety']) {
      await expect(handlers.get(EVALUATION_CHANNELS.SET_BASELINE)!(null, { experimentId }))
        .resolves.toMatchObject({ baseline: { experimentId } });
    }
    const stored = JSON.parse(await readFile(
      path.join(state.root, '.claude', 'eval-baseline.held-in.k1.json'),
      'utf8',
    )) as { history: Array<{ experimentId: string }> };
    expect(stored.history.map((item) => item.experimentId)).toEqual(['second', 'first']);

    const info = await handlers.get(EVALUATION_CHANNELS.BASELINE_INFO)!(null) as {
      groups: Record<string, { experimentId: string; caseResults: Record<string, unknown> }>;
    };
    expect(Object.keys(info.groups).sort()).toEqual(['held-in::1', 'safety::2']);
    expect(info.groups['held-in::1']).toMatchObject({
      experimentId: 'second',
      caseResults: { 'case-1': { status: 'passed', score: 1 } },
    });
  });
});
