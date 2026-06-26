// ============================================================================
// Task Status Provider — P3-A 只读任务状态聚合（暴露给外部编排器）
// ============================================================================
//
// 战略定位（内部文档 §P3）：
//   A 路线 = 低成本暴露一个【只读】任务状态查询面，让 Coze/codeg 等外部编排器
//   把 Neo 当成员接入，蹭生态曝光但不丢主权。
//
// 主权底线（默认仅元数据）：
//   - 默认只暴露【状态 / 进度计数 / token·cost 统计 / 时间戳 / 枚举归因】等元数据，
//     绝不外泄【任务 prompt 原文 / agent 产物 / 事件 message 自由文本 / 改动文件路径 /
//     goal·verify·review 指令文本 / 项目描述】等本地任务内容。
//   - 「本地隐私」是核心卖点：外部编排器看得到「跑没跑、跑完跑了多少」，看不到「跑了啥」。
//   - includeContent 是预留的 opt-in 门：默认关闭，仅当上层显式开启（未来配 config 闸）
//     才把内容字段加回。MVP 调用方一律传 false。
//
// 数据源（全部只读，不碰写/执行路径）：
//   - SwarmTraceRepo.listRuns / getRunDetail   → swarm 运行历史与详情
//   - ProjectService.listProjects / getProjectDetail → 项目 + goal 状态（P0-2）
//   - TaskManager.getAllStates                  → 内存中的实时会话状态
// ============================================================================

import type { SwarmTraceRepo, SwarmRunListItem } from '../../shared/contract/swarmTrace';
import type { Project, ProjectGoal, ProjectGoalStatus } from '../../shared/contract/project';
import type { SessionState, SessionStatus } from '../task/TaskManager';

/** list 类查询的默认返回条数。 */
const DEFAULT_TASK_LIST_LIMIT = 20;

// ----------------------------------------------------------------------------
// 数据源依赖（用 -Like 接口解耦，便于 unit test 注入 fake，无需真实 DB）
// ----------------------------------------------------------------------------

export interface ProjectDetailLike {
  project: Project;
  goals: ProjectGoal[];
  roles: unknown[];
  sessionIds: string[];
}

export interface ProjectServiceLike {
  listProjects(includeArchived?: boolean): Project[];
  getProjectDetail(projectId: string): ProjectDetailLike | undefined;
}

export interface TaskManagerLike {
  getAllStates(): Map<string, SessionState>;
}

export interface TaskStatusProviderDeps {
  /** swarm trace repo，可能为 null（DB 未初始化时）。 */
  getSwarmRepo: () => SwarmTraceRepo | null;
  getProjectService: () => ProjectServiceLike;
  getTaskManager: () => TaskManagerLike;
}

export interface ReadOptions {
  /**
   * 预留 opt-in 门：默认 false（仅元数据）。设为 true 才把任务内容自由文本加回。
   * MVP 调用方不传（恒 false），守住「本地隐私」主权底线。
   */
  includeContent?: boolean;
}

// ----------------------------------------------------------------------------
// 输出 DTO（默认仅元数据，content 字段仅在 includeContent 时出现）
// ----------------------------------------------------------------------------

export interface LiveSessionMeta {
  sessionId: string;
  status: SessionStatus;
  startTime?: number;
  queuePosition?: number;
  hasError: boolean;
  /** 仅 includeContent 时存在。 */
  error?: string;
}

export interface TaskListResult {
  /** swarm 运行历史（SwarmRunListItem 本身即元数据，无内容字段）。 */
  swarmRuns: SwarmRunListItem[];
  /** 内存中的实时会话状态（app 运行时才有）。 */
  liveSessions: LiveSessionMeta[];
}

export interface SwarmAgentMeta {
  agentId: string;
  name: string;
  role: string;
  status: string;
  startTime: number | null;
  endTime: number | null;
  durationMs: number | null;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  costUsd: number;
  /** 枚举式归因（非自由文本），安全暴露。 */
  failureCategory: string | null;
  hasError: boolean;
  /** 只给计数，不给文件路径（路径属内容）。 */
  filesChangedCount: number;
  /** 仅 includeContent 时存在。 */
  error?: string;
  /** 仅 includeContent 时存在。 */
  filesChanged?: string[];
}

export interface SwarmEventSummary {
  total: number;
  byType: Record<string, number>;
  byLevel: Record<string, number>;
  lastTimestamp: number | null;
  /** 仅 includeContent 时存在：事件 timeline 的 title/summary 自由文本。 */
  events?: Array<{ seq: number; timestamp: number; eventType: string; level: string; title: string; summary: string }>;
}

export interface SwarmRunStatusMeta {
  id: string;
  sessionId: string | null;
  coordinator: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  totalAgents: number;
  completedCount: number;
  failedCount: number;
  parallelPeak: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalToolCalls: number;
  totalCostUsd: number;
  trigger: string;
  hasError: boolean;
  tags: string[];
  agents: SwarmAgentMeta[];
  eventSummary: SwarmEventSummary;
  /** 仅 includeContent 时存在：run 收尾的错误摘要自由文本。 */
  errorSummary?: string;
}

export interface ProjectGoalMeta {
  id: string;
  status: ProjectGoalStatus;
  lastRunSessionId: string | null;
  createdAt: number;
  updatedAt: number;
  /** 仅 includeContent 时存在：goal/verify/review 指令文本。 */
  goal?: string;
  verify?: string | null;
  review?: string | null;
}

