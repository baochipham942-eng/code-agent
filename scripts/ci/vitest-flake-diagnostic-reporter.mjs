import { writeFileSync } from 'node:fs';

export default class VitestFlakeDiagnosticReporter {
  onTestRunEnd(testModules) {
    const testDiagnostics = testModules.flatMap((module) => [...module.children.allTests()].map((testCase) => {
      const diagnostic = testCase.diagnostic();
      return {
        file: testCase.module.moduleId,
        test: testCase.fullName,
        retryCount: diagnostic?.retryCount ?? 0,
        flaky: diagnostic?.flaky === true,
      };
    }));
    const output = process.env.VITEST_FLAKE_LEDGER_DIAGNOSTICS_FILE;
    if (!output) throw new Error('VITEST_FLAKE_LEDGER_DIAGNOSTICS_FILE is required');
    writeFileSync(output, JSON.stringify({ testDiagnostics }));
  }
}
