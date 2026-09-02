import { writeFileSync } from 'node:fs';

export default class VitestFlakeDiagnosticReporter {
  onTestRunEnd(testModules, unhandledErrors) {
    const testDiagnostics = testModules.flatMap((module) => [...module.children.allTests()].map((testCase) => {
      const diagnostic = testCase.diagnostic();
      return {
        file: testCase.module.moduleId,
        test: testCase.fullName,
        retryCount: diagnostic?.retryCount ?? 0,
        flaky: diagnostic?.flaky === true,
      };
    }));
    const serializedUnhandledErrors = unhandledErrors.map((error) => ({
      name: typeof error?.name === 'string' ? error.name : 'Error',
      message: typeof error?.message === 'string' ? error.message : String(error),
      ...(typeof error?.VITEST_TEST_PATH === 'string' ? { file: error.VITEST_TEST_PATH } : {}),
      ...(typeof error?.VITEST_TEST_NAME === 'string' ? { test: error.VITEST_TEST_NAME } : {}),
      ...(typeof error?.stack === 'string' ? { stack: error.stack.split(/\r?\n/, 1)[0] } : {}),
    }));
    const output = process.env.VITEST_FLAKE_LEDGER_DIAGNOSTICS_FILE;
    if (!output) throw new Error('VITEST_FLAKE_LEDGER_DIAGNOSTICS_FILE is required');
    writeFileSync(output, JSON.stringify({ testDiagnostics, unhandledErrors: serializedUnhandledErrors }));
  }
}
