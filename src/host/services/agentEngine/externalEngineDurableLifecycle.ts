import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import type {
  AgentEnginePermissionProfile,
  AgentEngineRunResult,
  ExternalAgentEngineKind,
} from '../../../shared/contract/agentEngine';
import type { PendingOperation } from '../../../shared/contract/durableRun';
import type { RunRehydrationPlan } from '../../runtime/durableRunStores';
import type { RunHandle } from '../../runtime/runContext';
import { RunRegistry } from '../../runtime/runRegistry';
import { getTelemetryService } from '../../telemetry/telemetryService';

export type ExternalEngineResumeCapability =
  | 'resumable'
  | 'restartable_with_context'
  | 'non_resumable'
  | 'unknown';

export interface ExternalEngineRecoveryDecision {
  engine: ExternalAgentEngineKind;
  capability: ExternalEngineResumeCapability;
  action: 'resume' | 'requires_review' | 'fail' | 'already_terminal';
  reason: string;
  externalSessionId?: string;
}

export const EXTERNAL_ENGINE_RESUME_CAPABILITIES: Readonly<Record<ExternalAgentEngineKind, ExternalEngineResumeCapability>> = Object.freeze({
  codex_cli: 'resumable',
  claude_code: 'resumable',
  mimo_code: 'non_resumable',
  kimi_code: 'unknown',
});

interface ExternalCheckpointState {
  schemaVersion: 1;
  engineKind: 'external_cli';
  engine: ExternalAgentEngineKind;
  cli: { binary: string; version?: string };
  process: { pid?: number; processGroupId?: number; platform: NodeJS.Platform };
  workspace: { cwd: string; root?: string; fingerprint: string };
  commandSummary: string;
  externalSessionId?: string;
  cursors: { stdoutBytes: number; stderrBytes: number; logPath?: string };
  provider?: string;
  model?: string;
  permissionProfile: AgentEnginePermissionProfile;
  lastNormalizedEvent?: { type: string; summary?: string; at: number };
  resumeCapability: ExternalEngineResumeCapability;
  engineCursorSchemaVersion: 1;
}

export interface ExternalProcessMetadata {
  binary: string;
  version?: string;
  commandSummary: string;
  logPath?: string;
  model?: string;
  permissionProfile: AgentEnginePermissionProfile;
}

export interface ExternalEngineRecoveryLaunchContext {
  cwd: string;
  workspace: string;
  permissionProfile: 'read_only';
  model?: string;
}

export class ExternalEngineDurableLifecycle {
  readonly runId: string;
  readonly attempt: number;
  readonly ownerEpoch: number;
  readonly handle: RunHandle;
  private operation: PendingOperation;
  private child: ChildProcess | null = null;
  private processGroupId: number | undefined;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private externalSessionId?: string;
  private lastNormalizedEvent?: ExternalCheckpointState['lastNormalizedEvent'];
  private metadata?: ExternalProcessMetadata;
  private checkpointQueue: Promise<void> = Promise.resolve();
  private terminal = false;
  private externalSpanId?: string;

  private constructor(
    private readonly registry: RunRegistry,
    readonly engine: ExternalAgentEngineKind,
    readonly sessionId: string,
    readonly cwd: string,
    private readonly workspaceRoot: string,
    started: { handle: RunHandle; launchOperation: PendingOperation },
    externalSessionId?: string,
    recoveredAttempt?: number,
    recoveredOwnerEpoch?: number,
  ) {
    this.handle = started.handle;
    this.runId = started.handle.context.runId;
    this.attempt = recoveredAttempt ?? started.launchOperation.attempt;
    this.ownerEpoch = recoveredOwnerEpoch ?? started.handle.traceContext?.ownerEpoch ?? 0;
    this.operation = started.launchOperation;
    this.externalSessionId = externalSessionId;
  }

  static async start(input: {
    registry: RunRegistry;
    engine: ExternalAgentEngineKind;
    sessionId: string;
    workspace: string;
    cwd: string;
    externalSessionId?: string;
  }): Promise<ExternalEngineDurableLifecycle> {
    const started = await input.registry.startExternalDurable({
      sessionId: input.sessionId,
      workspace: input.workspace,
      cwd: input.cwd,
      engine: input.engine,
      externalSessionId: input.externalSessionId,
      resumeCapable: EXTERNAL_ENGINE_RESUME_CAPABILITIES[input.engine] === 'resumable',
    });
    return new ExternalEngineDurableLifecycle(
      input.registry,
      input.engine,
      input.sessionId,
      input.cwd,
      input.workspace,
      started,
      input.externalSessionId,
    );
  }

