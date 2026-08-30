import type { StructuredReplay } from '../../shared/contract/evaluation';
import { buildSessionTraceIdentity } from '../../shared/contract/reviewQueue';
import { createLogger } from '../services/infra/logger';
import { evaluateAgentTrajectoryReplay } from '../../shared/contract/agentTrajectory';
import type { TestCase, TestResult } from './types';
import { isRealAgentRunCase } from './testRunCompletion';

const logger = createLogger('TestRunnerTelemetryReplay');

interface ReplayAgent {
  finalizeSession?(): Promise<void>;
  getStructuredReplay?(sessionId: string): Promise<StructuredReplay | null>;
}

export async function attachTelemetryReplay(
  testCase: TestCase,
  result: TestResult,
  agent: ReplayAgent,
): Promise<void> {
  const requiresRealAgentRun = isRealAgentRunCase(testCase);
  if (result.sessionId) result.replayKey = buildSessionTraceIdentity(result.sessionId).replayKey;
  await agent.finalizeSession?.();

  let replay: StructuredReplay | null = null;
  if (result.sessionId) {
    try {
      if (agent.getStructuredReplay) {
        replay = await agent.getStructuredReplay(result.sessionId);
      } else {
        const { getTelemetryQueryService } = await import('../telemetry/replay/telemetryQueryService');
        replay = await getTelemetryQueryService().getStructuredReplay(result.sessionId);
      }
      if (replay) {
        result.replayKey = replay.traceIdentity.replayKey;
        result.telemetryCompleteness = replay.summary.telemetryCompleteness;
      }
    } catch (error) {
      logger.warn('Failed to attach structured replay telemetry', {
        testId: testCase.id,
        sessionId: result.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!requiresRealAgentRun) return;
  const gate = evaluateAgentTrajectoryReplay(replay);
  const failures = gate.exportReady ? [] : gate.failures;
  result.telemetryGate = { name: 'real-agent-run', passed: failures.length === 0, failures };
  if (failures.length === 0) return;

  const gateReason = `real-agent-run gate failed: ${failures.join(', ')}`;
  result.status = 'failed';
  result.score = 0;
  result.failureStage = 'telemetry_replay_gate';
  result.failureReason = result.failureReason ? `${result.failureReason}; ${gateReason}` : gateReason;
  result.errors.push(gateReason);
}

export function appendTimeoutTelemetryFailureReason(result: TestResult): void {
  const telemetry = result.telemetryCompleteness;
  if (!telemetry) return;
  const progress = `执行至第 ${telemetry.turnCount} 轮，已记录 ${telemetry.toolCallCount} 次工具调用、${telemetry.modelCallCount} 次模型调用`;
  result.failureReason = result.failureReason ? `${result.failureReason}; ${progress}` : progress;
}
