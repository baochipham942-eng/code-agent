// ============================================================================
// Database Service - SQLite 数据持久化层（薄门面，委托给 Repository）
// ============================================================================

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { app } from '../../platform';
import { createLogger } from '../infra/logger';
import { getServiceRegistry } from '../serviceRegistry';
import { loadBetterSqlite3 } from './database/nativeLoader';
import { applySchema } from './database/schema';
import { applyIndexes } from './database/indexes';
import { applySessionsMigrations, applyTelemetryTurnsMigrations, applyEvaluationCleanupMigration } from './database/migrations';
import { DurableRunDatabaseSupport } from './database/durableRunDatabaseSupport';

const logger = createLogger('DatabaseService');
const moduleDir = typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
import type BetterSqlite3 from 'better-sqlite3';
const Database = loadBetterSqlite3(moduleDir, logger);
import type { Session, Message, ToolResult, ModelProvider, TodoItem, SessionTask } from '../../../shared/contract';
import type { ContextInterventionAction, ContextInterventionSnapshot } from '../../../shared/contract/contextView';
import type { CaptureItem, CaptureSource, CaptureStats } from '../../../shared/contract/capture';
import { SessionForkError } from '../../../shared/contract/sessionFork';

// Re-export types from repositories（保持外部调用方零修改）
export type { StoredSession, StoredMessage, MemoryRecord, UserPreference, ProjectKnowledge, ToolExecution } from './repositories';

import { SessionRepository, SessionForkRepository, SessionForkWorkspaceRepository, digestSessionForkAnchorMessage, isCompletedSessionForkAnchor, MemoryRepository, ConfigRepository, CaptureRepository, ExperimentRepository, ProjectRepository, PendingApprovalRepository, GenerativeUIRepository, PermissionDecisionRepository, type PermissionDecisionInput, type PermissionDecisionRecord, ToolExecutionEventRepository, type ToolExecutionBeginInput, type ToolExecutionCompleteInput, type OpenToolExecution, SwarmLedgerRepository, UsageLedgerRepository, type UsageLedgerEntryInput, type UsageLedgerEntry, AgentWakeRepository, TurnCostRepository } from './repositories';
import type { SwarmLedgerAppendInput, SwarmLedgerEvent } from '../../../shared/contract/swarmLedger';
import type { RecoverySnapshot } from './crashRecovery';
import { createInitStepTimer, runStartupMaintenance } from './database/startupMaintenance';
import { createSwarmTraceRepo } from './repositories/swarmTraceFactory';
import type { SwarmTraceRepo, SwarmRunEventRecord } from '../../../shared/contract/swarmTrace';
import { buildSessionLedger, type LedgerSources } from './sessionLedgerProjection';
import { readSessionCost, readSwarmRunsForSession } from './sessionLedgerSources';
import { rebuildRunDetail } from './swarmRollupProjection';
import { reconcileRun, type ReconcileResult } from './swarmReconcile';
import type { SwarmRunDetail } from '../../../shared/contract/swarmTrace';
import type { SessionLedger } from '../../../shared/contract/sessionLedger';
import { redactSecrets } from '../../security/secretRedaction';
import {
  AnchorWorkspaceEvidenceService,
  IsolatedAnchorWorkspaceService,
  NodeWorkspaceCommandRunner,
  digestWorkspaceValue,
  projectChildWorkspaceScope,
} from '../sessionFork/workspace';
import type { WorkspaceScope } from '../../../shared/contract/project';

type DatabaseRecoveryCallback = () => void;

const databaseRecoveryListeners = new Set<DatabaseRecoveryCallback>();

export function onDatabaseRecovered(callback: DatabaseRecoveryCallback): () => void {
  databaseRecoveryListeners.add(callback);
  return () => {
    databaseRecoveryListeners.delete(callback);
  };
}

function notifyDatabaseRecovered(): void {
  for (const listener of databaseRecoveryListeners) {
    try {
      listener();
    } catch (error) {
      logger.warn('[DatabaseService] Database recovery listener failed:', error);
    }
  }
}

// ----------------------------------------------------------------------------
// Database Service
// ----------------------------------------------------------------------------

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function forkWorkspaceSourceIdentity(scope: WorkspaceScope): Record<string, unknown> {
  const canonicalPath = (value: string): string => {
    try {
      return fs.realpathSync.native(value);
    } catch {
      return path.resolve(value);
    }
  };
  return {
    projectId: scope.projectId,
    version: scope.version,
    primaryRoot: canonicalPath(scope.primaryRoot),
    roots: [...scope.roots]
      .map((root) => ({
        sourceId: root.sourceId,
        path: canonicalPath(root.path),
        access: root.access,
        role: root.role,
        identityDev: root.identityDev ?? null,
        identityIno: root.identityIno ?? null,
      }))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
  };
}

function sessionForkFailure(error: unknown): Record<string, unknown> {
  return {
    code: typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? 'UNKNOWN')
      : 'UNKNOWN',
    message: error instanceof Error ? error.message : String(error),
    at: Date.now(),
  };
}

export class DatabaseService extends DurableRunDatabaseSupport {
  private db: BetterSqlite3.Database | null = null;
  private dbPath = path.join(app?.getPath?.('userData') || process.cwd(), 'code-agent.db');
  private _initPromise: Promise<void> | null = null;
  private _initFailed = false;
  private _retryCount = 0;
  private readonly MAX_RETRIES = 3;
  private _retryTimer: ReturnType<typeof setTimeout> | null = null;

  // Repositories
  private sessionRepo!: SessionRepository;
  private sessionForkRepo!: SessionForkRepository;
  private sessionForkWorkspaceRepo!: SessionForkWorkspaceRepository;
  private isolatedAnchorWorkspaceService!: IsolatedAnchorWorkspaceService;
  private memoryRepo!: MemoryRepository;
  private configRepo!: ConfigRepository;
  private captureRepo!: CaptureRepository;
  private experimentRepo!: ExperimentRepository;
  private projectRepo!: ProjectRepository;
  private swarmTraceRepo!: SwarmTraceRepo;
  private pendingApprovalRepo!: PendingApprovalRepository;
  private agentWakeRepo!: AgentWakeRepository;
  private permissionDecisionRepo!: PermissionDecisionRepository;
  private toolExecutionEventRepo!: ToolExecutionEventRepository;
  private swarmLedgerRepo!: SwarmLedgerRepository;
  private usageLedgerRepo!: UsageLedgerRepository;
  private turnCostRepo!: TurnCostRepository;
  /** 启动时从总账重建的崩溃现场快照（ADR-022 第二期），供诊断出口/恢复消费 */
  private lastRecoverySnapshot: RecoverySnapshot | null = null;

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  /**
   * 是否已初始化完成
   */
  get isReady(): boolean {
    return this.db !== null;
  }

  /**
   * 等待数据库初始化完成（供其他服务在启动时等待）
   * 如果尚未开始初始化，返回立即 resolve 的 Promise（不会自动触发初始化）
   */
  async waitForInit(): Promise<boolean> {
    if (this.db) return true;
    if (this._initPromise) {
      try {
        await this._initPromise;
        return this.db !== null;
      } catch (error) {
        logger.warn('[DatabaseService] Failed to wait for init:', error);
        return false;
      }
    }
    return false;
  }

  async initialize(): Promise<void> {
    // 已初始化成功，跳过
    if (this.db) return;
    // 正在初始化中，等待
    if (this._initPromise && !this._initFailed) return this._initPromise;

    this._initFailed = false;
    this._initPromise = this._doInitialize().catch((err) => {
      this._initFailed = true;
      this._scheduleRetry();
      throw err;
    });
    return this._initPromise;
  }

  /**
   * 初始化失败后自动重试（指数退避，最多 MAX_RETRIES 次）
   */
  private _scheduleRetry(): void {
    if (this._retryCount >= this.MAX_RETRIES || !Database) return;

    this._retryCount++;
    const delay = Math.min(1000 * Math.pow(2, this._retryCount - 1), 10000);
    logger.warn(`Database init retry ${this._retryCount}/${this.MAX_RETRIES} in ${delay}ms`);

    this._retryTimer = setTimeout(async () => {
      try {
        this._initPromise = null;
        this._initFailed = false;
        await this.initialize();
        notifyDatabaseRecovered();
        logger.info(`Database recovered after ${this._retryCount} retries`);
        this._retryCount = 0;
      } catch (error) {
        logger.warn('[DatabaseService] Failed to retry initialization:', error);
        // _scheduleRetry will be called again by initialize().catch
      }
    }, delay);
  }