  static rehydrate(input: {
    registry: RunRegistry;
    plan: RunRehydrationPlan;
    context: ExternalEngineRecoveryLaunchContext;
    externalSessionId: string;
  }): ExternalEngineDurableLifecycle {
    if (input.plan.envelope.engine.kind !== 'external_cli' || !input.plan.envelope.owner) {
      throw new Error('External recovery lifecycle requires a claimed external_cli plan');
    }
    const launchOperation = input.plan.pendingOperations.find((operation) => operation.kind === 'external_engine');
    if (!launchOperation) throw new Error('External recovery lifecycle has no durable launch operation');
    const handle = input.registry.bindRecoveredHandle(input.plan, input.context.workspace, input.context.cwd);
    return new ExternalEngineDurableLifecycle(
      input.registry,
      input.plan.envelope.engine.engine,
      input.plan.envelope.sessionId,
      input.context.cwd,
      input.context.workspace,
      {
        handle,
        launchOperation: {
          ...launchOperation,
          attempt: input.plan.envelope.attempt,
          updatedAt: input.plan.envelope.updatedAt,
        },
      },
      input.externalSessionId,
      input.plan.envelope.attempt,
      input.plan.envelope.owner.epoch,
    );
  }

  async attachProcess(child: ChildProcess, metadata: ExternalProcessMetadata): Promise<void> {
    this.child = child;
    this.metadata = { ...metadata, commandSummary: redactCommandSummary(metadata.commandSummary) };
    this.processGroupId = process.platform === 'win32' ? undefined : child.pid;
    this.operation = {
      ...this.operation,
      status: 'dispatched',
      updatedAt: Date.now(),
    };
    await this.handle.attach({ cancel: () => this.cancelProcess() });
    this.startExternalSpan();
    await this.enqueueCheckpoint('external_process_started');
  }

  observeStdout(bytes: number): void {
    this.stdoutBytes += Math.max(0, bytes);
    this.addTraceEvent('stdout.event', { bytes: Math.max(0, bytes) });
  }

  observeStderr(bytes: number): void {
    this.stderrBytes += Math.max(0, bytes);
  }

  observeNormalizedEvent(type: string, summary?: string): void {
    this.lastNormalizedEvent = {
      type: sanitizeSummary(type, 80),
      ...(summary ? { summary: sanitizeSummary(summary, 160) } : {}),
      at: Date.now(),
    };
    this.addTraceEvent(type === 'tool_call' ? 'tool.summary' : 'stdout.normalized', {
      type: sanitizeSummary(type, 80),
      ...(summary ? { summary: sanitizeSummary(summary, 160) } : {}),
    });
  }

  observeModelUsage(inputTokens?: number, outputTokens?: number): void {
    this.addTraceEvent('model.usage', {
      ...(Number.isFinite(inputTokens) ? { input_tokens: Math.max(0, inputTokens ?? 0) } : {}),
      ...(Number.isFinite(outputTokens) ? { output_tokens: Math.max(0, outputTokens ?? 0) } : {}),
    });
  }

  persistExternalSessionId(externalSessionId: string): void {
    const normalized = externalSessionId.trim();
    if (!normalized || normalized === this.externalSessionId) return;
    this.externalSessionId = normalized;
    if (EXTERNAL_ENGINE_RESUME_CAPABILITIES[this.engine] === 'resumable') {
      this.operation = {
        ...this.operation,
        providerOperationId: `external-session:${normalized}`,
        requiresHumanConfirmation: false,
        updatedAt: Date.now(),
      };
    }
    void this.enqueueCheckpoint('external_session_identified');
  }

  async finish(result: AgentEngineRunResult, terminalEvidence: boolean): Promise<void> {
    if (this.terminal) return;
    const cancellation = this.handle.cancellationRequested || result.status === 'cancelled';
    const honestStatus = cancellation
      ? 'cancelled'
      : result.status === 'completed' && terminalEvidence
        ? 'completed'
        : 'failed';
    this.operation = {
      ...this.operation,
      status: honestStatus === 'completed' ? 'succeeded' : honestStatus === 'cancelled' ? 'abandoned' : 'failed',
      resultRef: result.logPath ? `log:${createHash('sha256').update(result.logPath).digest('hex').slice(0, 16)}` : undefined,
      updatedAt: Date.now(),
    };
    this.lastNormalizedEvent = {
      type: `terminal_${honestStatus}`,
      summary: terminalEvidence ? 'parsed_terminal_evidence' : 'terminal_evidence_missing',
      at: Date.now(),
    };
    await this.enqueueCheckpoint('external_terminal_evidence');
    await this.checkpointQueue;
    await this.registry.terminalDurable(this.runId, {
      now: Date.now(),
      status: honestStatus,
      reason: terminalEvidence ? result.error : 'external_process_exited_without_terminal_evidence',
      event: {
        type: `external_engine_${honestStatus}`,
        payload: { engine: this.engine, exitCode: result.exitCode, terminalEvidence },
        recordedAt: Date.now(),
      },
    }, this.handle);
    this.endExternalSpan(honestStatus);
    this.terminal = true;
  }

