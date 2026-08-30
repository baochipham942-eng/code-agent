// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EVALUATION_CHANNELS } from '@internal-evaluation/shared/evaluationChannels';
import type {
  EvalExperimentCaseDetail,
  EvalExperimentListItem,
} from '../../../src/shared/contract/evaluation';
import { evalRunPanelZh } from '@internal-evaluation/renderer/i18n/evalRunPanel';

const evaluation = vi.hoisted(() => ({ invoke: vi.fn() }));
const ipc = vi.hoisted(() => ({ invoke: vi.fn(), invokeDomain: vi.fn() }));

vi.mock('@internal-evaluation/renderer/evaluationRunIpc', () => ({
  invokeEvaluation: evaluation.invoke,
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: ipc.invoke, invokeDomain: ipc.invokeDomain },
}));

import { EvalCaseDrawer } from '@internal-evaluation/renderer/evalCenter/EvalCaseDrawer';
import { EvalRunHistory } from '@internal-evaluation/renderer/evalCenter/EvalRunHistory';

function detail(overrides: Partial<EvalExperimentCaseDetail> = {}): EvalExperimentCaseDetail {
  return {
    caseId: 'case-1', status: 'failed', score: 75, durationMs: 20,
    failureReason: 'missing output', failureLabel: '缺少预期产物',
    evidence: {
      prompt: '第一条输入', followUpPrompts: ['第二条输入', '第三条输入'],
      checks: [
        { type: 'file_exists', passed: true, expected: '"a"', actual: '"a"', durationMs: 1 },
        { type: 'content_contains', passed: true, expected: '"b"', actual: '"b"', durationMs: 1 },
        { type: 'no_crash', passed: true, expected: 'true', actual: 'true', durationMs: 1 },
        { type: 'test_passes', passed: false, expected: '0', actual: '1', durationMs: 1 },
      ],
      toolCalls: [], responseExcerpt: '最后的回答', responseTotalChars: 5,
    },
    assertionCatalog: [
      { type: 'file_exists', summary: '文件存在' },
      { type: 'content_contains', summary: '文件内容包含指定文本' },
      { type: 'no_crash', summary: '执行过程没有崩溃' },
      { type: 'test_passes', summary: '测试命令通过' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  evaluation.invoke.mockResolvedValue(detail());
  ipc.invoke.mockReset();
  ipc.invokeDomain.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EvalCaseDrawer', () => {
  it('T4：逐条判定后保留不可省略的汇总行', async () => {
    render(<EvalCaseDrawer target={{ experimentId: 'run-1', caseId: 'case-1' }} onClose={vi.fn()} />);
    expect(await screen.findByText('4 条判定 3 过 1 挂 → 判失败')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it.each([
    ['infra_excluded', '环境故障'],
    ['invalid', '判废'],
    ['cost_exceeded', '成本超限'],
    ['skipped', '跳过'],
    ['not_run', '未执行'],
  ] as const)('T5：%s 整段显示解释，不画能力判定', async (status, label) => {
    evaluation.invoke.mockResolvedValue(detail({
      status, failureReason: '本轮没有有效执行', failureLabel: undefined,
      evidence: {
        ...detail().evidence!,
        trialDetails: [
          { index: 1, status: 'passed', score: 1, durationMs: 1 },
          { index: 2, status: 'failed', score: 0, durationMs: 1 },
        ],
      },
    }));
    render(<EvalCaseDrawer target={{ experimentId: `run-${status}`, caseId: 'case-1' }} onClose={vi.fn()} />);
    const excluded = await screen.findByTestId('eval-case-excluded-checks');
    expect(excluded.textContent).toContain('不计入通过率');
    expect(screen.getByRole('dialog').textContent).not.toMatch(/[✓✕]/);
    expect(screen.queryByTestId('eval-case-check-summary')).toBeNull();
    expect(screen.getByRole('dialog').textContent).not.toContain('条判定');
    expect(screen.getByRole('dialog').textContent).not.toContain('判失败');
    expect(screen.getByRole('dialog').querySelectorAll('svg.lucide-clock-3')).toHaveLength(2);
    expect(screen.getAllByText(label)[0]?.className).toContain('warning');
  });

  it('混合尝试里的环境故障格保持灰钟', async () => {
    evaluation.invoke.mockResolvedValue(detail({
      evidence: {
        ...detail().evidence!,
        trialDetails: [
          { index: 1, status: 'infra_excluded', score: 0, durationMs: 1 },
          { index: 2, status: 'failed', score: 0, durationMs: 1 },
        ],
      },
    }));
    render(<EvalCaseDrawer target={{ experimentId: 'run-mixed', caseId: 'case-1' }} onClose={vi.fn()} />);
    const infraTrial = await screen.findByLabelText('第 1 次 · 环境故障 · score 0');
    expect(infraTrial.querySelector('svg.lucide-clock-3')).toBeTruthy();
    expect(screen.getByText('2 次 0 过 1 挂，1 次未形成有效执行 → 判失败')).toBeTruthy();
  });

  it('失败题没有断言明细时仍显示判失败', async () => {
    evaluation.invoke.mockResolvedValue(detail({
      evidence: { ...detail().evidence!, checks: [] },
    }));
    render(<EvalCaseDrawer target={{ experimentId: 'run-empty-checks', caseId: 'case-1' }} onClose={vi.fn()} />);
    expect(await screen.findByText('0 条判定 0 过 0 挂 → 判失败')).toBeTruthy();
  });

  it('T6：旧轮不生成输入气泡，两个承重段都说明证据缺失', async () => {
    evaluation.invoke.mockResolvedValue(detail({ evidence: null, evidenceMissingReason: 'legacy_run' }));
    render(<EvalCaseDrawer target={{ experimentId: 'run-1', caseId: 'case-1' }} onClose={vi.fn()} />);
    expect((await screen.findAllByText('这轮没有留下过程证据（旧版本跑的），重跑一轮就有')).length).toBe(2);
    expect(screen.queryByTestId('eval-case-transcript')).toBeNull();
    expect(screen.queryByTestId('eval-case-user-turn')).toBeNull();
    expect(screen.queryByText('输入')).toBeNull();
    expect(screen.queryByText('第一条输入')).toBeNull();
  });

  it('T8：多轮输入按顺序画成多个用户气泡，模拟器规则贴在对应气泡内', async () => {
    render(<EvalCaseDrawer target={{ experimentId: 'run-1', caseId: 'case-1' }} onClose={vi.fn()} />);
    expect(await screen.findByText('第三条输入')).toBeTruthy();
    expect(screen.getAllByText('输入')).toHaveLength(3);
    expect(screen.getAllByTestId('eval-case-user-turn')).toHaveLength(3);

    cleanup();
    evaluation.invoke.mockResolvedValue(detail({
      evidence: {
        ...detail().evidence!, followUpPrompts: undefined,
        simTurns: [{ turn: 2, userText: '先确认再做', matchedRule: 'confirm-first' }],
      },
    }));
    render(<EvalCaseDrawer target={{ experimentId: 'run-2', caseId: 'case-1' }} onClose={vi.fn()} />);
    const rule = await screen.findByText('模拟器 · confirm-first');
    expect(rule.parentElement?.textContent).toContain('先确认再做');
  });
});

describe('EvalRunHistory case drawer entry', () => {
  it('T7：点变化行请求本轮单题证据，Esc 关闭抽屉', async () => {
    const runs: EvalExperimentListItem[] = [
      { id: 'run-new', name: 'eval-daily-2026-08-30', timestamp: 2, model: 'm', provider: 'p', scope: 'full', source: 'eval', gitCommit: 'b', config: { mode: 'real', k: 1, caseBankSha: 'sha', evalSet: { split: 'held-in' } }, summary: { completed: true, notRun: 0, passRate: 0 } },
      { id: 'run-old', name: 'eval-daily-2026-08-29', timestamp: 1, model: 'm', provider: 'p', scope: 'full', source: 'eval', gitCommit: 'a', config: { mode: 'real', k: 1, caseBankSha: 'sha', evalSet: { split: 'held-in' } }, summary: { completed: true, notRun: 0, passRate: 1 } },
    ];
    evaluation.invoke.mockImplementation(async (channel: string, payload: unknown) => {
      if (channel === EVALUATION_CHANNELS.LOAD_CASE) return detail();
      const id = String(payload);
      return {
        experiment: runs.find((run) => run.id === id),
        cases: [{ caseId: 'case-1', status: id === 'run-new' ? 'failed' : 'passed', score: 0, durationMs: 1 }],
      };
    });
    render(
      <EvalRunHistory
        experiments={runs} loadState="ready" loadError={null} hasActiveRun={false} probe={null}
        labels={evalRunPanelZh.runPanel} language="zh" loadingText="加载" onRefresh={vi.fn()} onOpenWizard={vi.fn()}
      />,
    );
    const selectors = screen.getAllByLabelText(evalRunPanelZh.runPanel.selectForCompare);
    fireEvent.click(selectors[0]);
    fireEvent.click(selectors[1]);
    await screen.findByText('case-1');
    fireEvent.click(screen.getByText('case-1'));
    await waitFor(() => expect(evaluation.invoke).toHaveBeenCalledWith(
      EVALUATION_CHANNELS.LOAD_CASE,
      { experimentId: 'run-new', caseId: 'case-1' },
    ));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
