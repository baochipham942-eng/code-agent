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