  async release(): Promise<void> {
    if (this.terminal) return;
    await this.registry.releaseDurable(this.runId, this.handle);
    this.endExternalSpan('cancelled');
  }

  async terminateProcess(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const child = this.child;
    if (child?.exitCode !== null) return;
    try {
      if (this.processGroupId && process.platform !== 'win32') {
        process.kill(-this.processGroupId, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      child.kill(signal);
    }
  }

  private enqueueCheckpoint(eventType: string): Promise<void> {
    this.checkpointQueue = this.checkpointQueue.then(async () => {
      const now = Date.now();
      await this.registry.checkpointDurable(this.runId, {
        now,
        status: 'running',
        state: this.buildCheckpointState(),
        engineCursor: {
          schemaVersion: 1,
          engine: this.engine,
          externalSessionId: this.externalSessionId,
          stdoutBytes: this.stdoutBytes,
          stderrBytes: this.stderrBytes,
        },
        pendingOperations: [this.operation],
        events: [{
          type: eventType,
          payload: {
            engine: this.engine,
            externalSessionId: this.externalSessionId,
            lastNormalizedEvent: this.lastNormalizedEvent?.type,
          },
          recordedAt: now,
        }],
      });
    });
    return this.checkpointQueue;
  }

  private buildCheckpointState(): ExternalCheckpointState {
    const metadata = this.metadata;
    return {
      schemaVersion: 1,
      engineKind: 'external_cli',
      engine: this.engine,
      cli: { binary: metadata?.binary ?? this.engine, version: metadata?.version },
      process: { pid: this.child?.pid, processGroupId: this.processGroupId, platform: process.platform },
      workspace: {
        cwd: this.cwd,
        root: this.workspaceRoot,
        fingerprint: this.handle.traceContext?.workspaceFingerprint ?? 'unknown',
      },
      commandSummary: metadata?.commandSummary ?? '<pending>',
      externalSessionId: this.externalSessionId,
      cursors: { stdoutBytes: this.stdoutBytes, stderrBytes: this.stderrBytes, logPath: metadata?.logPath },
      provider: this.engine,
      model: metadata?.model,
      permissionProfile: metadata?.permissionProfile ?? 'read_only',
      lastNormalizedEvent: this.lastNormalizedEvent,
      resumeCapability: EXTERNAL_ENGINE_RESUME_CAPABILITIES[this.engine],
      engineCursorSchemaVersion: 1,
    };
  }

  private async cancelProcess(): Promise<void> {
    await this.terminateProcess('SIGTERM');
  }

  private startExternalSpan(): void {
    try {
      const span = getTelemetryService().startSpan('external_engine', 'agent', {
        'external.engine': this.engine,
        'external.binary': this.metadata?.binary ?? this.engine,
        'external.pid': this.child?.pid ?? -1,
      }, this.handle.traceContext?.spanId, this.handle.traceContext);
      this.externalSpanId = span.spanId;
    } catch { /* diagnostics cannot change execution */ }
  }

  private addTraceEvent(name: string, attributes: Record<string, string | number>): void {
    if (!this.externalSpanId) return;
    try { getTelemetryService().addSpanEvent(this.externalSpanId, name, attributes); } catch { /* diagnostics only */ }
  }

  private endExternalSpan(status: 'completed' | 'failed' | 'cancelled'): void {
    if (!this.externalSpanId) return;
    try {
      getTelemetryService().endSpan(
        this.externalSpanId,
        status === 'completed' ? 'ok' : status === 'cancelled' ? 'cancelled' : 'error',
        { 'terminal.status': status },
      );
    } catch { /* diagnostics only */ }
    this.externalSpanId = undefined;
  }
}

export function canRecoverExternalEngine(plan: RunRehydrationPlan): boolean {
  return plan.envelope.engine.kind === 'external_cli';
}

export function buildExternalEngineRecoveryDecision(plan: RunRehydrationPlan): ExternalEngineRecoveryDecision {
  if (plan.envelope.engine.kind !== 'external_cli') {
    throw new Error('Recovery plan is not for an external CLI engine');
  }
  if (['completed', 'failed', 'cancelled'].includes(plan.envelope.status)) {
    return { engine: plan.envelope.engine.engine, capability: EXTERNAL_ENGINE_RESUME_CAPABILITIES[plan.envelope.engine.engine], action: 'already_terminal', reason: 'terminal_run' };
  }
  const cursor = readEngineCursor(plan);
  const externalSessionId = cursor.externalSessionId ?? plan.envelope.engine.externalSessionId;
  const capability = EXTERNAL_ENGINE_RESUME_CAPABILITIES[plan.envelope.engine.engine];
  if (capability === 'resumable' && externalSessionId) {
    return { engine: plan.envelope.engine.engine, capability, action: 'resume', reason: 'stable_external_session_id', externalSessionId };
  }
  if (capability === 'non_resumable') {
    return { engine: plan.envelope.engine.engine, capability, action: 'requires_review', reason: 'engine_has_no_safe_resume' };
  }
  return { engine: plan.envelope.engine.engine, capability, action: 'requires_review', reason: 'resume_evidence_incomplete', externalSessionId };
}

export async function resumeExternalEngine(
  plan: RunRehydrationPlan,
  deps: { resume: (decision: ExternalEngineRecoveryDecision, plan: RunRehydrationPlan) => Promise<AgentEngineRunResult> },
): Promise<AgentEngineRunResult | ExternalEngineRecoveryDecision> {
  const decision = buildExternalEngineRecoveryDecision(plan);
  if (decision.action !== 'resume') return decision;
  const result = await deps.resume(decision, plan);
  if (result.runId !== plan.envelope.runId || result.sessionId !== plan.envelope.sessionId) {
    throw new Error('External engine recovery must preserve logical runId and sessionId');
  }
  return result;
}

function readEngineCursor(plan: RunRehydrationPlan): { externalSessionId?: string } {
  const value = plan.checkpoint?.cursor.engineCursor ?? plan.envelope.cursor.engineCursor;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const externalSessionId = (value as Record<string, unknown>).externalSessionId;
  return typeof externalSessionId === 'string' && externalSessionId.trim()
    ? { externalSessionId: externalSessionId.trim() }
    : {};
}

export function readExternalEngineRecoveryLaunchContext(
  plan: RunRehydrationPlan,
): ExternalEngineRecoveryLaunchContext | null {
  const state = plan.checkpoint?.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const value = state as Partial<ExternalCheckpointState>;
  if (value.schemaVersion !== 1 || value.engineKind !== 'external_cli') return null;
  const cwd = value.workspace?.cwd?.trim();
  if (!cwd || value.permissionProfile !== 'read_only') return null;
  return {
    cwd,
    workspace: value.workspace?.root?.trim() || cwd,
    permissionProfile: 'read_only',
    ...(value.model?.trim() ? { model: value.model.trim() } : {}),
  };
}

export function redactCommandSummary(summary: string): string {
  return summary
    .replace(/(--?(?:api[-_]?key|token|authorization|cookie|password|secret)(?:=|\s+))\S+/gi, '$1<redacted>')
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9._-]{8,}\b/g, '<redacted>')
    .replace(/(["']?)(?:prompt|instruction)\1\s*[:=]\s*\S+/gi, 'prompt=<redacted>')
    .slice(0, 1_000);
}

export function extractExternalModelUsage(line: string): { inputTokens?: number; outputTokens?: number } | undefined {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return undefined; }
  const queue: unknown[] = [value];
  let visited = 0;
  while (queue.length > 0 && visited < 64) {
    const current = queue.shift();
    visited += 1;
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 16) as unknown[]) queue.push(item);
      continue;
    }
    const record = current as Record<string, unknown>;
    const inputTokens = firstFiniteNumber(record.input_tokens, record.inputTokens, record.prompt_tokens, record.promptTokens);
    const outputTokens = firstFiniteNumber(record.output_tokens, record.outputTokens, record.completion_tokens, record.completionTokens);
    if (inputTokens !== undefined || outputTokens !== undefined) return { inputTokens, outputTokens };
    queue.push(...Object.values(record).slice(0, 24));
  }
  return undefined;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function sanitizeSummary(value: string, limit: number): string {
  return redactCommandSummary(value.replace(/[\r\n]+/g, ' ')).slice(0, limit);
}
