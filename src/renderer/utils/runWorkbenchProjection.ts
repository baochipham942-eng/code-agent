import type { TraceProjection, TraceTurn } from '@shared/contract/trace';
import type { TaskProgressData, TodoItem } from '@shared/contract';
import type { TurnTimelineNode } from '@shared/contract/turnTimeline';
import type { ToolResult } from '@shared/contract/tool';
import type {
  LoopDecisionView,
  MemoryActivityEvent,
  OutputArtifactView,
  RunUiState,
  RunUiStatus,
  TaskRecord,
  ToolCapabilityView,
} from '../types/runWorkbench';
import { getToolCapabilitySource } from './toolExecutionPresentation';
import { hasCancelledRunMarker } from './streamingStatePresentation';
import {
  isReadOnlyArtifactOwnershipItem,
  isReadOnlyArtifactTool,
} from './artifactOwnership';

export interface BuildRunWorkbenchModelInput {
  projection: TraceProjection;
  sessionId: string | null;
  sessionStatus?: string | null;
  taskProgress?: TaskProgressData | null;
  todos?: TodoItem[];
  pendingApprovalId?: string | null;
}

function latestTurn(projection: TraceProjection): TraceTurn | null {
  return projection.turns[projection.turns.length - 1] || null;
}

function getTimelineNodes(turn: TraceTurn | null): TurnTimelineNode[] {
  if (!turn) return [];
  return turn.nodes
    .map((node) => node.turnTimeline)
    .filter((node): node is TurnTimelineNode => Boolean(node));
}

function lastToolCall(turn: TraceTurn | null) {
  if (!turn) return null;
  for (let index = turn.nodes.length - 1; index >= 0; index--) {
    const toolCall = turn.nodes[index]?.toolCall;
    if (toolCall) return toolCall;
  }
  return null;
}

function isToolUnfinished(toolCall: ReturnType<typeof lastToolCall>): boolean {
  return Boolean(toolCall && (toolCall._streaming || toolCall.result === undefined));
}

function statusFromInput(args: BuildRunWorkbenchModelInput, turn: TraceTurn | null): RunUiStatus {
  if (args.pendingApprovalId) return 'waiting_approval';
  if (args.sessionStatus === 'cancelling') return 'cancelled';
  if (args.sessionStatus === 'cancelled') return 'cancelled';
  if (args.sessionStatus === 'queued') return 'planning';
  if (args.sessionStatus === 'error') return 'blocked';
  if (turn?.status === 'error') return 'blocked';
  if (turn && hasCancelledRunMarker(turn)) return 'cancelled';

  const timelines = getTimelineNodes(turn);
  if (timelines.some((timeline) => timeline.tone === 'error')) return 'blocked';
  if (args.taskProgress?.phase === 'tool_pending' || args.taskProgress?.phase === 'tool_running') {
    return 'using_tools';
  }

  const toolCall = lastToolCall(turn);
  if (isToolUnfinished(toolCall)) return 'using_tools';
  if (turn?.status === 'streaming' || args.sessionStatus === 'running') return 'running';
  if (args.taskProgress?.phase === 'completed' || turn?.status === 'completed') return 'completed';
  return 'completed';
}

function phaseFromStatus(status: RunUiStatus, taskProgress?: TaskProgressData | null): string {
  if (taskProgress?.step?.trim()) return taskProgress.step.trim();
  if (taskProgress?.tool?.trim()) return `工具 ${taskProgress.tool.trim()}`;

  const labels: Record<RunUiStatus, string> = {
    planning: '规划任务',
    running: '执行中',
    waiting_approval: '等待审批',
    using_tools: '调用工具',
    verifying: '验证结果',
    completed: '已完成',
    blocked: '已阻塞',
    cancelled: '已取消',
  };
  return labels[status];
}

