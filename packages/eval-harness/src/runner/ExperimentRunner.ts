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

export interface TelemetryCompletenessLike {
  sessionId?: string;
  replayKey?: string;
  turnCount?: number;
  modelCallCount?: number;
  toolCallCount?: number;
  eventCount?: number;
  hasSessionId?: boolean;
  hasModelDecisions?: boolean;
  hasToolSchemas?: boolean;
  hasPermissionTrace?: boolean;
  hasContextCompressionEvents?: boolean;
  hasSubagentTelemetry?: boolean;
  hasRealAgentTrace?: boolean;
  dataSource?: 'telemetry' | 'transcript_fallback' | string;
  source?: string;
  incompleteReasons?: string[];
}

export interface AgentRunOutput {
  response: string;
  sessionId?: string;
  replayKey?: string;
  telemetryCompleteness?: TelemetryCompletenessLike;
  replayExplanation?: string;
}

export interface TrialResult {
  trialIndex: number;
  score: number;
  passed: boolean;
  sessionId?: string;
  replayKey?: string;
  telemetryCompleteness?: TelemetryCompletenessLike;
  replayExplanation?: string;
  degraded?: boolean;
  gateFailures?: string[];
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
  runAgent: (prompt: string) => Promise<string | AgentRunOutput>; // product under test
}

export class ExperimentRunner extends EventEmitter {
  private trialsPerCase: number;
  private maxConsecutiveFailures: number;
  private runAgent: (prompt: string) => Promise<string | AgentRunOutput>;
  private consecutiveFailures = 0;

  constructor(options: RunnerOptions) {
    super();
    this.trialsPerCase = options.trialsPerCase ?? 3;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5;
    this.runAgent = options.runAgent;
  }

  private normalizeAgentOutput(output: string | AgentRunOutput): AgentRunOutput {
    if (typeof output === 'string') {
      return { response: output };
    }
    return output;
  }

  private realAgentRunGate(output: AgentRunOutput): string[] {
    const failures: string[] = [];
    const completeness = output.telemetryCompleteness;

    if (!output.sessionId && !completeness?.sessionId) failures.push('missing_session_id');
    if (!output.replayKey && !completeness?.replayKey) failures.push('missing_replay_key');
    if (!completeness) {
      failures.push('missing_telemetry_completeness');
      return failures;
    }
    const dataSource = completeness.dataSource ?? completeness.source;
    if (!dataSource) failures.push('missing_telemetry_data_source');
    if (dataSource === 'transcript_fallback') failures.push('transcript_fallback_replay');
    if (dataSource && dataSource !== 'telemetry' && dataSource !== 'transcript_fallback') {
      failures.push('missing_telemetry_data_source');
    }
    if ((completeness.turnCount ?? 0) <= 0) failures.push('missing_turns');
    if ((completeness.modelCallCount ?? 0) <= 0 || completeness.hasModelDecisions !== true) {
      failures.push('missing_model_decisions');
    }
    if ((completeness.toolCallCount ?? 0) <= 0) failures.push('missing_tool_calls');
    if ((completeness.eventCount ?? 0) <= 0) failures.push('missing_event_trace');
    if (completeness.hasToolSchemas !== true) failures.push('missing_tool_schemas');
    if (completeness.hasRealAgentTrace !== true) failures.push('missing_real_agent_trace');
    if (!output.replayExplanation) {
      failures.push('missing_replay_explanation');
    }

    return Array.from(new Set([...(completeness.incompleteReasons || []), ...failures]));
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
          const agentOutput = this.normalizeAgentOutput(await this.runAgent(evalCase.prompt));
          const response = agentOutput.response;
          const requiresRealAgentRun = evalCase.tags?.includes('real-agent-run') ?? false;
          const gateFailures = requiresRealAgentRun ? this.realAgentRunGate(agentOutput) : [];
          if (gateFailures.length > 0) {
            const trial: TrialResult = {
              trialIndex: i,
              score: 0,
              passed: false,
              sessionId: agentOutput.sessionId,
              replayKey: agentOutput.replayKey,
              telemetryCompleteness: agentOutput.telemetryCompleteness,
              replayExplanation: agentOutput.replayExplanation,
              degraded: true,
              gateFailures,
              error: `real-agent-run gate failed: ${gateFailures.join(', ')}`,
              durationMs: Date.now() - start,
            };
            trials.push(trial);
            this.consecutiveFailures++;
            this.emit('trial-end', { caseId: evalCase.id, trial });
            continue;
          }

          // Stage 1: Forbidden patterns (deterministic)
          const forbidden = checkForbiddenPatterns(response);
          if (!forbidden.passed) {
            const trial: TrialResult = {
              trialIndex: i,
              score: 0,
              passed: false,
              sessionId: agentOutput.sessionId,
              replayKey: agentOutput.replayKey,
              telemetryCompleteness: agentOutput.telemetryCompleteness,
              replayExplanation: agentOutput.replayExplanation,
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
            console.warn(`[eval-harness] LLM grader failed for case ${evalCase.id}:`, llmErr);
            const trial: TrialResult = {
              trialIndex: i,
              score: 0,
              passed: false,
              sessionId: agentOutput.sessionId,
              replayKey: agentOutput.replayKey,
              telemetryCompleteness: agentOutput.telemetryCompleteness,
              replayExplanation: agentOutput.replayExplanation,
              forbiddenResult: { passed: true, matches: [] },
              error: `LLM grader failed: ${String(llmErr)}`,
              durationMs: Date.now() - start,
            };
            trials.push(trial);
            this.consecutiveFailures++;
            this.emit('trial-end', { caseId: evalCase.id, trial });
            continue;
          }

          const score = swissResult.aggregateScore;
          const passed = swissResult.passed;

          const trial: TrialResult = {
            trialIndex: i,
            score,
            passed,
            sessionId: agentOutput.sessionId,
            replayKey: agentOutput.replayKey,
            telemetryCompleteness: agentOutput.telemetryCompleteness,
            replayExplanation: agentOutput.replayExplanation,
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
      const requiresRealAgentRun = evalCase.tags?.includes('real-agent-run') ?? false;
      const gateFailedTrials = requiresRealAgentRun
        ? trials.filter(t => t.degraded === true || (t.gateFailures?.length ?? 0) > 0)
        : [];
      const gateFailures = Array.from(new Set(gateFailedTrials.flatMap(t => t.gateFailures || [])));
      const medianScore = median(scores);
      const passed = gateFailedTrials.length > 0 ? false : medianScore >= 70;
      const gateFailureReason = gateFailedTrials.length > 0
        ? `real-agent-run gate failed: ${
            gateFailures.length > 0
              ? gateFailures.join(', ')
              : gateFailedTrials.find(t => t.error)?.error ?? 'degraded telemetry replay'
          }`
        : undefined;

      const caseResult: CaseResult = {
        caseId: evalCase.id,
        trials,
        medianScore,
        passed,
        failureReason: passed ? undefined : gateFailureReason ?? trials.find(t => t.error)?.error ?? 'score below threshold',
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
