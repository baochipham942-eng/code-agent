// ============================================================================
// TaskManager (P1 Wave 3 — planning: native ToolModule rewrite)
//
// 旧版: src/host/tools/planning/TaskManagerTool.ts
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：INVALID_ARGS / PERMISSION_DENIED / ABORTED
// - 直接 dispatch 到 native sub-tool (executeTaskCreate/Get/List/Update)
//   不再走 legacy Tool 委托——native ToolModule chain
// - 行为保真：unknown action → INVALID_ARGS with valid list
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { taskManagerSchema as schema } from './taskManager.schema';
import { executeTaskCreate } from './taskCreate';
import { executeTaskGet } from './taskGet';
import { executeTaskList } from './taskList';
import { executeTaskUpdate } from './taskUpdate';
import type { SessionTask, SessionTaskPriority, SessionTaskStatus, UpdateTaskInput } from '../../../../shared/contract/planning';
import { clearTasks, createTask, listTasks, updateTask } from '../../../services/planning/taskStore';
import { buildTaskEvidenceUpdates } from '../../../services/planning/taskEvidenceGate';

type BatchAction = 'replace' | 'patch';

interface BatchTaskInput {
  id?: unknown;
  taskId?: unknown;
  subject?: unknown;
  content?: unknown;
  description?: unknown;
  activeForm?: unknown;
  status?: unknown;
  priority?: unknown;
  owner?: unknown;
  metadata?: unknown;
  completionEvidence?: unknown;
  blockedReason?: unknown;
  cancelReason?: unknown;
}

interface ProjectedTask {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: SessionTaskStatus;
  priority: SessionTaskPriority;
  owner?: string;
  metadata: Record<string, unknown>;
  /** 证据门产出的落盘字段（completed/blocked 必有，其余为空对象） */
  evidence: Partial<UpdateTaskInput>;
  newInput?: BatchTaskInput;
}

const VALID_BATCH_STATUSES = new Set<SessionTaskStatus>([
  'pending', 'in_progress', 'completed', 'blocked', 'cancelled',
]);
const VALID_PRIORITIES = new Set<SessionTaskPriority>(['low', 'normal', 'high']);

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeStatus(value: unknown): SessionTaskStatus {
  return typeof value === 'string' && VALID_BATCH_STATUSES.has(value as SessionTaskStatus)
    ? value as SessionTaskStatus
    : 'pending';
}

function normalizePriority(value: unknown): SessionTaskPriority {
  return typeof value === 'string' && VALID_PRIORITIES.has(value as SessionTaskPriority)
    ? value as SessionTaskPriority
    : 'normal';
}

function projectedFromExisting(task: SessionTask): ProjectedTask {
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    activeForm: task.activeForm,
    status: task.status,
    priority: task.priority,
    owner: task.owner,
    metadata: { ...task.metadata },
    evidence: {},
  };
}

/**
 * 证据门（ADR-050）在批量路径上按「状态转移」触发：沿用旧状态的条目不算新声称，
 * 只有真的把某条改成 completed/blocked 才要求证据。
 */
function evidenceForBatchItem(
  input: BatchTaskInput,
  status: SessionTaskStatus,
  previousStatus: SessionTaskStatus | undefined,
  label: string,
): Partial<UpdateTaskInput> | string {
  if (status === previousStatus) return {};
  const result = buildTaskEvidenceUpdates({ ...input, status }, label);
  return result.ok ? result.updates : `${label}: ${result.error}`;
}

function projectedFromInput(
  input: BatchTaskInput,
  index: number,
  previousStatus?: SessionTaskStatus,
): ProjectedTask | string {
  const subject = readString(input.subject) ?? readString(input.content);
  if (!subject) {
    return `tasks[${index}].subject is required and must be a string`;
  }
  const description = readString(input.description) ?? subject;
  const status = normalizeStatus(input.status);
  const evidence = evidenceForBatchItem(input, status, previousStatus, `tasks[${index}]`);
  if (typeof evidence === 'string') {
    return evidence;
  }
  return {
    id: `__new_${index}`,
    subject,
    description,
    activeForm: readString(input.activeForm),
    status,
    priority: normalizePriority(input.priority),
    owner: readString(input.owner),
    metadata: readMetadata(input.metadata),
    evidence,
    newInput: input,
  };
}

function readBatchTasks(args: Record<string, unknown>): BatchTaskInput[] | string {
  const rawTasks = args.tasks;
  if (!Array.isArray(rawTasks)) {
    return 'tasks is required and must be an array';
  }
  return rawTasks as BatchTaskInput[];
}

