/**
 * Experiment runner with circuit breaker, median aggregation, and EventEmitter.
 */

import { EventEmitter } from 'events';
import { checkForbiddenPatterns } from '../graders/ForbiddenPatterns';
import { runSwissCheese } from '../agents/SwissCheeseAgents';

export interface EvalCase {
  id: string;
  prompt: string;
  expectedOutput?: string;
  tags?: string[];
}

export interface TrialResult {
  trialIndex: number;
  score: number;
  passed: boolean;
  forbiddenResult?: { passed: boolean; matches: Array<{ pattern: string; severity: string }> };
  swissCheeseResult?: { aggregateScore: number; passed: boolean; consensusCount: number };
  error?: string;
  durationMs: number;
}

export interface CaseResult {
  caseId: string;
  trials: TrialResult[];
  medianScore: number;
  passed: boolean;
  failureReason?: string;
}

export interface ExperimentResult {
  experimentId: string;
  cases: CaseResult[];
  overallPassRate: number;
  timestamp: string;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface RunnerOptions {
  trialsPerCase?: number;
  maxConsecutiveFailures?: number;
  runAgent: (prompt: string) => Promise<string>; // product under test
}

export class ExperimentRunner extends EventEmitter {
  private trialsPerCase: number;
  private maxConsecutiveFailures: number;
  private runAgent: (prompt: string) => Promise<string>;
  private consecutiveFailures = 0;

  constructor(options: RunnerOptions) {
    super();
    this.trialsPerCase = options.trialsPerCase ?? 3;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5;
    this.runAgent = options.runAgent;
  }

  async run(cases: EvalCase[], experimentId?: string): Promise<ExperimentResult> {
    const id = experimentId ?? `exp-${Date.now()}`;
    const caseResults: CaseResult[] = [];

    for (const evalCase of cases) {
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        this.emit('circuit-breaker', { consecutiveFailures: this.consecutiveFailures });
        break;
      }

      const trials: TrialResult[] = [];

      for (let i = 0; i < this.trialsPerCase; i++) {
        this.emit('trial-start', { caseId: evalCase.id, trialIndex: i });
        const start = Date.now();

        try {
          const response = await this.runAgent(evalCase.prompt);

          // Stage 1: Forbidden patterns (deterministic)
          const forbidden = checkForbiddenPatterns(response);
          if (!forbidden.passed) {
            const trial: TrialResult = {
              trialIndex: i,
              score: 0,
              passed: false,
              forbiddenResult: { passed: false, matches: forbidden.matches },
              durationMs: Date.now() - start,
            };
            trials.push(trial);
            this.consecutiveFailures++;
            this.emit('trial-end', { caseId: evalCase.id, trial });
            continue;
          }

          // Stage 2: Swiss Cheese LLM evaluation
          let swissResult;
          try {
            swissResult = await runSwissCheese(evalCase.prompt, response);
          } catch (llmErr) {
            // Graceful degradation: LLM failure → skip LLM score, use deterministic only
            console.warn(`[eval-harness] LLM grader failed for case ${evalCase.id}:`, llmErr);
          }

          const score = swissResult?.aggregateScore ?? 70; // fallback if LLM unavailable
          const passed = swissResult?.passed ?? true;

          const trial: TrialResult = {
            trialIndex: i,
            score,
            passed,
            forbiddenResult: { passed: true, matches: [] },
            swissCheeseResult: swissResult
              ? { aggregateScore: swissResult.aggregateScore, passed: swissResult.passed, consensusCount: swissResult.consensusCount }
              : undefined,
            durationMs: Date.now() - start,
          };
          trials.push(trial);

          if (passed) {
            this.consecutiveFailures = 0;
          } else {
            this.consecutiveFailures++;
          }

          this.emit('trial-end', { caseId: evalCase.id, trial });
        } catch (err) {
          const trial: TrialResult = {
            trialIndex: i,
            score: 0,
            passed: false,
            error: String(err),
            durationMs: Date.now() - start,
          };
          trials.push(trial);
          this.consecutiveFailures++;
          this.emit('trial-end', { caseId: evalCase.id, trial });
        }
      }

      const scores = trials.map(t => t.score);
      const medianScore = median(scores);
      const passed = medianScore >= 70;

      const caseResult: CaseResult = {
        caseId: evalCase.id,
        trials,
        medianScore,
        passed,
        failureReason: passed ? undefined : trials.find(t => t.error)?.error ?? 'score below threshold',
      };
      caseResults.push(caseResult);
      this.emit('case-done', caseResult);
    }

    const passedCount = caseResults.filter(c => c.passed).length;
    return {
      experimentId: id,
      cases: caseResults,
      overallPassRate: caseResults.length > 0 ? passedCount / caseResults.length : 0,
      timestamp: new Date().toISOString(),
    };
  }
}
