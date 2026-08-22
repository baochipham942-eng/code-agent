import path from 'node:path';
import type { AgentEvent } from '../../shared/contract';
import type { TurnDiffFileChange } from '../../shared/contract/turnDiff';
import {
  captureTurnDiff,
  captureWorkspaceMutationSnapshot,
  listWorkspacePathsChangedSince,
  type WorkspaceMutationSnapshot,
} from '../services/checkpoint/turnDiffService';
import {
  getModifiedFilePath,
  isFileMutationTool,
} from './runtime/toolArtifactRepairPolicy';
import { isWorkspaceDiscoveryMutationTool } from './runtime/toolFileMutationTracking';
import {
  TurnTraceRecorder,
  type TraceEvent,
} from './runtime/turnTrace';
import {
  createSubagentEventScope,
  type SubagentEventIdentity,
  type SubagentRunEndStatus,
} from './subagentLifecycleEvents';
import type { SubagentEventPort } from './subagentExecutorTypes';

export type { SubagentRunEndStatus } from './subagentLifecycleEvents';

function traceSlotSegment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function getSubagentTraceFileKey(
  sessionId: string,
  identity: Pick<SubagentEventIdentity, 'agentId' | 'runId'>,
): string {
  return path.join(
    'subagents',
    traceSlotSegment(sessionId),
    traceSlotSegment(identity.agentId),
    traceSlotSegment(identity.runId),
  );
}

export function createSubagentTurnTraceRecorder(input: {
  sessionId: string;
  identity: SubagentEventIdentity;
  traceDir?: string;
}): TurnTraceRecorder {
  return new TurnTraceRecorder(
    input.sessionId,
    input.traceDir,
    getSubagentTraceFileKey(input.sessionId, input.identity),
  );
}

export async function emitSubagentTurnDiff(input: {
  events: SubagentEventPort;
  identity: SubagentEventIdentity;
  workingDirectory: string;
  turnId: string;
  modifiedPaths: Iterable<string>;
}): Promise<boolean> {
  const modifiedPaths = [...input.modifiedPaths];
  if (modifiedPaths.length === 0) return false;
  const turnDiff = await captureTurnDiff(
    input.workingDirectory,
    input.turnId,
    modifiedPaths,
  );
  if (!turnDiff || turnDiff.files.length === 0) return false;
  input.events.emit('turn_diff', {
    ...turnDiff,
    ...input.identity,
  });
  return true;
}

export async function recordSubagentMutationPaths(input: {
  toolCall: { name: string; arguments: Record<string, unknown> };
  success: boolean;
  workingDirectory: string;
  modifiedPaths: Set<string>;
  workspaceMutationSnapshot?: WorkspaceMutationSnapshot;
}): Promise<void> {
  if (!input.success) return;
  if (isFileMutationTool(input.toolCall.name)) {
    const filePath = getModifiedFilePath(input.toolCall);
    if (filePath) input.modifiedPaths.add(filePath);
  }
  if (
    input.workspaceMutationSnapshot
    && isWorkspaceDiscoveryMutationTool(input.toolCall.name)
  ) {
    const changedPaths = await listWorkspacePathsChangedSince(
      input.workingDirectory,
      input.workspaceMutationSnapshot,
    );
    changedPaths.forEach((filePath) => input.modifiedPaths.add(filePath));
  }
}

export function createSubagentMutationPathSlot(): Set<string> {
  return new Set<string>();
}

