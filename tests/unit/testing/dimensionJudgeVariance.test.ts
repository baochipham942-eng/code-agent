// ============================================================================
// N-JEV-EVAL-JUDGE 验收③：冻结轨迹重复方差
// ----------------------------------------------------------------------------
// 同一条冻结轨迹重复判 N 次，把分数方差量出来。全程 mock/录播，不烧付费模型：
// - 确定性录播 ⇒ 两条路径（纯生成式 / Jev 初筛）方差都必须为 0——harness 自身不引入方差；
// - 注入「生成式判官以 p 概率翻转」的确定性抖动 ⇒ 纯生成式方差 ≈ p(1-p)（伯努利理论值），
//   而 Jev 初筛决断维方差 = 0（方差只留在弃权升级维）——证明初筛结构把模型抖动挡在决断维之外。
// 度量口径：yes=1 / no=0，取总体方差 mean((x-mean)^2)。
// ============================================================================
import { describe, expect, it, vi } from 'vitest';
import { judgeDimensions } from '../../../src/host/testing/judge/dimensionJudge';
import {
  EVAL_JUDGE_QUESTIONS,
  estimateJevCallUsd,
  type JevAnswers,
} from '../../../src/shared/constants/jevQuestions';
import type { AiReviewDimension } from '../../../src/shared/contract/evaluation';
import type { TestCase, TestResult } from '../../../src/host/testing/types';

const REPEATS = 80;
const FLIP_PROBABILITY = 0.25;

/** 冻结轨迹：一个「写了文件并跑了测试」的通过题。 */
function frozenCase(): TestCase {
  return {
    id: 'frozen-variance-case',
    type: 'task',
    description: '写脚本并自测',
    prompt: '写一个 hello.sh 打印 hello，并运行验证',
    expect: {},
  };
}

function frozenResult(): TestResult {
  return {
    testId: 'frozen-variance-case',
    description: '写脚本并自测',
    status: 'passed',
    score: 1,
    duration: 1,
    startTime: 0,
    endTime: 1,
    toolExecutions: [
      { tool: 'write_file', input: { path: 'hello.sh', content: 'echo hello' }, output: 'ok', success: true, duration: 1, timestamp: 0 },
      { tool: 'run_command', input: { command: 'bash hello.sh' }, output: 'hello', success: true, duration: 1, timestamp: 1 },
    ],
    responses: ['已写好 hello.sh 并运行，输出 hello'],
    errors: [],
    turnCount: 1,
  };
}

/** 确定性伪随机（mulberry32）：同 seed 同序列，测试可复现。 */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function answersFor(dims: AiReviewDimension[], noul: number): JevAnswers {
  const answers: JevAnswers = {};
  for (const dimension of dims) {
    for (const key of Object.keys(EVAL_JUDGE_QUESTIONS[dimension])) {
      answers[key] = { noul };
    }
  }
  return answers;
}

/** 录播生成式判官：以 p 概率翻转成「否」，模拟模型抖动；rand 由调用方注入。 */
function jitteredGenerative(rand: () => number, p: number) {
  return async () => (rand() < p ? '证据不足\n否' : '证据充分\n是');
}

function scoresOf(verdicts: Array<'yes' | 'no'>): number[] {
  return verdicts.map((verdict) => (verdict === 'yes' ? 1 : 0));
}