  private async _doInitialize(): Promise<void> {
    // 确保目录存在（异步，性能优化）
    const dir = path.dirname(this.dbPath);
    await fs.promises.mkdir(dir, { recursive: true }).catch((err) => {
      // EEXIST 表示目录已存在，不是错误
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    });

    if (!Database) {
      throw new Error('better-sqlite3 not available (CLI mode or native module missing)');
    }

    const { step, summary } = createInitStepTimer();

    try {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      step('open+wal');

      applySchema(this.db, logger);
      step('schema');
      applySessionsMigrations(this.db, logger);
      applyTelemetryTurnsMigrations(this.db, logger);
      applyEvaluationCleanupMigration(this.db, logger);
      this.applyDurableRunMigration(this.db);
      step('migrations');
      applyIndexes(this.db);
      step('indexes');

      // 初始化 Repositories
      this.sessionRepo = new SessionRepository(this.db);
      this.sessionForkRepo = new SessionForkRepository(this.db);
      this.sessionForkWorkspaceRepo = new SessionForkWorkspaceRepository(this.db);
      this.isolatedAnchorWorkspaceService = new IsolatedAnchorWorkspaceService({
        durableRoot: path.join(path.dirname(this.dbPath), 'session-fork-worktrees'),
        intentStore: this.sessionForkWorkspaceRepo,
      });
      const interruptedForkHandoffs = this.sessionForkRepo.recoverInterruptedContextHandoffs(Date.now());
      if (interruptedForkHandoffs > 0) {
        logger.warn(`[DatabaseService] blocked ${interruptedForkHandoffs} interrupted fork context handoff(s)`);
      }
      await this.recoverIncompleteSessionForkWorkspaces().catch((error) => {
        // Staged children are persisted with is_deleted=1, so a recovery fault
        // remains fail-closed without making the rest of local history unusable.
        logger.error(
          '[DatabaseService] Session Fork workspace recovery remained hidden:',
          error instanceof Error ? error.message : String(error),
        );
      });
      this.memoryRepo = new MemoryRepository(this.db);
      this.configRepo = new ConfigRepository(this.db);
      this.captureRepo = new CaptureRepository(this.db);
      this.experimentRepo = new ExperimentRepository(this.db);
      this.projectRepo = new ProjectRepository(this.db);
      const projectSourcesMigrated = this.projectRepo.backfillProjectSources(Date.now());
      if (projectSourcesMigrated > 0) {
        logger.info(`[DatabaseService] backfilled ${projectSourcesMigrated} Project Primary sources`);
      }
      this.swarmTraceRepo = createSwarmTraceRepo(this.db);
      this.pendingApprovalRepo = new PendingApprovalRepository(this.db);
      this.agentWakeRepo = new AgentWakeRepository(this.db);
      new GenerativeUIRepository(this.db).markOpenManifestsOrphaned(Date.now());
      this.permissionDecisionRepo = new PermissionDecisionRepository(this.db);
      this.toolExecutionEventRepo = new ToolExecutionEventRepository(this.db);
      this.swarmLedgerRepo = new SwarmLedgerRepository(this.db);
      this.usageLedgerRepo = new UsageLedgerRepository(this.db);
      this.turnCostRepo = new TurnCostRepository(this.db);
      this.initializeDurableRunRepository(this.db);
      step('repos');

      this.lastRecoverySnapshot = runStartupMaintenance({
        sessionRepo: this.sessionRepo,
        memoryRepo: this.memoryRepo,
        toolExecutionEventRepo: this.toolExecutionEventRepo,
        logger,
        step,
      });
      logger.info(`[DatabaseService] init timings: ${summary()}`);
    } catch (err) {
      // 初始化失败时回退状态，避免 this.db 已赋值但 Repository 未初始化
      logger.error('Database initialization failed, resetting state:', err);
      if (this.db) {
        try {
          this.db.close();
        } catch (closeErr) {
          logger.warn('[DatabaseService] Failed to close database during cleanup:', closeErr);
        }
      }
      this.db = null;
      throw err;
    }
  }

