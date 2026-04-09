// ============================================================================
// Trajectory Builder - Constructs Trajectory from agent events
// ============================================================================

import type {
  Trajectory,
  TrajectoryStep,
  RecoveryPattern,
  TrajectoryEfficiency,
  TestResult,
  TestCase,
} from '../../testing/types';

/**
 * Raw event input shape (matches StoredEvent fields relevant to building)
 */
interface EventInput {
  event_type: string;
  event_data: Record<string, unknown>;
  timestamp: string;
}

/**
 * Builds a Trajectory from raw agent events or test results.
 *
 * Event types understood (from SessionEventService):
 * - tool_start: tool call initiated (data.tool / data.name, data.args)
 * - tool_result: tool call completed (data.tool / data.name, data.success, data.error, data.result)
 * - error: error occurred (data.message / data.error)
 * - thinking / reasoning: agent thinking (data.content)
 * - message: agent message (data.content)
 * - agent_complete: session ended
 */
export class TrajectoryBuilder {
  // ---- public API ----

  buildFromEvents(events: EventInput[]): Trajectory {
    const steps = this.buildSteps(events);
    const recoveryPatterns = this.detectRecoveryPatterns(steps);
    const efficiency = this.calculateEfficiency(steps);
    const deviations: Trajectory['deviations'] = []; // filled later by DeviationDetector

    const startTs = events.length > 0 ? this.toTimestamp(events[0].timestamp) : Date.now();
    const endTs = events.length > 0 ? this.toTimestamp(events[events.length - 1].timestamp) : startTs;

    const criticalPath = this.extractCriticalPath(steps);
    const firstDeviation = deviations.length > 0 ? deviations[0].stepIndex : undefined;
    const outcome = this.inferOutcome(steps);

    return {
      id: `traj_${startTs}`,
      sessionId: '',
      startTime: startTs,
      endTime: endTs,
      steps,
      deviations,
      recoveryPatterns,
      efficiency,
      summary: {
        intent: this.inferIntent(steps),
        outcome,
        criticalPath,
        firstDeviationIndex: firstDeviation,
      },
    };
  }

  buildFromTestResult(result: TestResult, testCase?: TestCase): Trajectory {
    // Convert ToolExecutionRecords into the generic event format
    const events: EventInput[] = [];
    for (const exec of result.toolExecutions) {
      events.push({
        event_type: 'tool_start',
        event_data: { tool: exec.tool, args: exec.input },
        timestamp: String(exec.timestamp),
      });

      const resultData: Record<string, unknown> = {
        tool: exec.tool,
        success: exec.success,
        result: exec.output,
      };
      if (exec.error) resultData.error = exec.error;

      events.push({
        event_type: 'tool_result',
        event_data: resultData,
        timestamp: String(exec.timestamp + exec.duration),
      });
    }

    // Add error events from result.errors
    for (const errMsg of result.errors) {
      events.push({
        event_type: 'error',
        event_data: { message: errMsg },
        timestamp: String(result.endTime),
      });
    }

    const trajectory = this.buildFromEvents(events);

    trajectory.id = `traj_${result.testId}_${result.startTime}`;
    trajectory.testCaseId = result.testId;
    trajectory.startTime = result.startTime;
    trajectory.endTime = result.endTime;

    // Enrich outcome from test status
    if (result.status === 'passed') trajectory.summary.outcome = 'success';
    else if (result.status === 'partial') trajectory.summary.outcome = 'partial';
    else if (result.status === 'failed') trajectory.summary.outcome = 'failure';

    // Enrich intent from test case if available
    if (testCase) {
      trajectory.summary.intent = testCase.description;
    }

    return trajectory;
  }

  // ---- internal helpers ----

