export interface RegressionCase {
  id: string
  filePath: string
  source: string
  tags: string[]
  relatedRules: string[]
  evalCommand: string
  scenario: string
  expectedBehavior: string
}

export interface CaseResult {
  id: string
  status: 'pass' | 'fail' | 'error'
  durationMs: number
  stdout: string
  stderr: string
  exitCode: number
  errorMessage?: string
}

export interface RegressionReport {
  runId: string
  timestamp: string
  totalCases: number
  passed: number
  failed: number
  errored: number
  passRate: number
  results: CaseResult[]
  durationMs: number
}

export interface Baseline {
  passRate: number
  passed: number
  totalCases: number
  capturedAt: string
  commit?: string
}

export interface GateDecision {
  decision: 'pass' | 'block'
  currentPassRate: number
  baselinePassRate: number
  delta: number
  blockedCases: string[]
  reason: string
}