export interface ProjectMeta {
  id: string;
  /** 项目名是协调所需的身份标识（粗粒度 label），保留；description 属内容，默认不暴露。 */
  name: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  goalCount: number;
  goalStatusCounts: Record<string, number>;
  roleCount: number;
  sessionCount: number;
  goals: ProjectGoalMeta[];
  /** 仅 includeContent 时存在：项目描述自由文本。 */
  description?: string;
}

// ----------------------------------------------------------------------------
// Provider
// ----------------------------------------------------------------------------

export class TaskStatusProvider {
  constructor(private readonly deps: TaskStatusProviderDeps) {}

  /** 列当前/最近的任务：swarm 运行历史 + 实时会话状态。 */
  listTasks(opts: ReadOptions & { limit?: number } = {}): TaskListResult {
    const limit = opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_TASK_LIST_LIMIT;
    const includeContent = opts.includeContent === true;

    const repo = this.deps.getSwarmRepo();
    const swarmRuns = repo ? repo.listRuns(limit) : [];

    const liveSessions: LiveSessionMeta[] = [];
    for (const [sessionId, state] of this.deps.getTaskManager().getAllStates()) {
      const meta: LiveSessionMeta = {
        sessionId,
        status: state.status,
        startTime: state.startTime,
        queuePosition: state.queuePosition,
        hasError: !!state.error,
      };
      if (includeContent && state.error) meta.error = state.error;
      liveSessions.push(meta);
    }

    return { swarmRuns, liveSessions };
  }

  /** 查指定 swarm run 详情（进度/token/met-or-aborted）。未找到返回 null。 */
  getTaskStatus(runId: string, opts: ReadOptions = {}): SwarmRunStatusMeta | null {
    const repo = this.deps.getSwarmRepo();
    if (!repo) return null;
    const detail = repo.getRunDetail(runId);
    if (!detail) return null;

    const includeContent = opts.includeContent === true;
    const { run, agents, events } = detail;

    const agentMetas: SwarmAgentMeta[] = agents.map((a) => {
      const meta: SwarmAgentMeta = {
        agentId: a.agentId,
        name: a.name,
        role: a.role,
        status: a.status,
        startTime: a.startTime,
        endTime: a.endTime,
        durationMs: a.durationMs,
        tokensIn: a.tokensIn,
        tokensOut: a.tokensOut,
        toolCalls: a.toolCalls,
        costUsd: a.costUsd,
        failureCategory: a.failureCategory,
        hasError: !!a.error,
        filesChangedCount: a.filesChanged.length,
      };
      if (includeContent) {
        if (a.error) meta.error = a.error;
        meta.filesChanged = a.filesChanged;
      }
      return meta;
    });

    const byType: Record<string, number> = {};
    const byLevel: Record<string, number> = {};
    let lastTimestamp: number | null = null;
    for (const e of events) {
      byType[e.eventType] = (byType[e.eventType] ?? 0) + 1;
      byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
      if (lastTimestamp === null || e.timestamp > lastTimestamp) lastTimestamp = e.timestamp;
    }
    const eventSummary: SwarmEventSummary = { total: events.length, byType, byLevel, lastTimestamp };
    if (includeContent) {
      eventSummary.events = events.map((e) => ({
        seq: e.seq,
        timestamp: e.timestamp,
        eventType: e.eventType,
        level: e.level,
        title: e.title,
        summary: e.summary,
      }));
    }

    const result: SwarmRunStatusMeta = {
      id: run.id,
      sessionId: run.sessionId,
      coordinator: run.coordinator,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs: run.endedAt !== null ? run.endedAt - run.startedAt : null,
      totalAgents: run.totalAgents,
      completedCount: run.completedCount,
      failedCount: run.failedCount,
      parallelPeak: run.parallelPeak,
      totalTokensIn: run.totalTokensIn,
      totalTokensOut: run.totalTokensOut,
      totalToolCalls: run.totalToolCalls,
      totalCostUsd: run.totalCostUsd,
      trigger: run.trigger,
      hasError: !!run.errorSummary,
      tags: run.tags,
      agents: agentMetas,
      eventSummary,
    };
    if (includeContent && run.errorSummary) result.errorSummary = run.errorSummary;
    return result;
  }

  /** 列项目 + 各自 goal 状态（P0-2 数据）。 */
  listProjects(opts: ReadOptions & { includeArchived?: boolean } = {}): ProjectMeta[] {
    const includeContent = opts.includeContent === true;
    const svc = this.deps.getProjectService();
    const projects = svc.listProjects(opts.includeArchived === true);

    return projects.map((p) => {
      const detail = svc.getProjectDetail(p.id);
      const goals = detail?.goals ?? [];
      const goalStatusCounts: Record<string, number> = {};
      for (const g of goals) {
        goalStatusCounts[g.status] = (goalStatusCounts[g.status] ?? 0) + 1;
      }
      const goalMetas: ProjectGoalMeta[] = goals.map((g) => {
        const gm: ProjectGoalMeta = {
          id: g.id,
          status: g.status,
          lastRunSessionId: g.lastRunSessionId ?? null,
          createdAt: g.createdAt,
          updatedAt: g.updatedAt,
        };
        if (includeContent) {
          gm.goal = g.goal;
          gm.verify = g.verify;
          gm.review = g.review;
        }
        return gm;
      });

      const meta: ProjectMeta = {
        id: p.id,
        name: p.name,
        status: p.status,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        archivedAt: p.archivedAt ?? null,
        goalCount: goals.length,
        goalStatusCounts,
        roleCount: detail?.roles.length ?? 0,
        sessionCount: detail?.sessionIds.length ?? 0,
        goals: goalMetas,
      };
      if (includeContent && p.description) meta.description = p.description;
      return meta;
    });
  }
}
