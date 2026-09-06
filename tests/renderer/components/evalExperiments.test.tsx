// @vitest-environment jsdom
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EvalExperimentDetail, EvalRunPanelProbe, EvalShipGateVerdict } from '../../../src/shared/contract/evaluation';
import { EvalExperimentResult } from '@internal-evaluation/renderer/evalCenter/EvalExperimentResult';
import { EvalExperimentWizard } from '@internal-evaluation/renderer/evalCenter/EvalExperimentWizard';
import { UNKNOWN_EVAL_RUN_STAMP } from '../../../src/shared/contract/evaluation';

afterEach(cleanup);

function verdict(state: EvalShipGateVerdict['state'], hardGatePassed = true): EvalShipGateVerdict {
  return {
    state, delta: 3, nMin: 30, decisivePairs: 18, pValue: 0.04, passRateDiff: 0.1, ciLowerBound: -0.01,
    hardGate: { passed: hardGatePassed, items: [
      { key: 'false_allow', status: hardGatePassed ? 'pass' : 'fail', count: hardGatePassed ? 0 : 2 },
      { key: 'false_block', status: 'not_measured' },
    ] },
    calibre: { k: 1, aggregationRuleVersion: 4, promptVersion: 'sys-v45' }, reasons: ['fixture'],
  };
}

function detail(state: EvalShipGateVerdict['state'], hardGatePassed = true): EvalExperimentDetail {
  return {
    experiment: {
      id: `exp-${state}`, name: 'candidate-v3', timestamp: 1, model: 'm', provider: 'p', scope: 'full', source: 'compare', gitCommit: 'abc',
      config: { ...UNKNOWN_EVAL_RUN_STAMP, compare: {
        baseline: { name: 'production', model: 'm', provider: 'p' }, candidate: { name: 'candidate-v3', model: 'm', provider: 'p', systemPrompt: 'new' },
        diff: ['systemPrompt: sys-v45 → candidate-v3'],
      } },
      summary: { completed: true, compare: {
        totalCases: 20, baselineWins: 7, candidateWins: 11, ties: 2, excludedPairs: 1,
        skillNotActivatedPairs: 1, pValue: 0.04, shipGate: verdict(state, hardGatePassed),
      } },
    },
    cases: [{
      caseId: 'case-1', status: 'passed', score: 100, durationMs: 10,
      data: { assignment: { A: 'candidate', B: 'baseline' }, statusA: 'passed', statusB: 'failed', winner: 'candidate', referenceWinner: 'A', skillActivations: { baseline: 0, candidate: 2 } },
    }],
  };
}

function probe(): EvalRunPanelProbe {
  return {
    environment: { available: true, message: 'ready', packaged: false, platform: 'darwin', osJail: { enabled: true, available: true, active: true } },
    model: 'm', provider: 'p', priceTableVersion: 1, estimatedCostPerCaseUsd: 0.01,
    judge: { model: 'judge', provider: 'p', estimatedCostPerCaseUsd: 0.01 }, aiReview: [],
    splitCounts: { 'held-in': 2, 'held-out': 1, safety: 1 }, unhardenedCount: 0, quickCheck: { tags: [], maxCases: 1 },
    productionArm: {
      name: 'production@sys-v45', model: 'm', provider: 'p',
      harness: {
        name: 'production', contextCompression: true, compressionPipeline: false, scaffoldProfile: true,
        thinkingInjection: false, hooksEnabled: true, toolMode: 'deferred',
      },
      memory: { longTerm: true }, skills: ['xlsx'],
    },
    skills: ['xlsx', 'docx'],
  };
}

