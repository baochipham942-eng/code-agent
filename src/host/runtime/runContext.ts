import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import type { MessageAttachment, MessageMetadata } from '../../shared/contract';
import type { RunTraceContext } from '../telemetry/runTraceContext';

export interface RunContext {
  readonly runId: string;
  readonly sessionId: string;
  /** Authorization, persistence, and artifact boundary for this run. */
  readonly workspace: string;
  /** Default process and relative-path directory for this run. */
  readonly cwd: string;
  readonly createdAt: number;
}

export interface CreateRunContextInput {
  runId?: string;
  sessionId: string;
  workspace: string;
  cwd?: string;
  createdAt?: number;
}

export type RunCancelReason = 'user' | 'session-switch';

export interface RunControlTarget {
  cancel(reason?: RunCancelReason): void | Promise<void>;
  pause?(): void | Promise<void>;
  resume?(): void | Promise<void>;
  steer?(
    newMessage: string,
    clientMessageId?: string,
    attachments?: MessageAttachment[],
    metadata?: MessageMetadata,
  ): void | Promise<void>;
}

export interface RunHandle extends RunControlTarget {
  readonly context: RunContext;
  readonly traceContext?: RunTraceContext;
  readonly isAttached: boolean;
  readonly cancellationRequested: boolean;
  cancel(reason?: RunCancelReason): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  steer(
    newMessage: string,
    clientMessageId?: string,
    attachments?: MessageAttachment[],
    metadata?: MessageMetadata,
  ): Promise<void>;
  attach(target: RunControlTarget): Promise<void>;
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

/** Resolve symlink ancestors while preserving not-yet-created suffixes. */
export function resolveCanonicalRunPath(input: string, symlinkDepth = 0): string {
  const resolved = path.resolve(input);
  if (symlinkDepth > 40) {
    throw new Error(`Run path exceeds the symlink resolution limit: ${resolved}`);
  }

  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let cursor = root;

  for (let index = 0; index < parts.length; index += 1) {
    const next = path.join(cursor, parts[index]);
    try {
      const stat = lstatSync(next);
      if (stat.isSymbolicLink()) {
        const linkTarget = path.resolve(path.dirname(next), readlinkSync(next));
        return resolveCanonicalRunPath(
          path.resolve(linkTarget, ...parts.slice(index + 1)),
          symlinkDepth + 1,
        );
      }
      cursor = next;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : undefined;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }
      try {
        return path.resolve(realpathSync.native(cursor), ...parts.slice(index));
      } catch (realpathError) {
        const realpathCode = realpathError
          && typeof realpathError === 'object'
          && 'code' in realpathError
          ? String(realpathError.code)
          : undefined;
        if (realpathCode !== 'ENOENT' && realpathCode !== 'ENOTDIR') {
          throw realpathError;
        }
        return path.resolve(cursor, ...parts.slice(index));
      }
    }
  }

  return realpathSync.native(cursor);
}

export function isRunPathInsideWorkspace(candidate: string, workspace: string): boolean {
  try {
    const canonicalCandidate = resolveCanonicalRunPath(candidate);
    const canonicalWorkspace = resolveCanonicalRunPath(workspace);
    const relative = path.relative(canonicalWorkspace, canonicalCandidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

export function createRunContext(input: CreateRunContextInput): RunContext {
  const runId = requireIdentifier(input.runId ?? `run-${randomUUID()}`, 'runId');
  const sessionId = requireIdentifier(input.sessionId, 'sessionId');
  if (runId === sessionId) {
    throw new Error('runId must be distinct from sessionId');
  }
  // Freeze the resolved filesystem targets, not caller-provided symlink text.
  // Otherwise a workspace symlink could be retargeted while a run is active and
  // silently move every downstream policy/artifact/resolver boundary.
  const workspace = resolveCanonicalRunPath(
    requireIdentifier(input.workspace, 'workspace'),
  );
  const cwd = resolveCanonicalRunPath(input.cwd?.trim() || workspace);
  if (!isRunPathInsideWorkspace(cwd, workspace)) {
    throw new Error(`Run cwd must stay inside workspace: ${cwd}`);
  }

  return Object.freeze({
    runId,
    sessionId,
    workspace,
    cwd,
    createdAt: input.createdAt ?? Date.now(),
  });
}

class AttachedRunHandle implements RunHandle {
  private target: RunControlTarget | null = null;
  private cancelRequested = false;
  private cancelReason: RunCancelReason | undefined;
  private cancellationPromise: Promise<void> | null = null;

  constructor(
    readonly context: RunContext,
    readonly traceContext?: RunTraceContext,
  ) {}

  get isAttached(): boolean {
    return this.target !== null;
  }

  get cancellationRequested(): boolean {
    return this.cancelRequested;
  }

  async attach(target: RunControlTarget): Promise<void> {
    if (this.target && this.target !== target) {
      throw new Error(`Run ${this.context.runId} already has an attached target`);
    }
    this.target = target;
    if (this.cancelRequested) {
      await this.deliverCancellation();
    }
  }

  cancel(reason?: RunCancelReason): Promise<void> {
    if (!this.cancelRequested) {
      this.cancelRequested = true;
      this.cancelReason = reason;
    }
    return this.deliverCancellation();
  }

  async pause(): Promise<void> {
    const target = this.requireAttachedTarget('pause');
    if (typeof target.pause !== 'function') {
      throw new Error(`Run ${this.context.runId} does not support pause`);
    }
    await target.pause();
  }

  async resume(): Promise<void> {
    const target = this.requireAttachedTarget('resume');
    if (typeof target.resume !== 'function') {
      throw new Error(`Run ${this.context.runId} does not support resume`);
    }
    await target.resume();
  }

  async steer(
    newMessage: string,
    clientMessageId?: string,
    attachments?: MessageAttachment[],
    metadata?: MessageMetadata,
  ): Promise<void> {
    const target = this.requireAttachedTarget('steer');
    if (typeof target.steer !== 'function') {
      throw new Error(`Run ${this.context.runId} does not support steer`);
    }
    await target.steer(newMessage, clientMessageId, attachments, metadata);
  }

  private deliverCancellation(): Promise<void> {
    if (!this.target) {
      return Promise.resolve();
    }
    // Re-dispatch on every cancel request. The previous single-flight cache swallowed
    // later stops after the first delivery resolved — if that first cancel was a no-op
    // (controller not armed yet), every subsequent stop stayed dead forever.
    // Targets are expected to treat cancel as idempotent; deliveries are serialized.
    const previous = this.cancellationPromise ?? Promise.resolve();
    const next = previous.then(
      () => Promise.resolve(this.target!.cancel(this.cancelReason)),
      () => Promise.resolve(this.target!.cancel(this.cancelReason)),
    );
    this.cancellationPromise = next;
    return next;
  }

  private requireAttachedTarget(action: string): RunControlTarget {
    if (this.cancelRequested) {
      throw new Error(`Run ${this.context.runId} cannot ${action} after cancellation`);
    }
    if (!this.target) {
      throw new Error(`Run ${this.context.runId} cannot ${action} before its target is attached`);
    }
    return this.target;
  }
}

export function createRunHandle(context: RunContext, traceContext?: RunTraceContext): RunHandle {
  return new AttachedRunHandle(context, traceContext);
}