function firstBlockedReason(turn: TraceTurn | null): string | undefined {
  for (const timeline of getTimelineNodes(turn)) {
    if (timeline.tone === 'error' || timeline.tone === 'warning') {
      const blocked = timeline.capabilityScope?.blocked?.[0] || timeline.blockedCapabilities?.[0];
      if (blocked) return blocked.detail || blocked.hint || blocked.code;
      const routingWarning = timeline.routingEvidence?.steps.find((step) => step.tone === 'warning' || step.tone === 'error');
      if (routingWarning) return routingWarning.detail || routingWarning.label;
    }
  }
  return undefined;
}

function completionSignal(turn: TraceTurn | null): string | undefined {
  const artifactCount = getTimelineNodes(turn)
    .find((timeline) => timeline.kind === 'artifact_ownership')
    ?.artifactOwnership?.filter((item) => !isReadOnlyArtifactOwnershipItem(item)).length ?? 0;
  if (artifactCount > 0) return `${artifactCount} 个产物`;
  if (turn?.status === 'completed') return '最终回复已生成';
  return undefined;
}

export function buildRunUiState(args: BuildRunWorkbenchModelInput): RunUiState {
  const turn = latestTurn(args.projection);
  const toolCall = lastToolCall(turn);
  const status = statusFromInput(args, turn);
  const runId = turn?.turnId ?? args.sessionId ?? null;

  return {
    identity: {
      sessionId: args.sessionId,
      turnId: turn?.turnId ?? null,
      runId,
      streamRunId: turn?.status === 'streaming' ? `${runId}:stream` : null,
      status,
    },
    status,
    phase: phaseFromStatus(status, args.taskProgress),
    activeToolName: toolCall?.name,
    waitingApprovalId: args.pendingApprovalId || undefined,
    blockedReason: firstBlockedReason(turn),
    completionSignal: completionSignal(turn),
  };
}

export function buildLoopDecisionViews(projection: TraceProjection): LoopDecisionView[] {
  const turn = latestTurn(projection);
  if (!turn) return [];
  const runId = turn.turnId;
  const decisions: LoopDecisionView[] = [];

  for (const timeline of getTimelineNodes(turn)) {
    if (timeline.kind === 'capability_scope' && timeline.capabilityScope) {
      const scope = timeline.capabilityScope;
      decisions.push({
        runId,
        step: decisions.length + 1,
        action: '能力范围',
        reason: `已选 ${scope.selected.length}，放行 ${scope.allowed.length}，调用 ${scope.invoked.length}`,
        expectedNextAction: scope.blocked.length > 0 ? '处理未生效能力' : '按已放行能力继续',
        blockedReason: scope.blocked[0]?.detail,
      });
    }

    if (timeline.kind === 'routing_evidence' && timeline.routingEvidence) {
      const lastStep = timeline.routingEvidence.steps[timeline.routingEvidence.steps.length - 1];
      decisions.push({
        runId,
        step: decisions.length + 1,
        action: '路由',
        reason: timeline.routingEvidence.summary,
        expectedNextAction: lastStep?.label,
        blockedReason: lastStep?.tone === 'error' || lastStep?.tone === 'warning'
          ? lastStep.detail || lastStep.label
          : undefined,
      });
    }

    if (timeline.kind === 'artifact_ownership' && timeline.artifactOwnership?.length) {
      decisions.push({
        runId,
        step: decisions.length + 1,
        action: '产物归属',
        reason: `本轮产生 ${timeline.artifactOwnership.length} 个输出`,
        expectedNextAction: '等待用户查看或继续迭代',
      });
    }
  }

  for (const node of turn.nodes) {
    if (node.type !== 'tool_call' || !node.toolCall) continue;
    const result = node.toolCall.result;
    decisions.push({
      runId,
      step: decisions.length + 1,
      action: result === undefined || node.toolCall._streaming ? '工具执行中' : '工具完成',
      reason: node.toolCall.shortDescription || node.toolCall.name,
      expectedNextAction: result === undefined ? '等待工具结果' : '汇总工具输出',
      blockedReason: node.toolCall.success === false ? node.toolCall.result : undefined,
    });
  }

  return decisions.slice(-8);
}