export function createSubagentTurnObservability(input: {
  sessionId: string;
  identity: SubagentEventIdentity;
  events: SubagentEventPort;
  workingDirectory: string;
  warn: (message: string, error: unknown) => void;
}) {
  const eventScope = createSubagentEventScope({ events: input.events, identity: input.identity });
  const recorder = createSubagentTurnTraceRecorder({ sessionId: input.sessionId, identity: eventScope.identity });
  let mutationPaths = createSubagentMutationPathSlot();
  return {
    identity: eventScope.identity,
    startTurn(iteration: number): string {
      mutationPaths = createSubagentMutationPathSlot();
      recorder.setTurn(iteration);
      return eventScope.startTurn(iteration);
    },
    recordCompaction(totalTokens: number): void {
      recorder.record('compaction', {
        layersTriggered: ['subagent_compaction'], totalTokens, commitCount: 1, autocompactNeeded: true,
      });
    },
    async beginTool(toolName: string): Promise<WorkspaceMutationSnapshot | undefined> {
      return isWorkspaceDiscoveryMutationTool(toolName)
        ? captureWorkspaceMutationSnapshot(input.workingDirectory)
        : undefined;
    },
    emitToolCallStart: eventScope.emitToolCallStart,
    async recordToolResult(
      toolCall: { id: string; name: string; arguments: Record<string, unknown> },
      result: { success: boolean; error?: string; output?: string; fromCache?: boolean },
      durationMs: number,
      workspaceMutationSnapshot?: WorkspaceMutationSnapshot,
    ): Promise<void> {
      recorder.record('tool_dispatch', {
        toolName: toolCall.name,
        success: result.success,
        durationMs,
        error: result.error ?? null,
        fromCache: result.fromCache ?? false,
      });
      await recordSubagentMutationPaths({
        toolCall,
        success: result.success,
        workingDirectory: input.workingDirectory,
        modifiedPaths: mutationPaths,
        workspaceMutationSnapshot,
      });
      eventScope.emitToolCallEnd(toolCall.id, result, durationMs);
    },
    recordToolError(toolCall: { id: string; name: string }, error: string, durationMs: number): void {
      recorder.record('tool_dispatch', {
        toolName: toolCall.name, success: false, durationMs, error, fromCache: false,
      });
      eventScope.emitToolCallError(toolCall.id, error, durationMs);
    },
    async endTurn(turnId: string): Promise<void> {
      try {
        await emitSubagentTurnDiff({
          events: input.events,
          identity: eventScope.identity,
          workingDirectory: input.workingDirectory,
          turnId,
          modifiedPaths: mutationPaths,
        });
      } catch (error) {
        input.warn('Subagent turn diff capture failed', error);
      }
      recorder.flush();
      eventScope.endTurn(turnId);
    },
    endRun(status: SubagentRunEndStatus, error?: string): void {
      recorder.flush();
      eventScope.endRun(status, error);
    },
  };
}

export interface SubagentTurnReplay {
  turnId: string;
  turnIndex: number;
  tools: Array<{
    toolName: string;
    success: boolean;
    durationMs: number;
    error: string | null;
  }>;
  files: TurnDiffFileChange[];
}

/** Join a run-scoped trace ledger with correlated lifecycle/diff events for delegation replay. */
export function buildSubagentTurnReplay(input: {
  identity: SubagentEventIdentity;
  traceEvents: readonly TraceEvent[];
  agentEvents: readonly AgentEvent[];
}): SubagentTurnReplay[] {
  const belongsToRun = (event: AgentEvent): boolean => {
    const data = event.data;
    return Boolean(
      data
      && typeof data === 'object'
      && 'agentId' in data
      && 'runId' in data
      && data.agentId === input.identity.agentId
      && data.runId === input.identity.runId
      && (
        input.identity.parentToolUseId === undefined
        || ('parentToolUseId' in data && data.parentToolUseId === input.identity.parentToolUseId)
      )
    );
  };
  const runEvents = input.agentEvents.filter(belongsToRun);
  const starts = runEvents.flatMap((event) => (
    event.type === 'turn_start'
      ? [{ turnId: event.data.turnId, turnIndex: event.data.iteration ?? 0 }]
      : []
  ));
  const diffsByTurn = new Map(runEvents.flatMap((event) => (
    event.type === 'turn_diff' ? [[event.data.turnId, event.data.files] as const] : []
  )));

  return starts.map(({ turnId, turnIndex }) => ({
    turnId,
    turnIndex,
    tools: input.traceEvents.flatMap((event) => (
      event.turnIndex === turnIndex && event.type === 'tool_dispatch'
        ? [{
            toolName: event.data.toolName,
            success: event.data.success,
            durationMs: event.data.durationMs,
            error: event.data.error,
          }]
        : []
    )),
    files: diffsByTurn.get(turnId) ?? [],
  }));
}
