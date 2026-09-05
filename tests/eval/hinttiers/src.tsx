// N-EVAL-RESULT-HINT-TIERS 视觉证据入口：只挂实验结果页，喂一份「记忆和子代理都零出场」
// 的对照实验，让三条提示（盲测说明 / 记忆未出场 / 子代理未出场）同屏出现。
// 组件测试只能断言 class 名，证明不了 badge token 在真主题里解析成什么颜色 —— 这里补上像素。
import React from 'react';
import { createRoot } from 'react-dom/client';
import type { EvalExperimentDetail, EvalShipGateVerdict } from '@shared/contract/evaluation';
import { UNKNOWN_EVAL_RUN_STAMP } from '@shared/contract/evaluation';
import { EvalExperimentResult } from '@internal-evaluation/renderer/evalCenter/EvalExperimentResult';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import '../../../src/renderer/styles/global.css';

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = theme;
document.documentElement.className = theme;

const shipGate: EvalShipGateVerdict = {
  state: 'candidate_better', delta: 3, nMin: 30, decisivePairs: 18, pValue: 0.04,
  passRateDiff: 0.1, ciLowerBound: -0.01,
  hardGate: { passed: true, items: [{ key: 'false_allow', status: 'pass', count: 0 }] },
  calibre: { k: 1, aggregationRuleVersion: 4, promptVersion: 'sys-v45' }, reasons: [],
};

const detail: EvalExperimentDetail = {
  experiment: {
    id: 'exp-hint-tiers', name: 'candidate-v3', timestamp: 1, model: 'm', provider: 'p',
    scope: 'full', source: 'compare', gitCommit: 'abc',
    config: {
      ...UNKNOWN_EVAL_RUN_STAMP,
      compare: {
        baseline: { name: 'production', model: 'm', provider: 'p' },
        candidate: {
          name: 'candidate-v3', model: 'm', provider: 'p',
          memory: { longTerm: true }, orchestration: { allowSwarm: true },
        },
        diff: ['记忆：关 → 开'],
      },
    },
    summary: {
      completed: true,
      compare: {
        totalCases: 20, baselineWins: 7, candidateWins: 11, ties: 2, excludedPairs: 1,
        skillNotActivatedPairs: 1, pValue: 0.04, shipGate,
      },
    },
  },
  cases: [{
    caseId: 'case-1', status: 'passed', score: 100, durationMs: 10,
    data: {
      assignment: { A: 'candidate', B: 'baseline' }, statusA: 'passed', statusB: 'failed',
      winner: 'candidate', referenceWinner: 'A',
      memoryInjections: { baseline: 0, candidate: 0 },
      subagentSpawns: { baseline: 0, candidate: 0 },
    },
  }],
};

useAppStore.setState({ language: 'zh' });

createRoot(document.getElementById('root')!).render(
  <div style={{ width: 900 }}>
    <EvalExperimentResult detail={detail} onBack={() => undefined} />
  </div>,
);