export function buildToolCapabilityViews(projection: TraceProjection): ToolCapabilityView[] {
  const turn = latestTurn(projection);
  if (!turn) return [];
  const byId = new Map<string, ToolCapabilityView>();

  for (const timeline of getTimelineNodes(turn)) {
    const scope = timeline.capabilityScope;
    if (!scope) continue;
    for (const item of scope.selected) {
      const blocked = scope.blocked.find((reason) => reason.kind === item.kind && reason.id === item.id);
      byId.set(`${item.kind}:${item.id}`, {
        id: item.id,
        label: item.label,
        source: item.kind,
        callable: !blocked,
        permissionLevel: 'unknown',
        blockedReason: blocked?.detail,
        activatedForTurn: true,
      });
    }
  }

  for (const node of turn.nodes) {
    if (node.type !== 'tool_call' || !node.toolCall) continue;
    const id = `tool:${node.toolCall.name}`;
    const resultFailed = node.toolCall.success === false;
    byId.set(id, {
      id,
      label: node.toolCall.name,
      source: getToolCapabilitySource(node.toolCall.name),
      callable: !resultFailed,
      permissionLevel: 'unknown',
      blockedReason: resultFailed ? node.toolCall.result : undefined,
      activatedForTurn: true,
    });
  }

  return Array.from(byId.values()).slice(-12);
}

type TraceToolCall = NonNullable<TraceTurn['nodes'][number]['toolCall']>;
type MemoryAction = MemoryActivityEvent['action'];

function stringValue(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function numberValue(record: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function booleanValue(record: Record<string, unknown> | undefined, keys: string[]): boolean | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function lastPathSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}

function memoryFilenameFromToolCall(toolCall: TraceToolCall): string | undefined {
  const filename = stringValue(toolCall.args, ['filename'])
    || stringValue(toolCall.metadata, ['filename']);
  const pathLike = filename
    || stringValue(toolCall.args, ['path', 'file_path'])
    || stringValue(toolCall.metadata, ['path', 'filePath']);
  const segment = lastPathSegment(pathLike);
  return segment?.toLowerCase().endsWith('.md') ? segment : undefined;
}

function actionFromText(value: string | undefined): MemoryAction | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower.includes('delete') || lower.includes('forget') || lower.includes('remove')) return 'deleted';
  if (lower.includes('update') || lower.includes('edit') || lower.includes('overwrite')) return 'updated';
  if (lower.includes('write') || lower.includes('store') || lower.includes('add') || lower.includes('create')) return 'created';
  if (lower.includes('read') || lower.includes('search') || lower.includes('recall') || lower.includes('load')) return 'used';
  return null;
}

function isMemoryTool(toolCall: TraceToolCall): boolean {
  const lower = toolCall.name.toLowerCase();
  return lower.includes('memory') || lower.includes('remember') || lower.includes('recall');
}

function memoryActionFromToolCall(toolCall: TraceToolCall): MemoryAction | null {
  if (!isMemoryTool(toolCall)) return null;

  const lowerName = toolCall.name.toLowerCase();
  const explicitAction = stringValue(toolCall.args, ['action', 'operation', 'op']);
  const metadataAction = stringValue(toolCall.metadata, ['action', 'operation', 'op']);
  const action = actionFromText(explicitAction) || actionFromText(metadataAction);

  if (lowerName.includes('memorywrite') || lowerName.includes('memory_write')) {
    if (action === 'deleted') return 'deleted';
    const existed = booleanValue(toolCall.metadata, ['existed', 'alreadyExisted']);
    if (existed === true) return 'updated';
    if (action === 'updated') return 'updated';
    return 'created';
  }

  if (lowerName.includes('memoryread') || lowerName.includes('memory_read')) {
    return 'used';
  }

  if (action) return action;

  const nameAction = actionFromText(toolCall.name);
  if (nameAction) return nameAction;
  return 'used';
}

function summarizeMemoryTitle(toolCall: TraceToolCall): string {
  const title = stringValue(toolCall.args, ['name', 'title', 'filename', 'memoryId', 'id', 'query', 'path', 'file_path'])
    || stringValue(toolCall.metadata, ['name', 'title', 'filename', 'memoryId', 'id', 'path']);
  if (title) return title.slice(0, 80);

  const content = stringValue(toolCall.args, ['description', 'content'])
    || stringValue(toolCall.metadata, ['description', 'summary']);
  if (content) return content.slice(0, 80);

  return 'memory activity';
}

