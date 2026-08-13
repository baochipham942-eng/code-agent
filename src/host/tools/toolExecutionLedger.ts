import { randomUUID } from 'node:crypto';
import type { ToolLedgerOrigin } from '../../shared/constants/toolLedger';
import { getToolLedgerSink } from './toolLedgerSink';
import { redactSecrets } from '../security/secretRedaction';
import { sanitizeToolParams } from './toolExecutorHelpers';

export function createToolExecutionLedger(input: {
  toolName: string;
  sessionId?: string;
  params: Record<string, unknown>;
  startedAt: number;
  origin: ToolLedgerOrigin;
}) {
  const executionId = randomUUID();
  const params = sanitizeToolParams(input.params);
  const summary = String(
    params.command
    || params.file_path
    || params.path
    || params.pattern
    || input.toolName,
  ).substring(0, 80);
  let completed = false;

  return {
    executionId,
    begin(): void {
      try {
        getToolLedgerSink().appendToolExecutionBegin({
          executionId,
          sessionId: input.sessionId,
          toolName: input.toolName,
          summary,
          params,
          recordedAt: input.startedAt,
          origin: input.origin,
        });
      } catch {
        // The recovery ledger is fail-safe and never blocks tool execution.
      }
    },
    complete(status: string, error?: string): void {
      if (completed) return;
      completed = true;
      try {
        getToolLedgerSink().appendToolExecutionComplete({
          executionId,
          toolName: input.toolName,
          status,
          error: error ? redactSecrets(error) : undefined,
          sessionId: input.sessionId,
          recordedAt: Date.now(),
          origin: input.origin,
        });
      } catch {
        // The recovery ledger is fail-safe and never blocks tool execution.
      }
    },
  };
}