  private async recoverIncompleteSessionForkWorkspaces(): Promise<void> {
    const recoverable = this.sessionForkWorkspaceRepo.listRecoverableSagas();
    for (const saga of recoverable) {
      if (saga.state !== 'child_staged') {
        const cleanup = await this.isolatedAnchorWorkspaceService.recoverIntent(
          saga.intentId,
          { strategy: 'cleanup' },
        );
        const recovery = {
          code: cleanup.outcome === 'failed'
            ? 'STARTUP_CLEANUP_FAILED'
            : 'STARTUP_PRE_CHILD_CLEANUP',
          message: cleanup.error ?? 'incomplete pre-child workspace intent was cleaned on startup',
          recoveredAt: Date.now(),
        };
        if (cleanup.outcome === 'failed') {
          this.sessionForkWorkspaceRepo.recordSagaError(saga.intentId, recovery);
        } else if (saga.state !== 'quarantined') {
          this.sessionForkWorkspaceRepo.abortSaga(saga.intentId, recovery);
        }
        continue;
      }

      const resumed = await this.isolatedAnchorWorkspaceService.recoverIntent(
        saga.intentId,
        { strategy: 'resume' },
      );
      if (resumed.outcome !== 'ready') {
        const failure = {
          code: 'STARTUP_WORKSPACE_RECOVERY_FAILED',
          message: resumed.error ?? 'the staged child workspace could not be recovered',
          recoveredAt: Date.now(),
        };
        this.sessionForkWorkspaceRepo.quarantineSaga(saga.intentId, failure);
        await this.isolatedAnchorWorkspaceService
          .recoverIntent(saga.intentId, { strategy: 'cleanup' })
          .catch(() => undefined);
        continue;
      }
      try {
        await this.isolatedAnchorWorkspaceService.markAdvertised(saga.intentId);
        this.sessionForkWorkspaceRepo.finalizeSaga(saga.intentId);
      } catch (error) {
        const failure = {
          ...sessionForkFailure(error),
          code: 'STARTUP_FINALIZE_FAILED',
        };
        this.sessionForkWorkspaceRepo.quarantineSaga(saga.intentId, failure);
        await this.isolatedAnchorWorkspaceService
          .recoverIntent(saga.intentId, { strategy: 'cleanup' })
          .catch(() => undefined);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Raw Database Access
  // --------------------------------------------------------------------------

  /**
   * 获取原始的 better-sqlite3 数据库实例
   * 仅用于需要直接执行 SQL 的特殊场景
   */
  getDb(): BetterSqlite3.Database | null {
    return this.db;
  }

  // --------------------------------------------------------------------------
  // Permission Decision Ledger（ADR-022 第一期，append-only）
  // --------------------------------------------------------------------------

  /**
   * 追加一条权限决策到事件账本。**fail-safe**：db 未就绪或写入失败都静默吞错，
   * 绝不让账本写入影响权限判定 / 工具执行（内存环形缓冲仍是主路径）。
   */
  appendPermissionDecision(input: PermissionDecisionInput): void {
    try {
      if (!this.db || !this.permissionDecisionRepo) return;
      this.permissionDecisionRepo.append(input);
    } catch (err) {
      logger.warn('[DatabaseService] appendPermissionDecision failed (ignored):', err);
    }
  }

  getRecentPermissionDecisions(limit = 50): PermissionDecisionRecord[] {
    if (!this.db || !this.permissionDecisionRepo) return [];
    try {
      return this.permissionDecisionRepo.getRecent(limit);
    } catch (err) {
      logger.warn('[DatabaseService] getRecentPermissionDecisions failed (ignored):', err);
      return [];
    }
  }

  countPermissionDecisions(): number {
    if (!this.db || !this.permissionDecisionRepo) return 0;
    try {
      return this.permissionDecisionRepo.count();
    } catch {
      return 0;
    }
  }

  // --------------------------------------------------------------------------
  // Tool Execution Lifecycle Ledger（ADR-022 第二期，append-only · 崩溃重放）
  // --------------------------------------------------------------------------

  /**
   * 追加一条工具执行 begin 事件。**fail-safe**：db 未就绪或写入失败都静默吞错，
   * 绝不让账本写入影响工具执行。
   */
  appendToolExecutionBegin(input: ToolExecutionBeginInput): void {
    try {
      if (!this.db || !this.toolExecutionEventRepo) return;
      this.toolExecutionEventRepo.appendBegin(input);
    } catch (err) {
      logger.warn('[DatabaseService] appendToolExecutionBegin failed (ignored):', err);
    }
  }

  /** 追加一条工具执行 complete 事件（success/error/recovered）。fail-safe。 */
  appendToolExecutionComplete(input: ToolExecutionCompleteInput): void {
    try {
      if (!this.db || !this.toolExecutionEventRepo) return;
      this.toolExecutionEventRepo.appendComplete(input.error ? { ...input, error: redactSecrets(input.error) } : input);
    } catch (err) {
      logger.warn('[DatabaseService] appendToolExecutionComplete failed (ignored):', err);
    }
  }

  /** 当前未闭合（在飞）的工具执行——崩溃现场。fail-safe，失败返回空。 */
  getOpenToolExecutions(): OpenToolExecution[] {
    if (!this.db || !this.toolExecutionEventRepo) return [];
    try {
      return this.toolExecutionEventRepo.getOpenExecutions();
    } catch {
      return [];
    }
  }

  /** 启动时从总账重建的崩溃现场快照（无则 null）。 */
  getLastRecoverySnapshot(): RecoverySnapshot | null {
    return this.lastRecoverySnapshot;
  }

  // --------------------------------------------------------------------------
  // Usage Ledger（A7 · per-request 用量账本，append-only）
  // --------------------------------------------------------------------------

  /**
   * 追加一条 per-request 用量记录。**fail-safe**：db 未就绪或写入失败都静默吞错，
   * 记账写入绝不能影响推理主链路（budgetService.recordUsage 的调用方在热路径上）。
   */
  appendUsageRecord(input: UsageLedgerEntryInput): void {
    try {
      if (!this.db || !this.usageLedgerRepo) return;
      this.usageLedgerRepo.append(input);
    } catch (err) {
      logger.warn('[DatabaseService] appendUsageRecord failed (ignored):', err);
    }
  }

  /** 某会话的 per-request 用量记录。fail-safe，失败返回空。 */
  getUsageLedgerBySession(sessionId: string, limit = 500): UsageLedgerEntry[] {
    if (!this.db || !this.usageLedgerRepo) return [];
    try {
      return this.usageLedgerRepo.getBySession(sessionId, limit);
    } catch {
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // Swarm Run Ledger（ADR-022 §四第三期 3b · ADR-023 D2，append-only · 协同真理源）
  // --------------------------------------------------------------------------

  /**
   * 追加一条 Swarm 协同事件到账本（真理源）。**fail-safe**：db 未就绪或写入失败都静默吞错，
   * 绝不让账本写入影响 swarm 运行 / 现有 rollup 持久化（并行追加，写路径一行不改）。
   */
  appendSwarmLedgerEvent(input: SwarmLedgerAppendInput): void {
    try {
      if (!this.db || !this.swarmLedgerRepo) return;
      this.swarmLedgerRepo.append(input);
    } catch (err) {
      logger.warn('[DatabaseService] appendSwarmLedgerEvent failed (ignored):', err);
    }
  }

  /** 某 run 的协同账本事件（按 seq 升序，供 rollup 投影重建）。fail-safe。 */
  getSwarmLedgerByRun(runId: string): SwarmLedgerEvent[] {
    if (!this.db || !this.swarmLedgerRepo) return [];
    try {
      return this.swarmLedgerRepo.getByRun(runId);
    } catch {
      return [];
    }
  }

  /** 有账记录的 run id 列表（可按 session 过滤）。fail-safe。 */
  listSwarmLedgerRunIds(sessionId?: string, limit = 200): string[] {
    if (!this.db || !this.swarmLedgerRepo) return [];
    try {
      return this.swarmLedgerRepo.listRunIds(sessionId, limit);
    } catch {
      return [];
    }
  }

  /**
   * 读 Swarm run 详情，**以协同账本(ledger)投影为真理源**（ADR-023 D2 切换降级）：
   * 有账则用重建的 run+agents（真理源），无账则回退 rollup 表（兼容无账的历史 run）。
   * timeline events 始终取 rollup 缓存（swarm_run_events 仍是 timeline 的来源）。fail-safe。
   */
  getSwarmRunDetailPreferLedger(runId: string): SwarmRunDetail | null {
    let stored: SwarmRunDetail | null;
    try {
      stored = this.swarmTraceRepo.getRunDetail(runId);
    } catch {
      stored = null;
    }
    const rebuilt = rebuildRunDetail(this.getSwarmLedgerByRun(runId));
    // 仅当账本含 run_closed（重建状态非 running）才用 ledger 作真理源——否则是"半套账本"
    // (运行中崩溃: 有 run_started 无 run_closed)，此时回退 rollup 缓存，避免把不完整的
    // "运行中"重建盖掉 rollup 里可能更完整的已完成数据（对抗审查 HIGH-1）。
    if (!rebuilt || rebuilt.run.status === 'running') return stored;
    return { run: rebuilt.run, agents: rebuilt.agents, events: stored?.events ?? [] };
  }

  /**
   * 影子对账（ADR-023 D2）：比对"从 ledger 重建的 rollup"与"现存 rollup 表"。
   * drift 为空 = 账本捕获齐全、可当真理源。纯只读、fail-safe。
   */
  reconcileSwarmRun(runId: string): ReconcileResult {
    try {
      const rebuilt = rebuildRunDetail(this.getSwarmLedgerByRun(runId));
      let stored: SwarmRunDetail | null = null;
      try {
        stored = this.swarmTraceRepo.getRunDetail(runId);
      } catch {
        stored = null;
      }
      return reconcileRun(rebuilt, stored, runId);
    } catch {
      return { runId, match: false, drift: [], note: 'reconcile-error' };
    }
  }

  /** 某会话的执行生命周期事件（一本账执行 lane 源）。fail-safe，失败返回空。 */
  getToolExecutionsBySession(sessionId: string, limit = 200) {
    if (!this.db || !this.toolExecutionEventRepo) return [];
    try {
      return this.toolExecutionEventRepo.getBySession(sessionId, limit);
    } catch {
      return [];
    }
  }

  /** 某会话的权限决策（一本账决策 lane 源）。fail-safe，失败返回空。 */
  getPermissionDecisionsBySession(sessionId: string, limit = 200): PermissionDecisionRecord[] {
    if (!this.db || !this.permissionDecisionRepo) return [];
    try {
      return this.permissionDecisionRepo.getBySession(sessionId, limit);
    } catch {
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // Session Ledger（ADR-022 §四第三期 3a · ADR-023 P2 读侧逻辑投影）
  // --------------------------------------------------------------------------

  /** 给定 run id 集合，读出各 run 的内部事件（协同 lane 细粒度时间线）。fail-safe。 */
  private readSwarmEventsForRuns(runIds: string[]): SwarmRunEventRecord[] {
    const events: SwarmRunEventRecord[] = [];
    for (const runId of runIds) {
      try {
        const detail = this.swarmTraceRepo.getRunDetail(runId);
        if (detail) events.push(...detail.events);
      } catch {
        // 单个 run 明细读失败跳过，不影响其余
      }
    }
    return events;
  }

  /**
   * 一本账会话复盘（ADR-022 第三期招牌证据）：把一个会话的各 append-only 小账本
   * + 成本，按时间合并成统一时间线读出。**纯只读**，不落地成表、不动任何写路径。
   * 每条 lane 各自 fail-safe（单 lane 读失败只让该 lane 为空，整本账仍返回）。
   * @param generatedAt 本账生成时刻（毫秒，可选；用于确定性测试，未传则 Date.now()）
   */
  getSessionLedger(sessionId: string, generatedAt: number = Date.now()): SessionLedger {
    const safe = <T>(read: () => T[]): T[] => {
      try {
        const v = read();
        return Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    };
    const swarmRuns = readSwarmRunsForSession(this.db, sessionId);
    const sources: LedgerSources = {
      messages: safe(() => this.getMessages(sessionId, 500)),
      taskEvents: safe(() => this.getSessionTaskEvents(sessionId, { limit: 200 })),
      swarmRuns,
      swarmEvents: this.readSwarmEventsForRuns(swarmRuns.map((r) => r.id)),
      decisions: this.getPermissionDecisionsBySession(sessionId),
      executions: this.getToolExecutionsBySession(sessionId),
      cost: readSessionCost(this.db, sessionId),
    };
    return buildSessionLedger(sessionId, sources, generatedAt);
  }

  // --------------------------------------------------------------------------
  // Utility
  // --------------------------------------------------------------------------

  close(): void {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this._initPromise = null;
    this._initFailed = false;
  }

  async dispose(): Promise<void> {
    this.close();
  }

  /**
   * 获取数据库统计信息
   */
  getStats(): {
    sessionCount: number;
    messageCount: number;
    toolExecutionCount: number;
    knowledgeCount: number;
  } {
    if (!this.db) throw new Error('Database not initialized');

    const sessionRow = this.db.prepare('SELECT COUNT(*) as c FROM sessions').get() as Record<string, unknown>;
    const messageRow = this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as Record<string, unknown>;
    const toolRow = this.db.prepare('SELECT COUNT(*) as c FROM tool_executions').get() as Record<string, unknown>;
    const knowledgeRow = this.db.prepare('SELECT COUNT(*) as c FROM project_knowledge').get() as Record<string, unknown>;

    return {
      sessionCount: sessionRow.c as number,
      messageCount: messageRow.c as number,
      toolExecutionCount: toolRow.c as number,
      knowledgeCount: knowledgeRow.c as number
    };
  }

  // ==========================================================================
  // Turn Snapshots — 调试快照（CLI ↔ Electron 共享同一张表）
  // ==========================================================================

  insertTurnSnapshot(input: { sessionId: string; turnId?: string | null; turnIndex: number; contextChunks?: unknown; tokenBreakdown?: unknown; createdAt?: number }): { id: string; createdAt: number; byteSize: number } {
    this.ensureDb();
    const id = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const createdAt = input.createdAt ?? Date.now();
    const contextJson = input.contextChunks ? JSON.stringify(input.contextChunks) : null;
    const tokenJson = input.tokenBreakdown ? JSON.stringify(input.tokenBreakdown) : null;
    const byteSize = (contextJson ? Buffer.byteLength(contextJson, 'utf8') : 0) + (tokenJson ? Buffer.byteLength(tokenJson, 'utf8') : 0);
    this.db!.prepare(
      `INSERT INTO turn_snapshots (id, session_id, turn_id, turn_index, context_chunks, token_breakdown, byte_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.sessionId, input.turnId ?? null, input.turnIndex, contextJson, tokenJson, byteSize, createdAt);
    return { id, createdAt, byteSize };
  }

  getSnapshotStats(): {
    snapshotCount: number;
    sessionCount: number;
    totalBytes: number;
  } {
    this.ensureDb();
    const row = this.db!.prepare(`SELECT COUNT(*) AS c, COUNT(DISTINCT session_id) AS sc, COALESCE(SUM(byte_size), 0) AS bytes FROM turn_snapshots`).get() as { c: number; sc: number; bytes: number } | undefined;
    return {
      snapshotCount: row?.c ?? 0,
      sessionCount: row?.sc ?? 0,
      totalBytes: row?.bytes ?? 0
    };
  }

  clearSnapshots(opts: { olderThanMs?: number; sessionId?: string } = {}): number {
    this.ensureDb();
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.olderThanMs !== undefined) {
      conditions.push('created_at < ?');
      params.push(Date.now() - opts.olderThanMs);
    }
    if (opts.sessionId) {
      conditions.push('session_id = ?');
      params.push(opts.sessionId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = this.db!.prepare(`DELETE FROM turn_snapshots ${where}`).run(...params);
    return result.changes;
  }

  // -- Compaction Snapshots --
  insertCompactionSnapshot(input: { sessionId: string; strategy?: string | null; preMessageCount: number; postMessageCount: number; preTokens: number; postTokens: number; savedTokens: number; usagePercent?: number | null; preMessagesSummary?: unknown; postMessagesSummary?: unknown; createdAt?: number; shapeHashBefore?: string | null; shapeHashAfter?: string | null }): { id: string; createdAt: number; byteSize: number } {
    this.ensureDb();
    const id = `compact_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const createdAt = input.createdAt ?? Date.now();
    const preJson = input.preMessagesSummary ? JSON.stringify(input.preMessagesSummary) : null;
    const postJson = input.postMessagesSummary ? JSON.stringify(input.postMessagesSummary) : null;
    const byteSize = (preJson ? Buffer.byteLength(preJson, 'utf8') : 0) + (postJson ? Buffer.byteLength(postJson, 'utf8') : 0);
    this.db!.prepare(
      `INSERT INTO compaction_snapshots (id, session_id, strategy, pre_message_count, post_message_count, pre_tokens, post_tokens, saved_tokens, usage_percent, pre_messages_summary, post_messages_summary, byte_size, created_at, shape_hash_before, shape_hash_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.sessionId, input.strategy ?? null, input.preMessageCount, input.postMessageCount, input.preTokens, input.postTokens, input.savedTokens, input.usagePercent ?? null, preJson, postJson, byteSize, createdAt, input.shapeHashBefore ?? null, input.shapeHashAfter ?? null);
    return { id, createdAt, byteSize };
  }

  getCompactionStats(): {
    snapshotCount: number;
    sessionCount: number;
    totalBytes: number;
  } {
    this.ensureDb();
    const row = this.db!.prepare(`SELECT COUNT(*) AS c, COUNT(DISTINCT session_id) AS sc, COALESCE(SUM(byte_size), 0) AS bytes FROM compaction_snapshots`).get() as { c: number; sc: number; bytes: number } | undefined;
    return {
      snapshotCount: row?.c ?? 0,
      sessionCount: row?.sc ?? 0,
      totalBytes: row?.bytes ?? 0
    };
  }

  clearCompactionSnapshots(opts: { olderThanMs?: number; sessionId?: string } = {}): number {
    this.ensureDb();
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.olderThanMs !== undefined) {
      conditions.push('created_at < ?');
      params.push(Date.now() - opts.olderThanMs);
    }
    if (opts.sessionId) {
      conditions.push('session_id = ?');
      params.push(opts.sessionId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = this.db!.prepare(`DELETE FROM compaction_snapshots ${where}`).run(...params);
    return result.changes;
  }

  listTurnSnapshots(
    sessionId: string,
    limit: number = 100
  ): Array<{
    id: string;
    sessionId: string;
    turnId: string | null;
    turnIndex: number;
    contextChunks: unknown;
    tokenBreakdown: unknown;
    byteSize: number;
    createdAt: number;
  }> {
    this.ensureDb();
    const rows = this.db!.prepare(`SELECT * FROM turn_snapshots WHERE session_id = ? ORDER BY turn_index ASC, created_at ASC LIMIT ?`).all(sessionId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      turnId: row.turn_id == null ? null : String(row.turn_id),
      turnIndex: Number(row.turn_index ?? 0),
      contextChunks: parseJsonValue(row.context_chunks),
      tokenBreakdown: parseJsonValue(row.token_breakdown),
      byteSize: Number(row.byte_size ?? 0),
      createdAt: Number(row.created_at ?? 0)
    }));
  }

  // ==========================================================================
  // Facade Methods — 委托给 Repository
  // ==========================================================================

  private _ensureDbWarned = false;
  protected ensureDb(): void {
    if (!this.db) {
      if (!this._ensureDbWarned) {
        this._ensureDbWarned = true;
        logger.warn('Database not initialized — DB operations will be skipped. ' + (this._retryCount < this.MAX_RETRIES ? `Auto-retry in progress (${this._retryCount}/${this.MAX_RETRIES}).` : 'All retries exhausted. Restart the app to recover.'));
      }
      throw new Error('Database not initialized');
    }
    // DB 恢复后重置警告标记
    if (this._ensureDbWarned) {
      this._ensureDbWarned = false;
      logger.info('Database connection restored — operations resumed');
    }
  }

  // --- SessionRepository ---
  createSession(session: Session): void {
    this.ensureDb();
    this.sessionRepo.createSession(session);
  }
  createSessionWithId(
    id: string,
    data: {
      title: string;
      userId?: string | null;
      modelConfig: { provider: ModelProvider; model: string };
      workingDirectory?: string;
      type?: Session['type'];
      origin?: Session['origin'];
	      parentSessionId?: string;
	      sourceRunId?: string;
	      engine?: Session['engine'];
	      metadata?: Session['metadata'];
	      readOnly?: boolean;
      retryOfSessionId?: string;
      createdAt?: number | string;
      updatedAt?: number | string;
      isDeleted?: boolean;
    },
    options?: { syncOrigin?: 'local' | 'remote' }
  ): void {
    this.ensureDb();
    this.sessionRepo.createSessionWithId(id, data, options);
  }
  getSession(sessionId: string, options?: { includeDeleted?: boolean; userId?: string | null }): import('./repositories').StoredSession | null {
    this.ensureDb();
    return this.sessionRepo.getSession(sessionId, options);
  }
  listSessions(limit: number = 50, offset: number = 0, includeArchived: boolean = false, userId?: string | null): import('./repositories').StoredSession[] {
    this.ensureDb();
    return this.sessionRepo.listSessions(limit, offset, includeArchived, userId);
  }
  updateSession(sessionId: string, updates: Partial<Session>, options?: { syncOrigin?: 'local' | 'remote'; isDeleted?: boolean }): void {
    this.ensureDb();
    this.sessionRepo.updateSession(sessionId, updates, options);
  }
  patchSessionMetadata(
    sessionId: string,
    patch: Record<string, unknown>,
    options?: { modelConfig?: { provider: string; model: string }; updatedAt?: number },
  ): boolean {
    this.ensureDb();
    return this.sessionRepo.patchSessionMetadata(sessionId, patch, options);
  }
  deleteSession(sessionId: string, options?: { syncOrigin?: 'local' | 'remote'; deletedAt?: number }): void {
    this.ensureDb();
    this.sessionRepo.deleteSession(sessionId, options);
  }
  updateSessionPlanTitle(sessionId: string, planTitle: string | null, updatedAt?: number): void {
    this.ensureDb();
    this.sessionRepo.updateSessionPlanTitle(sessionId, planTitle, updatedAt);
  }
  getSessionPlanTitle(sessionId: string): string | null {
    this.ensureDb();
    return this.sessionRepo.getSessionPlanTitle(sessionId);
  }
  clearAllSessions(): number {
    this.ensureDb();
    return this.sessionRepo.clearAllSessions();
  }
  markCrashedActiveSessions(now?: number): {
    interrupted: number;
    orphaned: number;
  } {
    this.ensureDb();
    return this.sessionRepo.markCrashedActiveSessions(now);
  }
  clearAllMessages(): number {
    this.ensureDb();
    return this.sessionRepo.clearAllMessages();
  }
  hasMessages(sessionId: string): boolean {
    this.ensureDb();
    return this.sessionRepo.hasMessages(sessionId);
  }
  getLocalCacheStats(): { sessionCount: number; messageCount: number } {
    this.ensureDb();
    return this.sessionRepo.getLocalCacheStats();
  }
  addMessage(
    sessionId: string,
    message: Message,
    options?: {
      skipTimestampUpdate?: boolean;
      syncOrigin?: 'local' | 'remote';
      syncedAt?: number | null;
    }
  ): void {
    this.ensureDb();
    this.sessionRepo.addMessage(sessionId, message, options);
  }
  replaceMessages(sessionId: string, messages: Message[], updatedAt?: number): void {
    this.ensureDb();
    this.sessionRepo.replaceMessages(sessionId, messages, updatedAt);
  }
  updateMessage(messageId: string, updates: Partial<Message>, sessionId?: string): void {
    this.ensureDb();
    this.sessionRepo.updateMessage(messageId, updates, sessionId);
  }
  getMessages(sessionId: string, limit?: number, offset?: number, options?: { includeRewound?: boolean }): Message[] {
    this.ensureDb();
    return this.sessionRepo.getMessages(sessionId, limit, offset, options);
  }
  getMessageCount(sessionId: string, options?: { includeRewound?: boolean }): number {
    this.ensureDb();
    return this.sessionRepo.getMessageCount(sessionId, options);
  }
  getRecentMessages(sessionId: string, count: number, options?: { includeRewound?: boolean }): Message[] {
    this.ensureDb();
    return this.sessionRepo.getRecentMessages(sessionId, count, options);
  }
  getMessagesBefore(sessionId: string, beforeTimestamp: number, limit: number = 30, options?: { includeRewound?: boolean }): Message[] {
    this.ensureDb();
    return this.sessionRepo.getMessagesBefore(sessionId, beforeTimestamp, limit, options);
  }
  getMessageById(sessionId: string, messageId: string, options?: { includeRewound?: boolean }): Message | null {
    this.ensureDb();
    return this.sessionRepo.getMessageById(sessionId, messageId, options);
  }
  async captureSessionForkAnchorEvidence(
    sessionId: string,
    messageId: string,
  ): Promise<import('./repositories').SessionForkAnchorEvidenceRecord | null> {
    this.ensureDb();
    const source = this.getSession(sessionId);
    const message = this.getMessageById(sessionId, messageId, { includeRewound: true });
    if (!source || !message || !isCompletedSessionForkAnchor(message)) return null;

    const existing = this.sessionForkWorkspaceRepo.getAnchorEvidence(sessionId, messageId);
    if (existing?.status === 'complete') return existing;

    const messageDigest = digestSessionForkAnchorMessage(message);
    let capturedScopeVersion: string | null = null;
    let capturedSourceIdentity: Record<string, unknown> | null = null;
    let capturedSourceIdentityDigest: string | null = null;
    let capturedRepositoryRoot = source.workingDirectory
      ? path.resolve(source.workingDirectory)
      : null;
    const baseRecord = {
      sourceSessionId: sessionId,
      anchorMessageId: messageId,
      ownerUserId: source.userId ?? null,
      projectId: source.projectId ?? null,
      workspaceScopeVersion: capturedScopeVersion,
      sourceIdentityDigest: capturedSourceIdentityDigest,
      sourceIdentity: capturedSourceIdentity,
      messageDigest,
      repositoryRoot: capturedRepositoryRoot,
    };

    try {
      if (!source.projectId) {
        throw Object.assign(new Error('anchor session has no Project boundary'), {
          code: 'PROJECT_SCOPE_REQUIRED',
        });
      }
      const { getProjectService } = await import('../project/projectService');
      const scope = getProjectService().getWorkspaceScope(source.projectId);
      if (!scope) {
        throw Object.assign(new Error('the Project has no trusted WorkspaceScope'), {
          code: 'WORKSPACE_SCOPE_REQUIRED',
        });
      }
      capturedScopeVersion = scope.version;
      capturedSourceIdentity = forkWorkspaceSourceIdentity(scope);
      capturedSourceIdentityDigest = digestWorkspaceValue(capturedSourceIdentity);
      capturedRepositoryRoot = fs.realpathSync.native(scope.primaryRoot);
      if (scope.roots.length !== 1) {
        throw Object.assign(
          new Error('isolated_at_anchor cannot atomically reconstruct multiple Project sources'),
          { code: 'MULTI_SOURCE_ATOMIC_RECONSTRUCTION_UNSUPPORTED' },
        );
      }
      const primary = scope.roots[0];
      if (primary.role !== 'primary' || path.resolve(primary.path) !== path.resolve(scope.primaryRoot)) {
        throw Object.assign(new Error('WorkspaceScope has no single trustworthy primary source'), {
          code: 'PRIMARY_SOURCE_REQUIRED',
        });
      }
      const repositoryRoot = capturedRepositoryRoot;
      const runner = new NodeWorkspaceCommandRunner();
      const explicitHead = (await runner.run({
        executable: 'git',
        args: ['rev-parse', '--verify', 'HEAD'],
        cwd: repositoryRoot,
      })).stdout.toString('utf8').trim();
      const evidence = await new AnchorWorkspaceEvidenceService({ runner }).capture({
        anchorId: messageId,
        repositoryRoot,
        baseCommit: explicitHead,
        workspaceScopeVersion: scope.version,
        pathMappings: [{
          sourceId: primary.sourceId,
          sourcePath: repositoryRoot,
          isolatedRelativePath: '.',
        }],
      });
      return this.sessionForkWorkspaceRepo.recordAnchorEvidence({
        ...baseRecord,
        workspaceScopeVersion: scope.version,
        sourceIdentityDigest: capturedSourceIdentityDigest,
        sourceIdentity: capturedSourceIdentity,
        repositoryRoot,
        evidence,
        status: 'complete',
        blockedReason: null,
        summary: {
          baseCommit: evidence.manifest.baseCommit,
          observedHead: evidence.manifest.observedHead,
          stagedPatch: evidence.manifest.stagedPatch,
          unstagedPatch: evidence.manifest.unstagedPatch,
          untrackedManifest: evidence.manifest.untrackedFiles.map((file) => ({
            path: file.path,
            sha256: file.sha256,
            sizeBytes: file.sizeBytes,
            mode: file.mode,
          })),
          pathMappings: evidence.manifest.pathMappings,
        },
      });
    } catch (error) {
      const failure = sessionForkFailure(error);
      logger.warn('[DatabaseService] Session Fork anchor evidence blocked:', {
        sessionId,
        messageId,
        code: failure.code,
      });
      return this.sessionForkWorkspaceRepo.recordAnchorEvidence({
        ...baseRecord,
        workspaceScopeVersion: capturedScopeVersion,
        sourceIdentityDigest: capturedSourceIdentityDigest,
        sourceIdentity: capturedSourceIdentity,
        repositoryRoot: capturedRepositoryRoot,
        evidence: null,
        status: 'blocked',
        blockedReason: `${String(failure.code)}: ${String(failure.message)}`,
        summary: { failure },
      });
    }
  }
  getSessionForkAnchorEvidence(
    sessionId: string,
    messageId: string,
    ownerUserId?: string | null,
  ): import('./repositories').SessionForkAnchorEvidenceRecord | null {
    this.ensureDb();
    return this.sessionForkWorkspaceRepo.getAnchorEvidence(sessionId, messageId, ownerUserId);
  }
  getSessionForkWorkspaceScope(
    sessionId: string,
    ownerUserId?: string | null,
  ): WorkspaceScope | null {
    this.ensureDb();
    const rawDb = this.db;
    if (!rawDb) throw new Error('Database not initialized');
    const forkKind = rawDb.prepare(`
      SELECT workspace_mode
      FROM session_forks
      WHERE child_session_id = ?
      LIMIT 1
    `).get(sessionId) as { workspace_mode: string } | undefined;
    if (forkKind?.workspace_mode !== 'isolated_at_anchor') return null;

    const ownerPredicate = ownerUserId === undefined
      ? ''
      : ownerUserId === null
        ? ' AND child.user_id IS NULL AND source.user_id IS NULL'
        : ' AND child.user_id = ? AND source.user_id = ?';
    const ownerParams = typeof ownerUserId === 'string'
      ? [ownerUserId, ownerUserId]
      : [];
    const row = rawDb.prepare(`
      SELECT
        child.metadata AS child_metadata,
        child.working_directory AS child_working_directory,
        child.agent_engine AS child_agent_engine,
        child.project_id AS child_project_id,
        child.is_deleted AS child_is_deleted,
        fork.id AS fork_id,
        fork.status AS fork_status,
        fork.workspace_snapshot_id AS fork_workspace_snapshot_id,
        fork.anchor_message_id AS fork_anchor_message_id,
        saga.intent_id AS saga_intent_id,
        saga.evidence_id AS saga_evidence_id,
        saga.state AS saga_state,
        saga.workspace_path AS saga_workspace_path,
        saga.child_session_id AS saga_child_session_id,
        evidence.id AS evidence_id,
        evidence.anchor_message_id AS evidence_anchor_message_id,
        evidence.project_id AS evidence_project_id,
        evidence.workspace_scope_version AS evidence_workspace_scope_version,
        evidence.source_identity_digest AS evidence_source_identity_digest,
        evidence.source_identity_json AS evidence_source_identity_json,
        evidence.repository_root AS evidence_repository_root,
        evidence.base_commit AS evidence_base_commit,
        evidence.evidence_digest AS evidence_digest,
        evidence.evidence_json AS evidence_json,
        evidence.status AS evidence_status,
        intent.status AS intent_status,
        intent.advertisable AS intent_advertisable
      FROM session_forks AS fork
      JOIN sessions AS child ON child.id = fork.child_session_id
      JOIN sessions AS source ON source.id = fork.source_session_id
      LEFT JOIN session_fork_workspace_sagas AS saga
        ON saga.intent_id = fork.workspace_snapshot_id
      LEFT JOIN session_fork_anchor_evidence AS evidence
        ON evidence.id = saga.evidence_id
      LEFT JOIN session_fork_workspace_intents AS intent
        ON intent.intent_id = saga.intent_id
      WHERE fork.child_session_id = ?
        ${ownerPredicate}
      LIMIT 1
    `).get(sessionId, ...ownerParams) as Record<string, unknown> | undefined;
    if (!row) {
      throw new SessionForkError(
        'SESSION_NOT_FOUND',
        'the isolated child is outside the current owner boundary',
      );
    }

    let projection: ReturnType<typeof projectChildWorkspaceScope>;
    try {
      projection = projectChildWorkspaceScope(parseJsonValue(row.child_metadata));
    } catch (error) {
      throw new SessionForkError(
        'WORKSPACE_IDENTITY_DRIFT',
        `the isolated child WorkspaceScope metadata is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const engine = parseJsonValue(row.child_agent_engine);
    const engineCwd = engine && typeof engine === 'object' && !Array.isArray(engine)
      ? (engine as Record<string, unknown>).cwd
      : null;
    const evidence = parseJsonValue(row.evidence_json);
    const evidenceManifest = evidence && typeof evidence === 'object' && !Array.isArray(evidence)
      ? (evidence as { manifest?: unknown }).manifest
      : null;
    const manifest = evidenceManifest && typeof evidenceManifest === 'object' && !Array.isArray(evidenceManifest)
      ? evidenceManifest as Record<string, unknown>
      : null;
    const storedSourceIdentity = parseJsonValue(row.evidence_source_identity_json);
    const expectedMappings = Array.isArray(manifest?.pathMappings)
      ? manifest.pathMappings.map((mapping) => {
        const value = mapping as Record<string, unknown>;
        return {
          sourceId: value.sourceId,
          sourcePath: value.sourcePath,
          sourceRelativePath: value.repositoryRelativePath,
          isolatedRelativePath: value.isolatedRelativePath,
        };
      })
      : null;
    const matches = Boolean(
      projection
      && Number(row.child_is_deleted) === 0
      && row.fork_status === 'completed'
      && row.saga_state === 'completed'
      && row.evidence_status === 'complete'
      && row.intent_status === 'advertised'
      && Number(row.intent_advertisable) === 1
      && projection.verification.forkId === row.fork_id
      && projection.verification.intentId === row.fork_workspace_snapshot_id
      && projection.verification.intentId === row.saga_intent_id
      && projection.verification.evidenceId === row.saga_evidence_id
      && projection.verification.evidenceId === row.evidence_id
      && projection.verification.projectId === row.child_project_id
      && projection.verification.projectId === row.evidence_project_id
      && projection.verification.sourceWorkspaceScopeVersion === row.evidence_workspace_scope_version
      && projection.verification.sourcePrimaryRoot === row.evidence_repository_root
      && projection.verification.isolatedPrimaryRoot === row.child_working_directory
      && projection.verification.isolatedPrimaryRoot === row.saga_workspace_path
      && projection.verification.baseCommit === row.evidence_base_commit
      && projection.verification.evidenceDigest === row.evidence_digest
      && row.saga_child_session_id === sessionId
      && row.fork_anchor_message_id === row.evidence_anchor_message_id
      && engineCwd === projection.verification.isolatedPrimaryRoot
      && storedSourceIdentity
      && digestWorkspaceValue(storedSourceIdentity) === row.evidence_source_identity_digest
      && digestWorkspaceValue(projection.provenance.sourceIdentity)
        === digestWorkspaceValue(storedSourceIdentity)
      && expectedMappings
      && digestWorkspaceValue(projection.provenance.pathMappings)
        === digestWorkspaceValue(expectedMappings)
    );
    if (!matches || !projection) {
      throw new SessionForkError(
        'WORKSPACE_IDENTITY_DRIFT',
        'the isolated child WorkspaceScope projection does not match its completed durable evidence',
      );
    }
    return projection.scope;
  }
  async createIsolatedSessionFork(
    input: import('./repositories').CreateForkRepositoryInput,
  ): Promise<import('./repositories').CreateForkRepositoryResult> {
    this.ensureDb();
    const source = this.getSession(input.sourceSessionId, input.ownerUserId === undefined
      ? undefined
      : { userId: input.ownerUserId });
    const anchor = this.getMessageById(
      input.sourceSessionId,
      input.anchorAssistantMessageId,
      { includeRewound: true },
    );
    if (!source || !anchor) {
      throw new SessionForkError('INVALID_ANCHOR', 'isolated fork source or anchor was not found');
    }
    const evidenceRecord = this.sessionForkWorkspaceRepo.getAnchorEvidence(
      input.sourceSessionId,
      input.anchorAssistantMessageId,
      input.ownerUserId,
    );
    if (
      evidenceRecord?.status !== 'complete'
      || !evidenceRecord.evidence
      || !evidenceRecord.repositoryRoot
      || !evidenceRecord.projectId
      || !evidenceRecord.workspaceScopeVersion
      || !evidenceRecord.sourceIdentityDigest
    ) {
      throw new SessionForkError(
        'EVIDENCE_INCOMPLETE',
        evidenceRecord?.blockedReason ?? 'the anchor has no complete workspace evidence',
      );
    }
    if (
      !isCompletedSessionForkAnchor(anchor)
      || digestSessionForkAnchorMessage(anchor) !== evidenceRecord.messageDigest
    ) {
      throw new SessionForkError(
        'EVIDENCE_INCOMPLETE',
        'the anchor message no longer matches its sealed workspace evidence',
      );
    }
    if (source.projectId !== evidenceRecord.projectId) {
      throw new SessionForkError('EVIDENCE_INCOMPLETE', 'the source Project changed after anchor capture');
    }

    const { getProjectService } = await import('../project/projectService');
    let scope: WorkspaceScope | undefined;
    try {
      scope = getProjectService().getWorkspaceScope(evidenceRecord.projectId);
    } catch (error) {
      throw new SessionForkError(
        'EVIDENCE_INCOMPLETE',
        `the current WorkspaceScope identity is not trustworthy: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      scope?.roots.length !== 1
      || scope.version !== evidenceRecord.workspaceScopeVersion
      || digestWorkspaceValue(forkWorkspaceSourceIdentity(scope)) !== evidenceRecord.sourceIdentityDigest
      || fs.realpathSync.native(scope.primaryRoot) !== evidenceRecord.repositoryRoot
    ) {
      throw new SessionForkError(
        'EVIDENCE_INCOMPLETE',
        'the current Project/WorkspaceScope does not match the anchor evidence',
      );
    }

    await new AnchorWorkspaceEvidenceService().validateBundle(evidenceRecord.evidence);
    const requestDigest = digestWorkspaceValue({
      sourceSessionId: input.sourceSessionId,
      anchorAssistantMessageId: input.anchorAssistantMessageId,
      idempotencyKey: input.idempotencyKey,
      workspaceMode: 'isolated_at_anchor',
      contextDeliveryMode: input.contextDeliveryMode,
      evidenceId: evidenceRecord.id,
      evidenceDigest: evidenceRecord.evidenceDigest,
    });
    const saga = this.sessionForkWorkspaceRepo.beginSaga({
      sourceSessionId: input.sourceSessionId,
      anchorMessageId: input.anchorAssistantMessageId,
      idempotencyKey: input.idempotencyKey,
      requestDigest,
      evidenceId: evidenceRecord.id,
      proposedForkId: input.forkId,
      proposedChildSessionId: input.childSessionId,
      contextDeliveryMode: input.contextDeliveryMode,
      childTitle: input.childTitle,
      now: input.now,
    });

    let childStaged = saga.state === 'child_staged';
    let workspaceAdvertised = false;
    try {
      const prepared = await this.isolatedAnchorWorkspaceService.prepare({
        intentId: saga.intentId,
        sourceSessionId: saga.sourceSessionId,
        proposedChildSessionId: saga.proposedChildSessionId,
        repositoryRoot: evidenceRecord.repositoryRoot,
        destinationName: saga.proposedChildSessionId,
        evidence: evidenceRecord.evidence,
      });
      this.sessionForkWorkspaceRepo.markSagaWorkspaceReady(
        saga.intentId,
        prepared.workspacePath,
        input.now,
      );
      const result = this.sessionForkWorkspaceRepo.stageChild(
        saga.intentId,
        (stagedSaga) => this.sessionForkRepo.createFork({
          ...input,
          forkId: stagedSaga.proposedForkId,
          childSessionId: stagedSaga.proposedChildSessionId,
          childTitle: stagedSaga.childTitle,
          workspaceMode: 'isolated_at_anchor',
          childWorkingDirectory: prepared.workspacePath,
          workspaceSnapshotId: stagedSaga.intentId,
        }),
        input.now,
      );
      childStaged = true;
      await this.isolatedAnchorWorkspaceService.markAdvertised(saga.intentId);
      workspaceAdvertised = true;
      this.sessionForkWorkspaceRepo.finalizeSaga(saga.intentId, input.now);
      return result;
    } catch (error) {
      const failure = sessionForkFailure(error);
      if (childStaged && !workspaceAdvertised) {
        this.sessionForkWorkspaceRepo.quarantineSaga(saga.intentId, failure, input.now);
        await this.isolatedAnchorWorkspaceService
          .recoverIntent(saga.intentId, { strategy: 'cleanup' })
          .catch(() => undefined);
      } else if (!childStaged) {
        const cleanup = await this.isolatedAnchorWorkspaceService
          .recoverIntent(saga.intentId, { strategy: 'cleanup' })
          .catch((cleanupError: unknown) => ({
            intentId: saga.intentId,
            outcome: 'failed' as const,
            workspacePath: '',
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          }));
        if (cleanup.outcome === 'failed') {
          this.sessionForkWorkspaceRepo.recordSagaError(saga.intentId, {
            ...failure,
            cleanupError: cleanup.error,
          }, input.now);
        } else {
          this.sessionForkWorkspaceRepo.abortSaga(saga.intentId, failure, input.now);
        }
      }
      throw error instanceof SessionForkError
        ? error
        : new SessionForkError(
          'FORK_OPERATION_FAILED',
          `isolated workspace fork failed closed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
  }
  createSessionFork(
    input: import('./repositories').CreateForkRepositoryInput,
  ): import('./repositories').CreateForkRepositoryResult {
    this.ensureDb();
    return this.sessionForkRepo.createFork(input);
  }
  getSessionForkLineage(
    sessionId: string,
    ownerUserId?: string | null,
  ): import('../../../shared/contract/sessionFork').SessionForkLineageSummary | null {
    this.ensureDb();
    return this.sessionForkRepo.getLineage(sessionId, ownerUserId);
  }
  listSessionForkChildren(
    sessionId: string,
    ownerUserId?: string | null,
  ): import('../../../shared/contract/sessionFork').SessionForkLineageSummary[] {
    this.ensureDb();
    return this.sessionForkRepo.listChildren(sessionId, ownerUserId);
  }
  getSessionForkContextSource(childSessionId: string): import('./repositories').SessionForkContextSource | null {
    this.ensureDb();
    return this.sessionForkRepo.getContextSource(childSessionId);
  }
  prepareSessionForkContextHandoff(
    forkId: string,
    engine: import('../../../shared/contract/agentEngine').ExternalAgentEngineKind,
    payloadDigest: string,
    preparedAt?: number,
  ): import('./repositories').SessionForkContextHandoffRecord {
    this.ensureDb();
    return this.sessionForkRepo.prepareContextHandoff(forkId, engine, payloadDigest, preparedAt);
  }
  markSessionForkContextHandoffDispatching(
    forkId: string,
    payloadDigest: string,
    attemptId: string,
    startedAt?: number,
  ): import('./repositories').SessionForkContextHandoffRecord {
    this.ensureDb();
    return this.sessionForkRepo.markContextHandoffDispatching(forkId, payloadDigest, attemptId, startedAt);
  }
  markSessionForkContextHandoffConsumed(
    forkId: string,
    payloadDigest: string,
    attemptId: string,
    consumedAt?: number,
  ): import('./repositories').SessionForkContextHandoffRecord {
    this.ensureDb();
    return this.sessionForkRepo.markContextHandoffConsumed(forkId, payloadDigest, attemptId, consumedAt);
  }
  applyPromptRewind(sessionId: string, userMessageId: string, record?: import('./repositories/SessionRepository').PromptRewindRecordInput): import('./repositories/SessionRepository').PromptRewindResult {
    this.ensureDb();
    return this.sessionRepo.applyPromptRewind(sessionId, userMessageId, record);
  }
  restorePromptRewind(
    sessionId: string,
    rewindId: string,
    restoredAt?: number,
    ownerUserId?: string | null,
  ): import('./repositories/SessionRepository').PromptRewindRestoreResult {
    this.ensureDb();
    return this.sessionRepo.restorePromptRewind(sessionId, rewindId, restoredAt, ownerUserId);
  }
  getUnsyncedSessions(limit: number = 1000): import('./repositories').StoredSession[] {
    this.ensureDb();
    return this.sessionRepo.getUnsyncedSessions(limit);
  }
  markSessionsSynced(sessionIds: string[]): void {
    this.ensureDb();
    this.sessionRepo.markSessionsSynced(sessionIds);
  }
  getUnsyncedMessages(limit: number = 1000): Array<Message & { sessionId: string }> {
    this.ensureDb();
    return this.sessionRepo.getUnsyncedMessages(limit);
  }
  markMessagesSynced(messageIds: string[]): void {
    this.ensureDb();
    this.sessionRepo.markMessagesSynced(messageIds);
  }
  saveTodos(sessionId: string, todos: TodoItem[], updatedAt?: number): void {
    this.ensureDb();
    this.sessionRepo.saveTodos(sessionId, todos, updatedAt);
  }
  getTodos(sessionId: string): TodoItem[] {
    this.ensureDb();
    return this.sessionRepo.getTodos(sessionId);
  }
  saveSessionTasks(sessionId: string, tasks: SessionTask[], updatedAt?: number): void {
    this.ensureDb();
    this.sessionRepo.saveSessionTasks(sessionId, tasks, updatedAt);
  }
  getSessionTasks(sessionId: string): SessionTask[] {
    this.ensureDb();
    return this.sessionRepo.getSessionTasks(sessionId);
  }
  appendSessionTaskEvents(events: Parameters<import('./repositories').SessionRepository['appendSessionTaskEvents']>[0]): void {
    this.ensureDb();
    this.sessionRepo.appendSessionTaskEvents(events);
  }
  getSessionTaskEvents(
    sessionId: string,
    options?: Parameters<import('./repositories').SessionRepository['getSessionTaskEvents']>[1]
  ): ReturnType<import('./repositories').SessionRepository['getSessionTaskEvents']> {
    this.ensureDb();
    return this.sessionRepo.getSessionTaskEvents(sessionId, options);
  }
  getMaxTopLevelTaskIdFromEvents(sessionId: string): number {
    this.ensureDb();
    return this.sessionRepo.getMaxTopLevelTaskIdFromEvents(sessionId);
  }
  saveContextIntervention(sessionId: string, agentId: string | null | undefined, messageId: string, action: ContextInterventionAction | null, updatedAt?: number): void {
    this.ensureDb();
    this.sessionRepo.saveContextIntervention(sessionId, agentId, messageId, action, updatedAt);
  }
  getContextInterventions(sessionId: string, agentId?: string | null): ContextInterventionSnapshot {
    this.ensureDb();
    return this.sessionRepo.getContextInterventions(sessionId, agentId);
  }
  saveSessionRuntimeState(
    sessionId: string,
    state: {
      compressionStateJson?: string | null;
      persistentSystemContext?: string[];
    },
    updatedAt?: number
  ): void {
    this.ensureDb();
    this.sessionRepo.saveSessionRuntimeState(sessionId, state, updatedAt);
  }
  getSessionRuntimeState(sessionId: string): {
    compressionStateJson: string | null;
    persistentSystemContext: string[];
  } | null {
    this.ensureDb();
    return this.sessionRepo.getSessionRuntimeState(sessionId);
  }
  listArchivedSessions(limit: number = 50, offset: number = 0, userId?: string | null): import('./repositories').StoredSession[] {
    this.ensureDb();
    return this.sessionRepo.listArchivedSessions(limit, offset, userId);
  }
  archiveSession(sessionId: string): import('./repositories').StoredSession | null {
    this.ensureDb();
    return this.sessionRepo.archiveSession(sessionId);
  }
  unarchiveSession(sessionId: string): import('./repositories').StoredSession | null {
    this.ensureDb();
    return this.sessionRepo.unarchiveSession(sessionId);
  }
  searchSessionMessagesFts(
    query: string,
    options?: { limit?: number; sessionId?: string; includeRewound?: boolean }
  ): Array<{
    messageId: string;
    sessionId: string;
    role: string;
    content: string;
    timestamp: number;
  }> {
    this.ensureDb();
    return this.sessionRepo.searchSessionMessagesFts(query, options);
  }
  searchTranscriptFts(
    query: string,
    options?: Parameters<import('./repositories').SessionRepository['searchTranscriptFts']>[1]
  ): ReturnType<import('./repositories').SessionRepository['searchTranscriptFts']> {
    this.ensureDb();
    return this.sessionRepo.searchTranscriptFts(query, options);
  }
  getTranscriptAround(
    messageId: string,
    options?: Parameters<import('./repositories').SessionRepository['getTranscriptAround']>[1]
  ): ReturnType<import('./repositories').SessionRepository['getTranscriptAround']> {
    this.ensureDb();
    return this.sessionRepo.getTranscriptAround(messageId, options);
  }

  // --- MemoryRepository ---
  createMemory(data: Omit<import('./repositories').MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>): import('./repositories').MemoryRecord {
    this.ensureDb();
    return this.memoryRepo.createMemory(data);
  }
  getMemory(id: string): import('./repositories').MemoryRecord | null {
    this.ensureDb();
    return this.memoryRepo.getMemory(id);
  }
  listMemories(options?: { type?: string; category?: string; source?: string; projectPath?: string; sessionId?: string; limit?: number; offset?: number; orderBy?: string; orderDir?: 'ASC' | 'DESC' }): import('./repositories').MemoryRecord[] {
    this.ensureDb();
    return this.memoryRepo.listMemories(options);
  }
  updateMemory(id: string, updates: Partial<import('./repositories').MemoryRecord>): import('./repositories').MemoryRecord | null {
    this.ensureDb();
    return this.memoryRepo.updateMemory(id, updates);
  }
  deleteMemory(id: string): boolean {
    this.ensureDb();
    return this.memoryRepo.deleteMemory(id);
  }
  deleteMemories(filter: { type?: string; category?: string; source?: string; projectPath?: string; sessionId?: string }): number {
    this.ensureDb();
    return this.memoryRepo.deleteMemories(filter);
  }
  searchMemories(
    query: string,
    options?: {
      type?: string;
      category?: string;
      limit?: number;
      applyDecay?: boolean;
    }
  ): import('./repositories').MemoryRecord[] {
    this.ensureDb();
    return this.memoryRepo.searchMemories(query, options);
  }
  getMemoryStats(): {
    total: number;
    byType: Record<string, number>;
    bySource: Record<string, number>;
    byCategory: Record<string, number>;
  } {
    this.ensureDb();
    return this.memoryRepo.getMemoryStats();
  }
  recordMemoryAccess(id: string): void {
    this.ensureDb();
    this.memoryRepo.recordMemoryAccess(id);
  }

  // --- ConfigRepository ---
  setPreference(key: string, value: unknown): void {
    this.ensureDb();
    this.configRepo.setPreference(key, value);
  }
  getPreference<T>(key: string, defaultValue?: T): T | undefined {
    this.ensureDb();
    return this.configRepo.getPreference(key, defaultValue);
  }
  getAllPreferences(): Record<string, unknown> {
    this.ensureDb();
    return this.configRepo.getAllPreferences();
  }
  deletePreference(key: string): boolean {
    this.ensureDb();
    return this.configRepo.deletePreference(key);
  }
  saveProjectKnowledge(projectPath: string, key: string, value: unknown, source?: 'learned' | 'explicit' | 'inferred', confidence?: number): void {
    this.ensureDb();
    this.configRepo.saveProjectKnowledge(projectPath, key, value, source, confidence);
  }
  getProjectKnowledge(projectPath: string, key?: string): import('./repositories').ProjectKnowledge[] {
    this.ensureDb();
    return this.configRepo.getProjectKnowledge(projectPath, key);
  }
  getAllProjectKnowledge(): import('./repositories').ProjectKnowledge[] {
    this.ensureDb();
    return this.configRepo.getAllProjectKnowledge();
  }
  updateProjectKnowledge(id: string, content: string): boolean {
    this.ensureDb();
    return this.configRepo.updateProjectKnowledge(id, content);
  }
  deleteProjectKnowledge(id: string): boolean {
    this.ensureDb();
    return this.configRepo.deleteProjectKnowledge(id);
  }
  deleteProjectKnowledgeBySource(source: string): number {
    this.ensureDb();
    return this.configRepo.deleteProjectKnowledgeBySource(source);
  }
  logAuditEvent(eventType: string, eventData: Record<string, unknown>, sessionId?: string): void {
    this.ensureDb();
    this.configRepo.logAuditEvent(eventType, eventData, sessionId);
  }
  getAuditLog(options?: { sessionId?: string; eventType?: string; limit?: number; since?: number }): Array<{
    id: number;
    sessionId: string | null;
    eventType: string;
    eventData: Record<string, unknown>;
    createdAt: number;
  }> {
    this.ensureDb();
    return this.configRepo.getAuditLog(options);
  }
  saveToolExecution(sessionId: string, messageId: string | null, toolName: string, args: Record<string, unknown>, result: ToolResult, cacheNamespace: string, ttlMs?: number): void {
    this.ensureDb();
    this.configRepo.saveToolExecution(sessionId, messageId, toolName, args, result, cacheNamespace, ttlMs);
  }
  getCachedToolResult(sessionId: string, cacheNamespace: string, toolName: string, args: Record<string, unknown>): ToolResult | null {
    this.ensureDb();
    return this.configRepo.getCachedToolResult(sessionId, cacheNamespace, toolName, args);
  }
  invalidateCachedToolResults(sessionId: string): number {
    this.ensureDb();
    return this.configRepo.invalidateCachedToolResults(sessionId);
  }
  cleanExpiredCache(): number {
    this.ensureDb();
    return this.configRepo.cleanExpiredCache();
  }
  clearToolCache(): number {
    this.ensureDb();
    return this.configRepo.clearToolCache();
  }
  getToolCacheCount(): number {
    this.ensureDb();
    return this.configRepo.getToolCacheCount();
  }

  // --- CaptureRepository ---
  createCapture(item: CaptureItem): void {
    this.ensureDb();
    this.captureRepo.createCapture(item);
  }
  listCaptures(opts?: { source?: CaptureSource; limit?: number; offset?: number }): CaptureItem[] {
    this.ensureDb();
    return this.captureRepo.listCaptures(opts);
  }
  getCapture(id: string): CaptureItem | undefined {
    this.ensureDb();
    return this.captureRepo.getCapture(id);
  }
  deleteCapture(id: string): boolean {
    this.ensureDb();
    return this.captureRepo.deleteCapture(id);
  }
  getCaptureStats(): CaptureStats {
    this.ensureDb();
    return this.captureRepo.getCaptureStats();
  }
  searchCaptures(query: string, limit?: number): CaptureItem[] {
    this.ensureDb();
    return this.captureRepo.searchCaptures(query, limit);
  }

  // --- ExperimentRepository ---
  insertExperiment(experiment: { id: string; name: string; timestamp: number; model?: string; provider?: string; scope?: string; config_json?: string; summary_json: string; source?: string; git_commit?: string }): void {
    this.ensureDb();
    this.experimentRepo.insertExperiment(experiment);
  }
  insertExperimentCases(
    experimentId: string,
    cases: Array<{
      id: string;
      case_id: string;
      session_id?: string;
      status: string;
      score: number;
      duration_ms?: number;
      data_json?: string;
    }>
  ): void {
    this.ensureDb();
    this.experimentRepo.insertExperimentCases(experimentId, cases);
  }
  listExperiments(limit?: number): Array<{
    id: string;
    name: string;
    timestamp: number;
    model: string | null;
    provider: string | null;
    scope: string;
    config_json: string | null;
    summary_json: string;
    source: string;
    git_commit: string | null;
  }> {
    this.ensureDb();
    return this.experimentRepo.listExperiments(limit);
  }
  loadExperiment(id: string):
    | {
        experiment: {
          id: string;
          name: string;
          timestamp: number;
          model: string | null;
          provider: string | null;
          scope: string;
          config_json: string | null;
          summary_json: string;
          source: string;
          git_commit: string | null;
        };
        cases: Array<{
          id: string;
          experiment_id: string;
          case_id: string;
          session_id: string | null;
          status: string;
          score: number;
          duration_ms: number | null;
          data_json: string | null;
        }>;
      }
    | undefined {
    this.ensureDb();
    return this.experimentRepo.loadExperiment(id);
  }
  updateExperimentSummary(id: string, summaryJson: string): void {
    this.ensureDb();
    this.experimentRepo.updateExperimentSummary(id, summaryJson);
  }
  deleteExperiment(id: string): boolean {
    this.ensureDb();
    return this.experimentRepo.deleteExperiment(id);
  }

  // --- SwarmTraceRepository ---
  /**
   * 暴露 swarm trace 仓库给 SwarmTraceWriter / IPC handler 直接使用。
   * 与 experiment / capture 不同，trace 写入路径调用密度高且字段繁多，
   * 不再为每个方法包一层薄门面。
   */
  getSwarmTraceRepo(): SwarmTraceRepo {
    this.ensureDb();
    return this.swarmTraceRepo;
  }

  // --- PendingApprovalRepository ---
  /**
   * 暴露 pending_approvals 仓库给 PlanApprovalGate / SwarmLaunchApprovalGate
   * 用于 fire-and-forget 写入和启动 hydrate（ADR-010 #2）。
   */
  getPendingApprovalRepo(): PendingApprovalRepository {
    this.ensureDb();
    return this.pendingApprovalRepo;
  }

  getTurnCostRepo(): TurnCostRepository {
    this.ensureDb();
    return this.turnCostRepo;
  }

  // --- AgentWakeRepository ---
  /** self-wake 台账：agent 自发挂起-续跑的持久化记录。 */
  getAgentWakeRepo(): AgentWakeRepository {
    this.ensureDb();
    return this.agentWakeRepo;
  }

  // --- ProjectRepository ---
  /** 暴露 projects 仓库给 ProjectService / IPC handler 直接使用（P0-2 项目空间）。 */
  getProjectRepo(): ProjectRepository {
    this.ensureDb();
    return this.projectRepo;
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let dbInstance: DatabaseService | null = null;

export function getDatabase(): DatabaseService {
  if (!dbInstance) {
    dbInstance = new DatabaseService();
    getServiceRegistry().register('DatabaseService', dbInstance);
  }
  return dbInstance;
}

export async function initDatabase(): Promise<DatabaseService> {
  const db = getDatabase();
  await db.initialize();
  // P0-2：存量 session 按 workspace 自动归桶（幂等，仅当存在未归桶 session 时执行）。
  // 懒加载 ProjectService 避免初始化期循环依赖。
  try {
    const { getProjectService } = await import('../project/projectService');
    const backfillStart = performance.now();
    const migrated = getProjectService().backfillSessions(Date.now());
    if (migrated > 0) {
      logger.info(`[DatabaseService] P0-2 backfill: ${migrated} 个存量 session 已归桶到项目 (${Math.round(performance.now() - backfillStart)}ms)`);
    }
  } catch (err) {
    logger.warn('[DatabaseService] P0-2 backfill 失败（不阻塞启动）:', err instanceof Error ? err.message : String(err));
  }
  return db;
}
