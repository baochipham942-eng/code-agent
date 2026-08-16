import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { ToolLedgerOrigin } from '../../shared/constants/toolLedger';
import type { ToolEmissionDescriptor } from '../../shared/contract';
import { getToolLedgerSink } from './toolLedgerSink';
import { redactSecrets } from '../security/secretRedaction';
import { sanitizeToolParams } from './toolExecutorHelpers';
import { isRunPathInsideWorkspace, resolveCanonicalRunPath } from '../runtime/runContext';
import { TurnTraceRecorder } from '../agent/runtime/turnTrace';

const fallbackTraces = new Map<string, TurnTraceRecorder>();

function stringifyTarget(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolveEmissionTarget(input: {
  emission: ToolEmissionDescriptor;
  params: Record<string, unknown>;
  workingDirectory: string;
  workspace: string;
}): string | null {
  if (input.emission.kind === 'external_file_write') {
    const rawTarget = input.params[input.emission.targetParameter];
    if (typeof rawTarget !== 'string' || rawTarget.trim().length === 0) return null;
    const expanded = rawTarget === '~'
      ? os.homedir()
      : rawTarget.startsWith('~/')
        ? path.join(os.homedir(), rawTarget.slice(2))
        : rawTarget;
    const absoluteTarget = resolveCanonicalRunPath(
      path.isAbsolute(expanded) ? expanded : path.resolve(input.workingDirectory, expanded),
    );
    const workspace = resolveCanonicalRunPath(input.workspace);
    return isRunPathInsideWorkspace(absoluteTarget, workspace) ? null : absoluteTarget;
  }

  const parts = input.emission.targetParameters.map((parameter) => (
    `${parameter}=${stringifyTarget(input.params[parameter])}`
  ));
  return parts.join('; ');
}

function registerCompensation(input: {
  executionId: string;
  toolName: string;
  sessionId?: string;
  params: Record<string, unknown>;
  emission?: ToolEmissionDescriptor;
  workingDirectory: string;
  workspace: string;
  turnTrace?: TurnTraceRecorder;
}): void {
  if (!input.emission || !input.sessionId) return;
  try {
    const target = resolveEmissionTarget({
      emission: input.emission,
      params: input.params,
      workingDirectory: input.workingDirectory,
      workspace: input.workspace,
    });
    if (!target) return;
    let trace = input.turnTrace;
    if (!trace) {
      trace = fallbackTraces.get(input.sessionId);
      if (!trace) {
        trace = new TurnTraceRecorder(input.sessionId);
        fallbackTraces.set(input.sessionId, trace);
      }
    }
    const order = trace.getEvents().reduce((maximum, event) => (
      event.type === 'compensation_registered'
        ? Math.max(maximum, event.data.order)
        : maximum
    ), 0) + 1;
    trace.record('compensation_registered', {
      compensationId: randomUUID(),
      executionId: input.executionId,
      toolName: input.toolName,
      action: input.emission.compensationAction,
      target,
      order,
      sufficiency: 'unreviewed',
    });
    trace.flush();
  } catch {
    // Compensation registration is a fail-safe side ledger.
  }
}

export function createToolExecutionLedger(input: {
  toolName: string;
  sessionId?: string;
  params: Record<string, unknown>;
  startedAt: number;
  origin: ToolLedgerOrigin;
  emission?: ToolEmissionDescriptor;
  workingDirectory: string;
  workspace: string;
  turnTrace?: TurnTraceRecorder;
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
      if (status === 'success') {
        registerCompensation({
          executionId,
          toolName: input.toolName,
          sessionId: input.sessionId,
          params: input.params,
          emission: input.emission,
          workingDirectory: input.workingDirectory,
          workspace: input.workspace,
          turnTrace: input.turnTrace,
        });
      }
    },
  };
}