function variance(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

describe('冻结轨迹重复方差（N-JEV-EVAL-JUDGE）', () => {
  it('确定性录播：纯生成式与 Jev 初筛各判 30 次，方差都是 0（harness 不引入方差）', async () => {
    const dims: AiReviewDimension[] = ['task_completed'];
    const generativeScores: number[] = [];
    const prescreenScores: number[] = [];
    let prescreenCalls = 0;
    for (let i = 0; i < 30; i += 1) {
      const judged = await judgeDimensions(
        { testCase: frozenCase(), result: frozenResult(), dims },
        async () => '证据充分\n是',
      );
      generativeScores.push(...scoresOf([judged.task_completed!.verdict as 'yes' | 'no']));
      const screened = await judgeDimensions(
        { testCase: frozenCase(), result: frozenResult(), dims },
        vi.fn(async () => '不该调用\n否'),
        {
          prescreen: async () => {
            prescreenCalls += 1;
            return answersFor(dims, 0.9);
          },
        },
      );
      prescreenScores.push(...scoresOf([screened.task_completed!.verdict as 'yes' | 'no']));
    }
    expect(prescreenCalls).toBe(30);
    expect(variance(generativeScores)).toBe(0);
    expect(variance(prescreenScores)).toBe(0);
    console.info(`[variance] 确定性录播 ×30：generative=${variance(generativeScores)} prescreen=${variance(prescreenScores)}`);
  });

  it('生成式抖动 p=0.25：纯生成式方差 ≈ p(1-p)，Jev 初筛决断维方差 = 0 且零生成式调用', async () => {
    const dims: AiReviewDimension[] = ['task_completed'];
    const generativeScores: number[] = [];
    const prescreenScores: number[] = [];
    let escalatedCalls = 0;
    for (let i = 0; i < REPEATS; i += 1) {
      const judged = await judgeDimensions(
        { testCase: frozenCase(), result: frozenResult(), dims },
        jitteredGenerative(mulberry32(1000 + i), FLIP_PROBABILITY),
      );
      generativeScores.push(...scoresOf([judged.task_completed!.verdict as 'yes' | 'no']));
      const screened = await judgeDimensions(
        { testCase: frozenCase(), result: frozenResult(), dims },
        async () => {
          escalatedCalls += 1;
          return '不该走到\n否';
        },
        { prescreen: async () => answersFor(dims, 0.9) },
      );
      prescreenScores.push(...scoresOf([screened.task_completed!.verdict as 'yes' | 'no']));
    }
    const theory = FLIP_PROBABILITY * (1 - FLIP_PROBABILITY);
    expect(escalatedCalls).toBe(0);
    expect(variance(prescreenScores)).toBe(0);
    expect(variance(generativeScores)).toBeGreaterThan(0.08);
    expect(variance(generativeScores)).toBeLessThan(0.3);
    console.info(
      `[variance] 抖动 p=${FLIP_PROBABILITY} ×${REPEATS}：generative=${variance(generativeScores).toFixed(4)}（理论 p(1-p)=${theory}）prescreen=${variance(prescreenScores)}`,
    );
  });

  it('方差只留在弃权升级维：决断维 0，中间带维跟踪生成式抖动', async () => {
    const dims: AiReviewDimension[] = ['task_completed', 'confirmed_before_acting'];
    const decidedScores: number[] = [];
    const escalatedScores: number[] = [];
    for (let i = 0; i < REPEATS; i += 1) {
      const screened = await judgeDimensions(
        { testCase: frozenCase(), result: frozenResult(), dims },
        jitteredGenerative(mulberry32(2000 + i), FLIP_PROBABILITY),
        {
          prescreen: async () => ({
            ...answersFor(['task_completed'], 0.9),
            ...answersFor(['confirmed_before_acting'], 0.5),
          }),
        },
      );
      expect(screened.task_completed?.prescreen).toBe('jev_decided');
      expect(screened.confirmed_before_acting?.prescreen).toBe('escalated');
      decidedScores.push(...scoresOf([screened.task_completed!.verdict as 'yes' | 'no']));
      escalatedScores.push(...scoresOf([screened.confirmed_before_acting!.verdict as 'yes' | 'no']));
    }
    expect(variance(decidedScores)).toBe(0);
    expect(variance(escalatedScores)).toBeGreaterThan(0.08);
    console.info(
      `[variance] 弃权升级维 ×${REPEATS}：decided=${variance(decidedScores)} escalated=${variance(escalatedScores).toFixed(4)}`,
    );
  });

  it('全量评成本测算：冻结投影 + 五维问句的刊例估算（实测字符数，非编造）', async () => {
    const dims: AiReviewDimension[] = ['task_completed', 'confirmed_before_acting'];
    let stateChars = 0;
    let questionChars = 0;
    await judgeDimensions(
      { testCase: frozenCase(), result: frozenResult(), dims },
      async () => '证据充分\n是',
      {
        prescreen: async (state, questions) => {
          stateChars = JSON.stringify(state).length;
          questionChars = JSON.stringify(questions).length;
          return answersFor(dims, 0.9);
        },
      },
    );
    const usd = estimateJevCallUsd(stateChars, questionChars);
    expect(stateChars).toBeGreaterThan(0);
    expect(usd).toBeGreaterThan(0);
    console.info(
      `[cost] state=${stateChars} chars questions=${questionChars} chars ⇒ 单次 Jev 初筛刊例 ≈ $${usd.toFixed(6)}（输入 $0.042/Mtok，输出免费）`,
    );
  });
});