  private buildSteps(events: EventInput[]): TrajectoryStep[] {
    const steps: TrajectoryStep[] = [];
    // Pending map by tool name (legacy `tool_start`/`tool_result` events).
    const pendingByName = new Map<string, { event: EventInput; stepIndex: number }>();
    // Pending map by tool call id (current `tool_call_start`/`tool_call_end` events).
    const pendingById = new Map<string, { stepIndex: number }>();
    let stepIndex = 0;

    for (const event of events) {
      const data = event.event_data ?? {};
      const ts = this.toTimestamp(event.timestamp);

      switch (event.event_type) {
        // Legacy `tool_start` and current `tool_call_start` share a code path.
        case 'tool_start':
        case 'tool_call_start': {
          const toolName = String(data.tool ?? data.name ?? 'unknown');
          const args = (data.args ?? data.arguments ?? {}) as Record<string, unknown>;
          const toolCallId = data.id != null ? String(data.id) : undefined;

          const step: TrajectoryStep = {
            index: stepIndex,
            timestamp: ts,
            type: 'tool_call',
            toolCall: {
              name: toolName,
              args,
              success: true, // default, updated on end/result
              duration: 0,
            },
          };

          if (toolCallId) {
            pendingById.set(toolCallId, { stepIndex });
          } else {
            pendingByName.set(toolName, { event, stepIndex });
          }
          steps.push(step);
          stepIndex++;
          break;
        }

        // Legacy `tool_result` and current `tool_call_end` share a code path.
        case 'tool_result':
        case 'tool_call_end': {
          const toolCallId = data.toolCallId != null ? String(data.toolCallId) : undefined;
          const toolName = String(data.tool ?? data.name ?? 'unknown');
          const resultPayload = data.result ?? data.output;

          // Prefer id-based pairing when available.
          let pendingStepIndex: number | undefined;
          if (toolCallId && pendingById.has(toolCallId)) {
            pendingStepIndex = pendingById.get(toolCallId)!.stepIndex;
            pendingById.delete(toolCallId);
          } else if (pendingByName.has(toolName)) {
            pendingStepIndex = pendingByName.get(toolName)!.stepIndex;
            pendingByName.delete(toolName);
          }

          if (pendingStepIndex !== undefined) {
            const step = steps[pendingStepIndex];
            if (step?.toolCall) {
              step.toolCall.success = data.success !== false && !data.error;
              step.toolCall.duration =
                typeof data.duration === 'number' ? data.duration : ts - step.timestamp;
              if (resultPayload != null) {
                step.toolCall.result = String(resultPayload).slice(0, 2000);
              }
            }
          } else {
            // Orphan result – create a standalone step.
            const step: TrajectoryStep = {
              index: stepIndex,
              timestamp: ts,
              type: 'tool_call',
              toolCall: {
                name: toolName,
                args: {},
                success: data.success !== false && !data.error,
                duration: typeof data.duration === 'number' ? data.duration : 0,
                result: resultPayload != null ? String(resultPayload).slice(0, 2000) : undefined,
              },
            };
            steps.push(step);
            stepIndex++;
          }
          break;
        }

        case 'error': {
          const message = String(data.message ?? data.error ?? 'Unknown error');
          const step: TrajectoryStep = {
            index: stepIndex,
            timestamp: ts,
            type: 'error',
            error: {
              message,
              code: data.code != null ? String(data.code) : undefined,
              recoverable: true, // assume recoverable; refined later
            },
          };
          steps.push(step);
          stepIndex++;
          break;
        }

        case 'thinking':
        case 'reasoning': {
          const content = String(data.content ?? '');
          if (content.length > 0) {
            const step: TrajectoryStep = {
              index: stepIndex,
              timestamp: ts,
              type: 'decision',
              decision: {
                reasoning: content.slice(0, 1000),
                chosenAction: 'thinking',
              },
            };
            steps.push(step);
            stepIndex++;
          }
          break;
        }

        // message, agent_complete – not mapped to steps
        default:
          break;
      }
    }

    return steps;
  }

