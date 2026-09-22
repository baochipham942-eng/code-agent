// WIRE3 对照（N-JEV-DIMJUDGE-WIRE3 验收②）：同一批 60 条冻结轨迹，三维接电开/关两臂，
// 出各维判决分布差异。关臂 = #1479 短路原状（零调用零成本）；开臂真 Jev（刊例 ~$0.00002/题）。
// 生成式侧 mock：升级兜底一律回「无法确定」（不伪造 yes/no，只计升级次数）。
// key 走仓内 09-19 回放同款 ~/.config/typesafe/api_key；本脚本永不打印 key。
import fs from 'node:fs';
import os from 'node:os';
import { judgeDimensions } from '../../../../src/host/testing/judge/dimensionJudge';
import { estimateJevCallUsd } from '../../../../src/shared/constants/jevQuestions';
import type { AiReviewDimension } from '../../../../src/shared/contract/evaluation';
import { WIRE3_TRACES, type GoldTrace } from './traces';

const KEY = fs.readFileSync(`${os.homedir()}/.config/typesafe/api_key`, 'utf8').trim();
const MODEL = 'jev-1.13.0';
const CONCURRENCY = 5;
const ALL_DIMS: AiReviewDimension[] = [
  'task_completed', 'tool_choice', 'confirmed_before_acting', 'no_extra_changes', 'self_tested',
];

async function jevCall(state: Record<string, unknown>, questions: Record<string, unknown>) {
  const response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, model: MODEL, questions }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  return ((await response.json()) as { answers: Record<string, never> }).answers;
}

async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length) as R[];
  let cursor = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index]);
    }
  }));
  return out;
}

type Cell = string; // `${verdict}:${origin}`

interface ArmRun {
  id: string;
  cells: Partial<Record<AiReviewDimension, Cell>>;
  escalations: number;
  wallMs: number;
  usd: number;
  error?: string;
}

async function runArm(item: GoldTrace, wire: boolean): Promise<ArmRun> {
  const started = Date.now();
  let escalations = 0;
  let usd = 0;
  try {
    const verdicts = await judgeDimensions(
      { testCase: item.testCase, result: item.result, dims: ALL_DIMS },
      async () => {
        escalations += 1;
        return '升级兜底：录播弃权\n无法确定'; // 生成式侧 mock：不伪造判决，升级记为 abstain
      },
      wire
        ? {
            judgeExpectationDims: true,
            prescreen: async (state, questions) => {
              usd += estimateJevCallUsd(JSON.stringify(state).length, JSON.stringify(questions).length);
              return jevCall(state, questions);
            },
          }
        : undefined,
    );
    const cells: ArmRun['cells'] = {};
    for (const dim of ALL_DIMS) {
      const verdict = verdicts[dim];
      cells[dim] = verdict ? `${verdict.verdict}:${verdict.prescreen ?? 'gen'}` : 'none';
    }
    return { id: item.testCase.id, cells, escalations, wallMs: Date.now() - started, usd };
  } catch (error) {
    return { id: item.testCase.id, cells: {}, escalations, wallMs: Date.now() - started, usd, error: String(error) };
  }
}

function distribution(runs: ArmRun[]): Record<string, Record<string, number>> {
  const table: Record<string, Record<string, number>> = {};
  for (const run of runs) {
    for (const [dim, cell] of Object.entries(run.cells)) {
      table[dim] ??= {};
      table[dim][cell] = (table[dim][cell] ?? 0) + 1;
    }
  }
  return table;
}

async function main() {
  // 关臂：#1479 短路原状，零 Jev/零生成式成本
  const off = await mapPool(WIRE3_TRACES, CONCURRENCY, (trace) => runArm(trace, false));
  // 开臂：真 Jev 初筛，五维全问
  const on = await mapPool(WIRE3_TRACES, CONCURRENCY, (trace) => runArm(trace, true));

  const out = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    traces: WIRE3_TRACES.length,
    offArm: {
      distribution: distribution(off),
      escalations: off.reduce((sum, run) => sum + run.escalations, 0),
      note: '关臂生成式侧 mock 一律弃权，只为占位；三维全部 no_expectation 即 #1479 原状',
    },
    onArm: {
      distribution: distribution(on),
      escalations: on.reduce((sum, run) => sum + run.escalations, 0),
      errors: on.filter((run) => run.error).length,
      wallMsMean: on.reduce((sum, run) => sum + run.wallMs, 0) / on.length,
      jevCostUsd: on.reduce((sum, run) => sum + run.usd, 0),
    },
    on,
  };
  fs.writeFileSync(new URL('./wire3-compare-out.json', import.meta.url), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ offArm: out.offArm, onArm: out.onArm }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