function memoryIdFromToolCall(toolCall: TraceToolCall): string {
  return stringValue(toolCall.args, ['filename', 'memoryId', 'id', 'path', 'file_path'])
    || stringValue(toolCall.metadata, ['filename', 'memoryId', 'id', 'path'])
    || toolCall.id;
}

function memoryReason(toolCall: TraceToolCall, action: MemoryAction): string {
  if (toolCall.shortDescription?.trim()) return toolCall.shortDescription.trim();
  const filename = stringValue(toolCall.args, ['filename'])
    || stringValue(toolCall.metadata, ['filename'])
    || undefined;
  const labels: Record<MemoryAction, string> = {
    used: '读取记忆',
    created: '写入记忆',
    updated: '更新记忆',
    deleted: '删除记忆',
  };
  return filename ? `${labels[action]}: ${filename}` : labels[action];
}

export function buildMemoryActivityEvents(projection: TraceProjection): MemoryActivityEvent[] {
  const turn = latestTurn(projection);
  if (!turn) return [];
  const events: MemoryActivityEvent[] = [];

  for (const node of turn.nodes) {
    if (node.type !== 'tool_call' || !node.toolCall) continue;
    const action = memoryActionFromToolCall(node.toolCall);
    if (!action) continue;
    events.push({
      runId: turn.turnId,
      action,
      memoryId: memoryIdFromToolCall(node.toolCall),
      filename: memoryFilenameFromToolCall(node.toolCall),
      title: summarizeMemoryTitle(node.toolCall),
      reason: memoryReason(node.toolCall, action),
      sourceSessionId: stringValue(node.toolCall.args, ['sourceSessionId', 'sourceSession'])
        || stringValue(node.toolCall.metadata, ['sourceSessionId', 'sourceSession']),
      targetPath: stringValue(node.toolCall.args, ['path', 'file_path'])
        || stringValue(node.toolCall.metadata, ['path', 'filePath']),
      confidence: numberValue(node.toolCall.args, ['confidence'])
        ?? numberValue(node.toolCall.metadata, ['confidence']),
    });
  }

  return events.slice(-8);
}