  private detectRecoveryPatterns(steps: TrajectoryStep[]): RecoveryPattern[] {
    const patterns: RecoveryPattern[] = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      // Look for error or failed tool_call
      const isFailure =
        step.type === 'error' ||
        (step.type === 'tool_call' && step.toolCall && !step.toolCall.success);

      if (!isFailure) continue;

      const failedToolName =
        step.type === 'tool_call' ? step.toolCall?.name : undefined;

      // Scan forward for recovery attempts
      let attempts = 0;
      let recoveryIdx = -1;
      let successful = false;

      for (let j = i + 1; j < steps.length && j <= i + 10; j++) {
        const candidate = steps[j];
        if (candidate.type !== 'tool_call' || !candidate.toolCall) continue;

        // Same tool or any tool after an error = recovery attempt
        const isSameTool = failedToolName && candidate.toolCall.name === failedToolName;
        if (isSameTool || step.type === 'error') {
          attempts++;
          recoveryIdx = j;
          if (candidate.toolCall.success) {
            successful = true;
            break;
          }
        }
      }

      if (attempts > 0 && recoveryIdx >= 0) {
        patterns.push({
          errorStepIndex: i,
          recoveryStepIndex: recoveryIdx,
          attempts,
          strategy: failedToolName ? 'retry_same_tool' : 'retry_after_error',
          successful,
          tokenCost: 0, // token tracking not available from events
        });
      }
    }

    return patterns;
  }

  private calculateEfficiency(steps: TrajectoryStep[]): TrajectoryEfficiency {
    const totalSteps = steps.length;
    let redundantSteps = 0;
    let backtrackCount = 0;
    let totalDuration = 0;

    // Detect redundant steps: consecutive identical tool calls
    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1];
      const curr = steps[i];
      if (
        prev.type === 'tool_call' &&
        curr.type === 'tool_call' &&
        prev.toolCall &&
        curr.toolCall &&
        prev.toolCall.name === curr.toolCall.name &&
        JSON.stringify(prev.toolCall.args) === JSON.stringify(curr.toolCall.args)
      ) {
        redundantSteps++;
        backtrackCount++;
      }
    }

    // Add failed tool calls to redundant if they didn't contribute
    for (const step of steps) {
      if (step.type === 'tool_call' && step.toolCall) {
        totalDuration += step.toolCall.duration;
        if (!step.toolCall.success) redundantSteps++;
      }
    }

    // Deduplicate: a failed call that was also counted as consecutive
    redundantSteps = Math.min(redundantSteps, totalSteps);

    const effectiveSteps = Math.max(totalSteps - redundantSteps, 0);
    const efficiency = totalSteps > 0 ? effectiveSteps / totalSteps : 1;

    return {
      totalSteps,
      effectiveSteps,
      redundantSteps,
      backtrackCount,
      totalTokens: { input: 0, output: 0 },
      totalDuration,
      tokensPerEffectiveStep: 0,
      efficiency,
    };
  }

  private extractCriticalPath(steps: TrajectoryStep[]): number[] {
    // Critical path = successful tool calls that advanced the task
    return steps
      .filter(s => s.type === 'tool_call' && s.toolCall?.success)
      .map(s => s.index);
  }

  private inferIntent(steps: TrajectoryStep[]): string {
    const toolCalls = steps.filter(s => s.type === 'tool_call' && s.toolCall);
    if (toolCalls.length === 0) return 'No tool calls detected';

    const toolNames = [...new Set(toolCalls.map(s => s.toolCall!.name))];
    return `Agent used ${toolCalls.length} tool call(s) across ${toolNames.length} unique tool(s): ${toolNames.slice(0, 5).join(', ')}`;
  }

  private inferOutcome(steps: TrajectoryStep[]): 'success' | 'partial' | 'failure' {
    const errors = steps.filter(s => s.type === 'error');
    const toolCalls = steps.filter(s => s.type === 'tool_call' && s.toolCall);
    const successes = toolCalls.filter(s => s.toolCall!.success);

    if (toolCalls.length === 0) return 'failure';
    if (errors.length === 0 && successes.length === toolCalls.length) return 'success';
    if (successes.length > 0) return 'partial';
    return 'failure';
  }

  private toTimestamp(ts: string): number {
    const num = Number(ts);
    if (!isNaN(num)) return num;
    const parsed = Date.parse(ts);
    return isNaN(parsed) ? Date.now() : parsed;
  }
}
