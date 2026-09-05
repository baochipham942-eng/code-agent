interface FastPolicy {
  baseline: string[];
  rules: Array<{ id: string; paths: string[]; files: string[] }>;
  packages: string[];
  sharedPackageInputs: string[];
  testsTypecheckInputs: string[];
}
interface Regression {
  paths: string[];
  files: string[];
  reason: string;
}
interface FastReport {
  success: boolean;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests?: number;
  numFailedTestSuites?: number;
  numRuntimeErrorTestSuites?: number;
  unhandledErrors?: unknown[];
  testResults: Array<{ name: string; status: string; assertionResults: Array<{ status: string }> }>;
}
export function digest(value: string | Uint8Array): string;
export function assertExactFiles(expected: string[], actual: string[], phase: string): void;
export function validateFiles(root: string, files: string[], maxFiles: number): void;
export function selectTests(policy: FastPolicy, changed: string[], regressions?: Regression[]): {
  files: string[]; matchedRules: string[]; packages: string[]; testsTypecheck: boolean;
};
export function validateReport(expected: string[], report: FastReport, root: string): {
  files: number; tests: number; passed: number; hash: string;
};
export function renderReceipt(receipt: {
  status: string; schemaVersion: number; headSha: string; baseSha: string;
  receiptId: string; ci: { status: string }; prNumber: number | null; error?: string;
}): string[];