describe('实验页四态与新建守卫', () => {
  it.each([
    ['candidate_better', '实验组更好'], ['non_inferior', '非劣'], ['candidate_worse', '实验组更差'], ['insufficient', '样本不足'],
  ] as const)('T4：%s 只渲染 host 给出的对应徽标', (state, copy) => {
    render(<EvalExperimentResult detail={detail(state)} onBack={vi.fn()} />);
    expect(screen.getByTestId(`experiment-verdict-${state}`).textContent).toContain(copy);
    if (state === 'insufficient') expect(screen.getByText('这不是势均力敌，是数据还不够')).toBeTruthy();
  });

  it('硬门失败显示红行，技术详情保留统计与未测量项', () => {
    render(<EvalExperimentResult detail={detail('candidate_worse', false)} onBack={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('安全项出现 2 次，不能上线');
    fireEvent.click(screen.getByText('技术详情'));
    const technical = screen.getByTestId('experiment-technical-details').textContent ?? '';
    expect(technical).toContain('pValue');
    expect(technical).toContain('分出胜负的题');
    expect(technical).toContain('false_block');
  });

  it('T6：两组签名相同时主按钮置灰，改 systemPrompt 后可进入二次确认', () => {
    render(<EvalExperimentWizard open probe={probe()} starting={false} onClose={vi.fn()} onStart={vi.fn()} />);
    const button = screen.getByTestId('experiment-run-confirm') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId('experiment-same-reason').textContent).toContain('两组一样，没法比');
    fireEvent.change(screen.getByPlaceholderText('production@sys-v45'), { target: { value: 'candidate prompt' } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(button.textContent).toContain('再点一次确认发车');
  });

  it('对照组按与实验组相同顺序逐维列出六项运行配置', () => {
    render(<EvalExperimentWizard open probe={probe()} starting={false} onClose={vi.fn()} onStart={vi.fn()} />);
    const expected = [
      ['contextCompression', '上下文压缩: 开'],
      ['compressionPipeline', '压缩流水线: 关'],
      ['scaffoldProfile', '脚手架档位: 开'],
      ['thinkingInjection', '思考注入: 关'],
      ['hooksEnabled', '钩子: 开'],
      ['toolMode', '工具模式: 按需加载（deferred）'],
    ] as const;
    for (const [key, copy] of expected) {
      expect(screen.getByTestId(`baseline-harness-${key}`).textContent).toBe(copy);
    }
  });

  it('C1-b/C1-c 渲染层不泄漏配置键名与成对状态原始枚举', () => {
    const resultDetail = detail('candidate_better');
    resultDetail.cases = [
      { caseId: 'passed-failed', status: 'passed', score: 100, durationMs: 1, data: { assignment: { A: 'candidate', B: 'baseline' }, statusA: 'passed', statusB: 'failed', winner: 'candidate', referenceWinner: 'A' } },
      { caseId: 'infra-not-run', status: 'skipped', score: 0, durationMs: 1, data: { assignment: { A: 'baseline', B: 'candidate' }, statusA: 'infra_excluded', statusB: 'not_run', winner: 'tie', referenceWinner: 'tie', excludedReason: 'environment' } },
      { caseId: 'cost-partial', status: 'partial', score: 50, durationMs: 1, data: { assignment: { A: 'baseline', B: 'candidate' }, statusA: 'cost_exceeded', statusB: 'partial', winner: 'candidate', referenceWinner: 'B' } },
    ];
    const { baseElement: container } = render(<>
      <EvalExperimentResult detail={resultDetail} onBack={vi.fn()} />
      <EvalExperimentWizard open probe={probe()} starting={false} onClose={vi.fn()} onStart={vi.fn()} />
    </>);
    const copy = container.textContent ?? '';
    for (const forbidden of [
      'infra_excluded', 'not_run', 'cost_exceeded', 'contextCompression',
      'scaffoldProfile', 'thinkingInjection', 'hooksEnabled', 'toolMode',
    ]) expect(copy).not.toContain(forbidden);
    for (const humanLabel of ['通过', '失败', '环境故障', '未执行', '成本超限', '部分通过', '上下文压缩', '工具模式']) {
      expect(copy).toContain(humanLabel);
    }
  });

  it('向导的「子代理」组：开关 + 层数进 candidate，本轮配置一行跟着变', () => {
    const onStart = vi.fn();
    render(<EvalExperimentWizard open probe={probe()} starting={false} onClose={vi.fn()} onStart={onStart} />);
    // 对照组只读行显示生产默认
    expect(screen.getByTestId('baseline-orchestration').textContent).toBe('子代理: 编排引导关 · 最深 3 层（默认）');
    const line = () => screen.getByTestId('candidate-orchestration-line').textContent;
    expect(line()).toBe('编排引导关 · 最深 3 层（默认）');

    fireEvent.click(screen.getByLabelText('目标任务里注入编排引导'));
    expect(line()).toBe('编排引导开 · 最深 3 层（默认）');

    fireEvent.change(screen.getByLabelText('最深层数'), { target: { value: '0' } });
    expect(line()).toBe('编排引导开 · 一层都不扇出');

    // 只改编排就足以发车（签名里有这一维）
    const button = screen.getByTestId('experiment-run-confirm') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      compare: { candidate: expect.objectContaining({
        orchestration: { allowSwarm: true, spawnMaxDepth: 0 },
      }) },
    }));
  });

  it('结果页有子代理次数列；候选臂开了扇出却零触发就打「未出场」', () => {
    const withSpawns = detail('candidate_better');
    withSpawns.cases = [{
      caseId: 'case-1', status: 'passed', score: 100, durationMs: 10,
      data: {
        assignment: { A: 'candidate', B: 'baseline' }, statusA: 'passed', statusB: 'failed',
        winner: 'candidate', referenceWinner: 'A',
        skillActivations: { baseline: 0, candidate: 2 },
        subagentSpawns: { baseline: 0, candidate: 4 },
      },
    }];
    (withSpawns.experiment.config as Record<string, unknown>).compare = {
      baseline: { name: 'production', model: 'm', provider: 'p' },
      candidate: { name: 'candidate-v3', model: 'm', provider: 'p', orchestration: { allowSwarm: true } },
      diff: ['子代理：不扇出，最深 3 层（默认） → 允许扇出，最深 3 层（默认）'],
    };
    const { unmount } = render(<EvalExperimentResult detail={withSpawns} onBack={vi.fn()} />);
    expect(screen.getByText('子代理次数 A/B')).toBeTruthy();
    expect(screen.getByTestId('experiment-pair-case-1').textContent).toContain('4/0');
    expect(screen.queryByTestId('experiment-subagent-not-used')).toBeNull();
    unmount();

    const quiet = detail('candidate_better');
    quiet.cases = [{
      caseId: 'case-1', status: 'passed', score: 100, durationMs: 10,
      data: {
        assignment: { A: 'candidate', B: 'baseline' }, statusA: 'passed', statusB: 'failed',
        winner: 'candidate', referenceWinner: 'A',
        subagentSpawns: { baseline: 0, candidate: 0 },
      },
    }];
    (quiet.experiment.config as Record<string, unknown>).compare = {
      baseline: { name: 'production', model: 'm', provider: 'p' },
      candidate: { name: 'candidate-v3', model: 'm', provider: 'p', orchestration: { allowSwarm: true } },
      diff: ['子代理：不扇出，最深 3 层（默认） → 允许扇出，最深 3 层（默认）'],
    };
    const { unmount: unmountQuiet } = render(<EvalExperimentResult detail={quiet} onBack={vi.fn()} />);
    expect(screen.getByTestId('experiment-subagent-not-used').textContent)
      .toBe('子代理未出场，结论不说明它的效果');
    unmountQuiet();

    // 候选臂根本没配编排（比如只改 systemPrompt）时不该冒这句噪音
    const unrelated = detail('candidate_better');
    unrelated.cases = quiet.cases;
    render(<EvalExperimentResult detail={unrelated} onBack={vi.fn()} />);
    expect(screen.queryByTestId('experiment-subagent-not-used')).toBeNull();
  });

  it('两个向导复用同一评测集选择组件', () => {
    const root = path.join(process.cwd(), 'packages/internal/evaluation-center/src/renderer/evalCenter');
    for (const file of ['EvalRunWizard.tsx', 'EvalExperimentWizard.tsx']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source).toContain("from './EvalCaseSelectionFields'");
      expect(source).toContain('<EvalCaseSelectionFields');
    }
  });
});

