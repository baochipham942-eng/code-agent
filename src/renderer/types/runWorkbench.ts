import type { PermissionLevel } from '@shared/contract/tool';
import type { LongTaskUiStatus } from '@shared/contract/productClosure';

export type RunUiStatus =
  | 'planning'
  | 'running'
  | 'waiting_approval'
  | 'using_tools'
  | 'verifying'
  | 'completed'
  | 'blocked'
  | 'cancelled';

export interface RunIdentity {
  sessionId: string | null;
  turnId: string | null;
  runId: string | null;
  streamRunId: string | null;
  parentRunId?: string | null;
  agentId?: string | null;
  status: RunUiStatus;
}

export interface RunUiState {
  identity: RunIdentity;
  status: RunUiStatus;
  phase: string;
  activeToolName?: string;
  waitingApprovalId?: string;
  blockedReason?: string;
  completionSignal?: string;
}

export interface LoopDecisionView {
  runId: string | null;
  step: number;
  action: string;
  reason: string;
  expectedNextAction?: string;
  blockedReason?: string;
}

export type ToolCapabilitySource =
  | 'builtin'
  | 'mcp'
  | 'skill'
  | 'connector'
  | 'computer'
  | 'memory'
  | 'unknown';

export interface ToolCapabilityView {
  id: string;
  label: string;
  source: ToolCapabilitySource;
  callable: boolean;
  permissionLevel?: PermissionLevel | 'unknown';
  blockedReason?: string;
  activatedForTurn: boolean;
}

export interface TaskRecord {
  id: string;
  scope: 'session' | 'global' | 'scheduled';
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';
  steps: Array<{
    title: string;
    status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';
    blockedByTitles?: string[];
    blockedTaskTitles?: string[];
  }>;
  ownerRunId?: string | null;
  sourceThreadId?: string | null;
  resumeHint?: string;
  outputRefs?: TaskRecordOutputRef[];
}

export interface TaskRecordOutputRef {
  id: string;
  type: string;
  label: string;
  pathOrUrl?: string;
  size?: number;
}

export interface SubagentRunView {
  id: string;
  parentRunId: string | null;
  role: string;
  model?: string;
  status: LongTaskUiStatus;
  inputSummary: string;
  lastOutput: string;
  resultSummary?: string;
  handoff?: string;
}

export interface MemoryActivityEvent {
  runId: string | null;
  action: 'used' | 'created' | 'updated' | 'deleted';
  memoryId: string;
  filename?: string;
  title: string;
  reason: string;
  sourceSessionId?: string;
  targetPath?: string;
  confidence?: number;
}

export interface OutputArtifactView {
  id: string;
  runId: string | null;
  kind: 'file' | 'artifact' | 'link' | 'note';
  title: string;
  pathOrUrl?: string;
  previewState: 'available' | 'missing' | 'unknown';
  provenance: string;
}

export interface RunWorkbenchModel {
  run: RunUiState;
  loopDecisions: LoopDecisionView[];
  tools: ToolCapabilityView[];
  tasks: TaskRecord[];
  subagents: SubagentRunView[];
  memoryActivities: MemoryActivityEvent[];
  outputs: OutputArtifactView[];
}