function normalizeExactlyOneInProgress(
  tasks: ProjectedTask[],
  preferredInProgressIds: Set<string>,
): ProjectedTask[] {
  const openTasks = tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress');
  if (openTasks.length === 0) {
    return tasks;
  }

  const preferred = tasks.find((task) => preferredInProgressIds.has(task.id) && openTasks.includes(task));
  const current = tasks.find((task) => task.status === 'in_progress' && openTasks.includes(task));
  const selectedId = (preferred ?? current ?? openTasks[0]).id;

  return tasks.map((task) => {
    if (task.status !== 'pending' && task.status !== 'in_progress') {
      return task;
    }
    return {
      ...task,
      status: task.id === selectedId ? 'in_progress' : 'pending',
    };
  });
}

function taskUpdateFromProjection(before: SessionTask, after: ProjectedTask): Record<string, unknown> {
  const updates: Record<string, unknown> = { ...after.evidence };
  if (before.status !== after.status) updates.status = after.status;
  if (before.subject !== after.subject) updates.subject = after.subject;
  if (before.description !== after.description) updates.description = after.description;
  if (before.activeForm !== after.activeForm && after.activeForm) updates.activeForm = after.activeForm;
  if (before.owner !== after.owner) updates.owner = after.owner;
  if (Object.keys(after.metadata).length > 0) updates.metadata = after.metadata;
  return updates;
}

function emitBatchTaskUpdate(
  ctx: ToolContext,
  sessionId: string,
  action: BatchAction,
  taskIds: string[],
): void {
  (ctx.emit as unknown as ((event: string, payload: unknown) => void) | undefined)?.(
    'task_update',
    {
      tasks: listTasks(sessionId),
      action,
      taskIds,
    },
  );
}

async function executeTaskPlanReplace(
  args: Record<string, unknown>,
  ctx: ToolContext,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const batch = readBatchTasks(args);
  if (typeof batch === 'string') {
    return { ok: false, error: batch, code: 'INVALID_ARGS' };
  }

  const sessionId = ctx.sessionId || 'default';
  // replace 会清空重建，但同名任务的既有状态是「沿用」不是「新声称」——
  // 拿清空前的快照做证据门的 previousStatus，否则每次重排计划都要重新举证。
  const previousBySubject = new Map(
    listTasks(sessionId).map((task) => [task.subject, task] as const),
  );

  const projected: ProjectedTask[] = [];
  const preferredInProgressIds = new Set<string>();
  for (let index = 0; index < batch.length; index += 1) {
    const raw = batch[index];
    const subject = readString(raw.subject) ?? readString(raw.content);
    const previous = subject ? previousBySubject.get(subject) : undefined;
    const item = projectedFromInput(raw, index, previous?.status);
    if (typeof item === 'string') {
      return { ok: false, error: item, code: 'INVALID_ARGS' };
    }
    if (item.status === 'in_progress') {
      preferredInProgressIds.add(item.id);
    }
    // 沿用旧状态的条目把旧证据一起带过来，否则重建后会出现「completed 但无证据」
    if (previous?.status === item.status) {
      item.evidence = {
        ...(previous.evidenceRefs?.length ? { evidenceRefs: previous.evidenceRefs } : {}),
        ...(previous.blockedReason !== undefined ? { blockedReason: previous.blockedReason } : {}),
        ...(previous.blockedReasonCategory
          ? { blockedReasonCategory: previous.blockedReasonCategory }
          : {}),
      };
    }
    projected.push(item);
  }

  const normalized = normalizeExactlyOneInProgress(projected, preferredInProgressIds);
  clearTasks(sessionId);

  const createdIds: string[] = [];
  for (const item of normalized) {
    const task = createTask(sessionId, {
      subject: item.subject,
      description: item.description,
      activeForm: item.activeForm,
      priority: item.priority,
      metadata: item.metadata,
      owner: item.owner,
    });
    createdIds.push(task.id);
    if (item.status !== 'pending') {
      updateTask(sessionId, task.id, { ...item.evidence, status: item.status });
    }
  }

  emitBatchTaskUpdate(ctx, sessionId, 'replace', createdIds);
  onProgress?.({ stage: 'completing', percent: 100 });

  const tasks = listTasks(sessionId);
  return {
    ok: true,
    output: `Task plan replaced: ${tasks.length} task(s), ${tasks.filter((task) => task.status === 'in_progress').length} in progress.`,
    meta: { tasks },
  };
}

