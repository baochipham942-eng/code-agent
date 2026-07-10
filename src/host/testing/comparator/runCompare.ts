// WP1-3：ABComparator 接线层 — 每个配置一个独立 agent + TestRunner，
// 喂给 ABComparator 做成对盲测。comparator 本体已完整实现（盲分配/
// 双评分卡/unblind），此处只接线不重写。
import { TestRunner, type AgentInterface } from '../testRunner';
import { ABComparator } from './comparator';
import type {
  CompareConfiguration,
  ComparisonResult,
  TestCase,
  TestRunnerConfig,
} from '../types';

export interface RunCompareOptions {
  testCases: TestCase[];
  baseline: CompareConfiguration;
  candidate: CompareConfiguration;
  /** 按配置建 agent（eval-ci 传 StandaloneAgentAdapter 工厂；测试传 mock） */
  makeAgent: (config: CompareConfiguration) => AgentInterface;
  runnerConfig: TestRunnerConfig;
  /** 可选 LLM 评审回调；缺省走 ABGrader 的 heuristic 规则（无额外 API 成本） */
  llmCall?: (prompt: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// A3 臂激活断言（maka #623 retrieval arm 空跑教训泛化）：
// 「开关开了 ≠ 链路真触发」——--compare 报数前必须证明对照臂活着。
// 两道准入 preflight，由 eval-ci 的 --compare 路径在报数前调用：
//   1. assertCompareArmsDistinct（跑前，零成本）：candidate 的有效配置与
//      baseline 完全相同 = 对照臂没有区分特征，A/B 是 X vs X，拒绝发车。
//   2. assertCompareArmsActivated（跑后）：没有任何有效配对数据（零 case，
//      或全部 pair 因一侧没跑成被排除）时拒绝产出对比报告——「无数据」
//      不许冒充成「势均力敌」的报数。
// ---------------------------------------------------------------------------

/**
 * candidate 未写的字段在 makeAgent 时会回落到 baseline 值（config.model ||
 * resolvedModel 语义），所以判等必须按「回落后的有效配置」算，否则一个只有
 * name 的 candidate YAML 会以「字段是 undefined」为由被误判为有差异。
 */
function effectiveArmSignature(
  config: CompareConfiguration,
  baseline: CompareConfiguration,
): string {
  return JSON.stringify({
    model: config.model ?? baseline.model ?? null,
    provider: config.provider ?? baseline.provider ?? null,
    systemPrompt: config.systemPrompt ?? baseline.systemPrompt ?? null,
    enabledTools: config.enabledTools ?? baseline.enabledTools ?? null,
    temperature: config.temperature ?? baseline.temperature ?? null,
    agentConfig: config.agentConfig ?? baseline.agentConfig ?? null,
  });
}

/** 跑前断言：对照臂必须与 baseline 至少有一个真实差异，否则 A/B 无意义。 */
export function assertCompareArmsDistinct(
  baseline: CompareConfiguration,
  candidate: CompareConfiguration,
): void {
  if (effectiveArmSignature(candidate, baseline) === effectiveArmSignature(baseline, baseline)) {
    throw new Error(
      '[compare-arm-activation] candidate 的有效配置与 baseline 完全相同' +
      '（model/provider/systemPrompt/enabledTools/temperature/agentConfig 回落后均一致）。' +
      '对照臂没有区分特征，A/B 对比是 X vs X——先给 candidate 配置一个真实差异再发车。',
    );
  }
}

/** 跑后断言：至少有 1 个双臂都真跑成的有效 pair，才允许报数。 */
export function assertCompareArmsActivated(result: ComparisonResult): void {
  if (result.cases.length === 0) {
    throw new Error(
      '[compare-arm-activation] 没有任何 case 进入对比（过滤为空或全部 skip），拒绝产出对比报告。',
    );
  }
  if (result.summary.totalCases === 0) {
    const reasons = result.cases
      .map((c) => c.excludedReason)
      .filter(Boolean)
      .join('; ');
    throw new Error(
      `[compare-arm-activation] 全部 ${result.cases.length} 个 pair 均因一侧没跑成被排除，` +
      `没有任何有效配对数据——臂未激活，拒绝报数。排除原因：${reasons || '(未记录)'}`,
    );
  }
}

export async function runCompare(opts: RunCompareOptions): Promise<ComparisonResult> {
  const runners = new Map<CompareConfiguration, TestRunner>([
    [opts.baseline, new TestRunner(opts.runnerConfig, opts.makeAgent(opts.baseline))],
    [opts.candidate, new TestRunner(opts.runnerConfig, opts.makeAgent(opts.candidate))],
  ]);

  const comparator = new ABComparator(opts.baseline, opts.candidate);
  return comparator.runComparison(
    opts.testCases,
    async (testCase, config) => {
      const runner = runners.get(config);
      if (!runner) {
        throw new Error(`runCompare: no runner registered for config "${config.name}"`);
      }
      return runner.runSingleTest(testCase);
    },
    opts.llmCall,
  );
}
