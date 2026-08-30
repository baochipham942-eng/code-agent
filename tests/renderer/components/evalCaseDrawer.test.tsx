// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EVALUATION_CHANNELS } from '@internal-evaluation/shared/evaluationChannels';
import type {
  EvalExperimentCaseDetail,
} from '../../../src/shared/contract/evaluation';
import type { EvalBaselineExperimentListItem } from '../../../src/shared/contract/evaluationBaseline';
import { evalRunPanelZh } from '@internal-evaluation/renderer/i18n/evalRunPanel';

const evaluation = vi.hoisted(() => ({ invoke: vi.fn() }));
const ipc = vi.hoisted(() => ({ invoke: vi.fn(), invokeDomain: vi.fn() }));
const toasts = vi.hoisted(() => ({ success: vi.fn() }));

vi.mock('@internal-evaluation/renderer/evaluationRunIpc', () => ({
  invokeEvaluation: evaluation.invoke,
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: ipc.invoke, invokeDomain: ipc.invokeDomain },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { success: toasts.success },
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

  it('T5：点踩、失败笔记和两维判否逐字写入，成功后显示上次', async () => {
    const saved = {
      id: 'mine-1', experimentId: 'run-1', caseId: 'case-1', reviewerId: 'host-reviewer',
      overall: 'down' as const, note: '没有生成文件',
      dims: { task_completed: 'no' as const, tool_choice: 'no' as const },
      consentScope: 'metadata' as const, createdAt: Date.now(), mine: true,
    };
    evaluation.invoke.mockImplementation(async (channel: string) => {
      if (channel === EVALUATION_CHANNELS.LIST_ANNOTATIONS) return { annotations: [], latestByReviewer: [] };
      if (channel === EVALUATION_CHANNELS.SAVE_ANNOTATION) return { annotation: saved };
      return detail();
    });
    render(<EvalCaseDrawer target={{ experimentId: 'run-1', caseId: 'case-1' }} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText('整体判差'));
    fireEvent.change(screen.getByPlaceholderText('写你看到的问题，一句话就行'), {
      target: { value: '没有生成文件' },
    });
    fireEvent.click(screen.getByLabelText('任务完成了吗 · 否'));
    fireEvent.click(screen.getByLabelText('工具选得对吗 · 否'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(evaluation.invoke).toHaveBeenCalledWith(
      EVALUATION_CHANNELS.SAVE_ANNOTATION,
      {
        experimentId: 'run-1', caseId: 'case-1', overall: 'down', note: '没有生成文件',
        dims: { task_completed: 'no', tool_choice: 'no' }, supersedesId: undefined,
      },
    ));
    expect(await screen.findByText(/上次/)).toBeTruthy();
    expect(toasts.success).toHaveBeenCalledWith('已写回');
  });

  it('T6：只预填 mine 标注，保存时 supersedesId 指向我的上一版', async () => {
    const mine = {
      id: 'mine-1', experimentId: 'run-1', caseId: 'case-1', reviewerId: 'host-reviewer',
      overall: 'down' as const, note: '我的笔记', dims: { task_completed: 'no' as const },
      consentScope: 'metadata' as const, createdAt: Date.now() - 60_000, mine: true,
    };
    const other = {
      id: 'other-1', experimentId: 'run-1', caseId: 'case-1', reviewerId: 'Laura',
      overall: 'up' as const, note: '别人的笔记', dims: { tool_choice: 'yes' as const, self_tested: 'yes' as const },
      consentScope: 'metadata' as const, createdAt: Date.now(), mine: false,
    };
    evaluation.invoke.mockImplementation(async (channel: string) => {
      if (channel === EVALUATION_CHANNELS.LIST_ANNOTATIONS) {
        return { annotations: [other, mine], latestByReviewer: [other, mine] };
      }
      if (channel === EVALUATION_CHANNELS.SAVE_ANNOTATION) return { annotation: mine };
      return detail();
    });
    render(<EvalCaseDrawer target={{ experimentId: 'run-1', caseId: 'case-1' }} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText('整体判差').getAttribute('aria-pressed')).toBe('true'));
    expect((screen.getByPlaceholderText('写你看到的问题，一句话就行') as HTMLTextAreaElement).value).toBe('我的笔记');
    expect(screen.getByLabelText('任务完成了吗 · 否').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/其他人：Laura 👍 · 2 维/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(evaluation.invoke).toHaveBeenCalledWith(
      EVALUATION_CHANNELS.SAVE_ANNOTATION,
      expect.objectContaining({ supersedesId: 'mine-1' }),
    ));
  });

  it('T7：有无人工标注时结论条逐字相同', async () => {
    evaluation.invoke.mockImplementation(async (channel: string) => channel === EVALUATION_CHANNELS.LIST_ANNOTATIONS
      ? { annotations: [], latestByReviewer: [] }
      : detail());
    render(<EvalCaseDrawer target={{ experimentId: 'run-1', caseId: 'case-1' }} onClose={vi.fn()} />);
    const withoutAnnotation = (await screen.findByTestId('eval-case-conclusion')).textContent;
    cleanup();
    evaluation.invoke.mockImplementation(async (channel: string) => channel === EVALUATION_CHANNELS.LIST_ANNOTATIONS
      ? {
          annotations: [],
          latestByReviewer: [{
            id: 'mine-1', experimentId: 'run-1', caseId: 'case-1', reviewerId: 'host-reviewer',
            overall: 'up', dims: {}, consentScope: 'metadata', createdAt: Date.now(), mine: true,
          }],
        }
      : detail());
    render(<EvalCaseDrawer target={{ experimentId: 'run-1', caseId: 'case-1' }} onClose={vi.fn()} />);
    expect((await screen.findByTestId('eval-case-conclusion')).textContent).toBe(withoutAnnotation);
  });

  it('T9：人工评审段内不出现分数、百分比或综合分（监工代笔 · Grok 刀 B 席盲区⑩）', async () => {
    const mine = {
      id: 'mine-1', experimentId: 'run-1', caseId: 'case-1', reviewerId: 'host-reviewer',
      overall: 'down' as const, note: '我的笔记', dims: { task_completed: 'no' as const },
      consentScope: 'metadata' as const, createdAt: Date.now() - 7_200_000, mine: true,
    };
    const other = {
      id: 'other-1', experimentId: 'run-1', caseId: 'case-1', reviewerId: 'someone-else',
      overall: 'up' as const, note: '别人的笔记', dims: { tool_choice: 'yes' as const, self_tested: 'yes' as const },
      consentScope: 'metadata' as const, createdAt: Date.now(), mine: false,
    };
    evaluation.invoke.mockImplementation(async (channel: string) => channel === EVALUATION_CHANNELS.LIST_ANNOTATIONS
      ? { annotations: [other, mine], latestByReviewer: [other, mine] }
      : detail());
    render(<EvalCaseDrawer target={{ experimentId: 'run-1', caseId: 'case-1' }} onClose={vi.fn()} />);
    const section = await screen.findByTestId('eval-case-annotation');
    await screen.findByText(/别人的笔记|someone-else/);
    const text = section.textContent ?? '';
    // 允许「上次 2 小时前」「2000 字」「3 维」与否定句「不进分数 / 不合成综合分」；不允许出现分值：60% / 评分 / 「80 分」
    expect(text).not.toMatch(/\d\s*%|评分|\d+\s*分(?![钟数])/);
  });

  it('超过 2000 字时常驻说明原因并禁用保存', async () => {
    render(<EvalCaseDrawer target={{ experimentId: 'run-1', caseId: 'case-1' }} onClose={vi.fn()} />);
    const note = await screen.findByPlaceholderText('写你看到的问题，一句话就行');
    fireEvent.change(note, { target: { value: 'a'.repeat(2001) } });
    expect(screen.getByText('太长了，压到 2000 字内')).toBeTruthy();
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('EvalRunHistory case drawer entry', () => {
  it('T7：点变化行请求本轮单题证据，Esc 关闭抽屉', async () => {
    const runs: EvalBaselineExperimentListItem[] = [
      { id: 'run-new', name: 'eval-daily-2026-08-30', timestamp: 2, model: 'm', provider: 'p', scope: 'full', source: 'eval', gitCommit: 'b', config: { mode: 'real', k: 1, caseBankSha: 'sha', aggregationRuleVersion: 4, evalSet: { split: 'held-in' } }, summary: { completed: true, notRun: 0, passRate: 0, plannedCaseIds: ['case-1'], invalidCases: 0, aggregationRuleVersion: 4 }, caseResults: { 'case-1': { status: 'failed', score: 0 } } },
      { id: 'run-old', name: 'eval-daily-2026-08-29', timestamp: 1, model: 'm', provider: 'p', scope: 'full', source: 'eval', gitCommit: 'a', config: { mode: 'real', k: 1, caseBankSha: 'sha', aggregationRuleVersion: 4, evalSet: { split: 'held-in' } }, summary: { completed: true, notRun: 0, passRate: 1, plannedCaseIds: ['case-1'], invalidCases: 0, aggregationRuleVersion: 4 }, caseResults: { 'case-1': { status: 'passed', score: 1 } } },
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