async function executeTaskPlanPatch(
  args: Record<string, unknown>,
  ctx: ToolContext,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const batch = readBatchTasks(args);
  if (typeof batch === 'string') {
    return { ok: false, error: batch, code: 'INVALID_ARGS' };
  }

  const sessionId = ctx.sessionId || 'default';
  const existingTasks = listTasks(sessionId);
  const projectedById = new Map(existingTasks.map((task) => [task.id, projectedFromExisting(task)]));
  const preferredInProgressIds = new Set<string>();
  const newItems: ProjectedTask[] = [];

  for (let index = 0; index < batch.length; index += 1) {
    const item = batch[index];
    const id = readString(item.taskId) ?? readString(item.id);
    if (!id) {
      const projected = projectedFromInput(item, index);
      if (typeof projected === 'string') {
        return { ok: false, error: projected, code: 'INVALID_ARGS' };
      }
      if (projected.status === 'in_progress') {
        preferredInProgressIds.add(projected.id);
      }
      newItems.push(projected);
      continue;
    }

    const existing = projectedById.get(id);
    if (!existing) {
      return { ok: false, error: `Task #${id} not found`, code: 'NOT_FOUND' };
    }
    const status = item.status === undefined ? existing.status : normalizeStatus(item.status);
    if (status === 'in_progress') {
      preferredInProgressIds.add(id);
    }
    const evidence = evidenceForBatchItem(item, status, existing.status, `tasks[${index}] (#${id})`);
    if (typeof evidence === 'string') {
      return { ok: false, error: evidence, code: 'INVALID_ARGS' };
    }
    projectedById.set(id, {
      ...existing,
      subject: readString(item.subject) ?? readString(item.content) ?? existing.subject,
      description: readString(item.description) ?? existing.description,
      activeForm: readString(item.activeForm) ?? existing.activeForm,
      status,
      owner: item.owner === undefined ? existing.owner : readString(item.owner),
      metadata: item.metadata === undefined ? existing.metadata : readMetadata(item.metadata),
      evidence,
    });
  }

  const projected = normalizeExactlyOneInProgress(
    [...Array.from(projectedById.values()), ...newItems],
    preferredInProgressIds,
  );

  const changedIds: string[] = [];
  for (const task of projected) {
    if (task.newInput) {
      const created = createTask(sessionId, {
        subject: task.subject,
        description: task.description,
        activeForm: task.activeForm,
        priority: task.priority,
        metadata: task.metadata,
        owner: task.owner,
      });
      changedIds.push(created.id);
      if (task.status !== 'pending') {
        updateTask(sessionId, created.id, { ...task.evidence, status: task.status });
      }
      continue;
    }

    const before = existingTasks.find((existing) => existing.id === task.id);
    if (!before) continue;
    const updates = taskUpdateFromProjection(before, task);
    if (Object.keys(updates).length === 0) continue;
    updateTask(sessionId, task.id, updates);
    changedIds.push(task.id);
  }

  emitBatchTaskUpdate(ctx, sessionId, 'patch', changedIds);
  onProgress?.({ stage: 'completing', percent: 100 });

  const tasks = listTasks(sessionId);
  return {
    ok: true,
    output: `Task plan patched: ${changedIds.length} task(s) changed, ${tasks.filter((task) => task.status === 'in_progress').length} in progress.`,
    meta: { tasks, changedIds },
  };
}

export async function executeTaskManager(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const action = args.action;

  // 五链顺序：先 canUseTool/abort 再 dispatch（也让子工具再各自 canUseTool 一次，
  // 但 facade 层面要先把"不允许 TaskManager"挡掉）
  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  switch (action) {
    case 'create':
      return executeTaskCreate(args, ctx, canUseTool, onProgress);
    case 'get':
      return executeTaskGet(args, ctx, canUseTool, onProgress);
    case 'list':
      return executeTaskList(args, ctx, canUseTool, onProgress);
    case 'update':
      return executeTaskUpdate(args, ctx, canUseTool, onProgress);
    case 'replace':
      return executeTaskPlanReplace(args, ctx, onProgress);
    case 'patch':
      return executeTaskPlanPatch(args, ctx, onProgress);
    default:
      return {
        ok: false,
        error: `Unknown action: ${String(action)}. Valid actions: create, get, list, update, replace, patch`,
        code: 'INVALID_ARGS',
      };
  }
}

class TaskManagerHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeTaskManager(args, ctx, canUseTool, onProgress);
  }
}

export const taskManagerModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new TaskManagerHandler();
  },
};