function outputPathFromResult(result?: ToolResult, toolName?: string): string | undefined {
  if (!result) return undefined;
  if (isReadOnlyArtifactTool(toolName)) return undefined;
  if (result.outputPath) return result.outputPath;
  const meta = result.metadata;
  if (!meta) return undefined;
  for (const key of ['filePath', 'imagePath', 'videoPath', 'outputPath', 'pptxPath', 'pdfPath']) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function basename(pathOrUrl?: string): string {
  return lastPathSegment(pathOrUrl) || 'Output';
}

export function buildOutputArtifactViews(projection: TraceProjection): OutputArtifactView[] {
  const turn = latestTurn(projection);
  if (!turn) return [];
  const outputs = new Map<string, OutputArtifactView>();

  for (const timeline of getTimelineNodes(turn)) {
    if (timeline.kind !== 'artifact_ownership') continue;
    for (const item of timeline.artifactOwnership || []) {
      if (isReadOnlyArtifactOwnershipItem(item)) continue;
      const pathOrUrl = item.path || item.url;
      const id = pathOrUrl || `${item.kind}:${item.label}:${item.ownerLabel}`;
      outputs.set(id, {
        id,
        runId: turn.turnId,
        kind: item.kind,
        title: item.label,
        pathOrUrl,
        previewState: pathOrUrl ? 'available' : 'unknown',
        provenance: item.ownerLabel,
      });
    }
  }

  for (const node of turn.nodes) {
    if (node.type !== 'tool_call' || !node.toolCall?.result) continue;
    const pathOrUrl = outputPathFromResult({
      toolCallId: node.toolCall.id,
      success: node.toolCall.success ?? true,
      output: node.toolCall.result,
      outputPath: node.toolCall.outputPath,
      duration: node.toolCall.duration,
      metadata: node.toolCall.metadata,
    }, node.toolCall.name);
    if (!pathOrUrl) continue;
    outputs.set(pathOrUrl, {
      id: pathOrUrl,
      runId: turn.turnId,
      kind: 'file',
      title: basename(pathOrUrl),
      pathOrUrl,
      previewState: 'available',
      provenance: node.toolCall.name,
    });
  }

  return Array.from(outputs.values()).slice(-10);
}

function todoStatus(status: TodoItem['status']): TaskRecord['steps'][number]['status'] {
  if (status === 'completed') return 'done';
  if (status === 'in_progress') return 'in_progress';
  return 'pending';
}

function taskProgressStepStatus(progress: TaskProgressData): TaskRecord['steps'][number]['status'] {
  if (progress.phase === 'completed') return 'done';
  if (progress.phase === 'failed') return 'blocked';
  return 'in_progress';
}

function taskProgressTitle(progress: TaskProgressData): string {
  if (progress.step?.trim()) return progress.step.trim();
  if (progress.tool?.trim()) return `工具 ${progress.tool.trim()}`;
  const labels: Record<TaskProgressData['phase'], string> = {
    thinking: '分析请求中',
    generating: '生成回复中',
    tool_pending: '准备执行',
    tool_running: '执行工具中',
    completed: '回复完成',
    failed: '任务失败',
  };
  return labels[progress.phase];
}

function taskProgressHint(progress?: TaskProgressData | null): string | undefined {
  if (!progress) return undefined;
  const details: string[] = [];
  if (progress.tool?.trim()) details.push(`工具：${progress.tool.trim()}`);
  if (progress.toolTotal && progress.toolTotal > 1) {
    const index = Math.min((progress.toolIndex ?? 0) + 1, progress.toolTotal);
    details.push(`第 ${index}/${progress.toolTotal} 个工具`);
  }
  const step = progress.step?.trim();
  if (step) details.unshift(step);
  return details.length > 0 ? details.join(' · ') : undefined;
}

export function buildSessionTaskRecord(args: {
  sessionId: string | null;
  runId: string | null;
  runStatus?: RunUiStatus;
  todos?: TodoItem[];
  taskProgress?: TaskProgressData | null;
}): TaskRecord | null {
  const runIsQuietFinished = args.runStatus === 'completed' || args.runStatus === 'cancelled';
  const hasLiveTaskProgress = Boolean(args.taskProgress && args.taskProgress.phase !== 'completed');
  if (runIsQuietFinished && !hasLiveTaskProgress) return null;

  const todos = args.todos || [];
  if (todos.length === 0 && args.taskProgress) {
    const title = taskProgressTitle(args.taskProgress);
    const status = taskProgressStepStatus(args.taskProgress);
    return {
      id: `${args.sessionId || 'session'}:progress`,
      scope: 'session',
      title,
      status: status === 'done' ? 'done' : status === 'blocked' ? 'blocked' : 'in_progress',
      steps: [{ title, status }],
      ownerRunId: args.runId,
      sourceThreadId: args.sessionId,
      resumeHint: taskProgressHint(args.taskProgress),
    };
  }
  if (todos.length === 0) return null;
  const active = todos.find((todo) => todo.status === 'in_progress') || todos.find((todo) => todo.status !== 'completed');
  const completed = todos.filter((todo) => todo.status === 'completed').length;

  return {
    id: `${args.sessionId || 'session'}:todos`,
    scope: 'session',
    title: active?.activeForm || active?.content || `${completed}/${todos.length} tasks`,
    status: completed === todos.length ? 'done' : active?.status === 'in_progress' ? 'in_progress' : 'pending',
    steps: todos.map((todo) => ({
      title: todo.activeForm || todo.content,
      status: todoStatus(todo.status),
    })),
    ownerRunId: args.runId,
    sourceThreadId: args.sessionId,
    resumeHint: taskProgressHint(args.taskProgress),
  };
}
