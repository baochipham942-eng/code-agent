// ============================================================================
// Regression Floor Gate CLI
// ============================================================================
// 用法:
//   npm run regression              — 等价 run，跑一轮，stdout 输出 JSON 报告
//   npm run regression run          — 同上
//   npm run regression gate         — 跑一轮 + 对比 baseline，产出 gate decision
//   npm run regression baseline     — 跑一轮并写入 baseline.json
//
// 用于 /synthesize skill Step 3.5 自动门禁，阈值 5pp 下降则 block。
// ============================================================================

import * as path from 'node:path';
import * as os from 'node:os';
import {
  runRegression,
  decideGate,
  readBaseline,
  writeBaseline,
} from '../src/main/evaluation/regression';

const CASES_DIR = path.join(os.homedir(), '.claude', 'regression-cases');
const BASELINE_FILE = path.join(CASES_DIR, 'baseline.json');
const THRESHOLD_PCT = 5;

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'run';

  switch (cmd) {
    case 'run': {
      const report = await runRegression(CASES_DIR);
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.failed + report.errored > 0 ? 1 : 0);
    }

    case 'gate': {
      const report = await runRegression(CASES_DIR);
      const baseline = await readBaseline(BASELINE_FILE);
      const decision = decideGate({
        current: {
          passRate: report.passRate,
          passed: report.passed,
          totalCases: report.totalCases,
          results: report.results,
        },
        baseline,
        thresholdPct: THRESHOLD_PCT,
      });
      console.log(JSON.stringify({ report, decision }, null, 2));
      process.exit(decision.decision === 'block' ? 1 : 0);
    }

    case 'baseline': {
      const report = await runRegression(CASES_DIR);
      await writeBaseline(BASELINE_FILE, {
        passRate: report.passRate,
        passed: report.passed,
        totalCases: report.totalCases,
        capturedAt: report.timestamp,
      });
      console.log(
        `baseline written: ${report.passed}/${report.totalCases} = ${(report.passRate * 100).toFixed(1)}%`,
      );
      process.exit(0);
    }

    default:
      console.error(`unknown command: ${cmd}`);
      console.error('usage: regression [run|gate|baseline]');
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