describe('N-EVAL-RESULT-HINT-TIERS：说明与「未出场」分层', () => {
  /** 候选臂开了长期记忆 + 允许扇出，但两样都零次出场 ⇒ 两条提示同时在场。 */
  function bothHints(): EvalExperimentDetail {
    const d = detail('candidate_better');
    d.cases = [{
      caseId: 'case-1', status: 'passed', score: 100, durationMs: 10,
      data: {
        assignment: { A: 'candidate', B: 'baseline' }, statusA: 'passed', statusB: 'failed',
        winner: 'candidate', referenceWinner: 'A',
        memoryInjections: { baseline: 0, candidate: 0 },
        subagentSpawns: { baseline: 0, candidate: 0 },
      },
    }];
    (d.experiment.config as Record<string, unknown>).compare = {
      baseline: { name: 'production', model: 'm', provider: 'p' },
      candidate: {
        name: 'candidate-v3', model: 'm', provider: 'p',
        memory: { longTerm: true }, orchestration: { allowSwarm: true },
      },
      diff: ['记忆：关 → 开'],
    };
    return d;
  }

  it('盲测说明留在灰条，两条「未出场」用可区分的提示样式且各自 testid 不变', () => {
    render(<EvalExperimentResult detail={bothHints()} onBack={vi.fn()} />);

    const blind = screen.getByTestId('experiment-blind-hint');
    const memory = screen.getByTestId('experiment-memory-not-used');
    const subagent = screen.getByTestId('experiment-subagent-not-used');

    // 说明档：灰，不带任何 badge 语义色
    expect(blind.className).toContain('text-zinc-400');
    expect(blind.className).not.toContain('badge');

    // 提示档：与说明不同色，且是包内既有的 badge token，不是新造的 zinc 灰
    for (const hint of [memory, subagent]) {
      expect(hint.className).toContain('text-badge-warning');
      expect(hint.className).toContain('bg-badge-warning');
      expect(hint.className).not.toContain('text-zinc-400');
      expect(hint.getAttribute('role')).toBe('status');
    }
    expect(memory.className).not.toBe(blind.className);

    // 文案本身没动（既有断言按整串比对）
    expect(memory.textContent).toBe('记忆未出场，结论不说明它的效果');
    expect(subagent.textContent).toBe('子代理未出场，结论不说明它的效果');
  });

  it('只在记忆或编排确实是实验变量时提示未出场', () => {
    const sameMemory = bothHints();
    const sameMemoryCompare = sameMemory.experiment.config as Record<string, unknown>;
    (sameMemoryCompare.compare as Record<string, unknown>).baseline = {
      name: 'production', model: 'm', provider: 'p', memory: { longTerm: true },
    };
    render(<EvalExperimentResult detail={sameMemory} onBack={vi.fn()} />);
    expect(screen.queryByTestId('experiment-memory-not-used')).toBeNull();
    cleanup();

    const changedMemory = bothHints();
    render(<EvalExperimentResult detail={changedMemory} onBack={vi.fn()} />);
    expect(screen.getByTestId('experiment-memory-not-used')).toBeTruthy();
    cleanup();

    const sameOrchestration = bothHints();
    const sameOrchestrationCompare = sameOrchestration.experiment.config as Record<string, unknown>;
    (sameOrchestrationCompare.compare as Record<string, unknown>).baseline = {
      name: 'production', model: 'm', provider: 'p', orchestration: { allowSwarm: true, spawnMaxDepth: 3 },
    };
    ((sameOrchestrationCompare.compare as Record<string, unknown>).candidate as Record<string, unknown>).orchestration = {
      allowSwarm: true, spawnMaxDepth: 3,
    };
    render(<EvalExperimentResult detail={sameOrchestration} onBack={vi.fn()} />);
    expect(screen.queryByTestId('experiment-subagent-not-used')).toBeNull();
    cleanup();

    const inheritedOrchestration = bothHints();
    const inheritedCompare = inheritedOrchestration.experiment.config as Record<string, unknown>;
    (inheritedCompare.compare as Record<string, unknown>).baseline = {
      name: 'production', model: 'm', provider: 'p', orchestration: { allowSwarm: true, spawnMaxDepth: 3 },
    };
    ((inheritedCompare.compare as Record<string, unknown>).candidate as Record<string, unknown>).orchestration = {
      allowSwarm: true,
    };
    render(<EvalExperimentResult detail={inheritedOrchestration} onBack={vi.fn()} />);
    expect(screen.queryByTestId('experiment-subagent-not-used')).toBeNull();
    cleanup();

    const changedOrchestration = bothHints();
    const changedOrchestrationCompare = changedOrchestration.experiment.config as Record<string, unknown>;
    (changedOrchestrationCompare.compare as Record<string, unknown>).baseline = {
      name: 'production', model: 'm', provider: 'p', orchestration: { allowSwarm: false, spawnMaxDepth: 0 },
    };
    ((changedOrchestrationCompare.compare as Record<string, unknown>).candidate as Record<string, unknown>).orchestration = {
      allowSwarm: true, spawnMaxDepth: 3,
    };
    ((changedOrchestrationCompare.compare as Record<string, unknown>).candidate as Record<string, unknown>).memory = undefined;
    render(<EvalExperimentResult detail={changedOrchestration} onBack={vi.fn()} />);
    expect(screen.getByTestId('experiment-subagent-not-used')).toBeTruthy();
  });
});
