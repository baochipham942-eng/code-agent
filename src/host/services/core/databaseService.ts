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
import { applyConversationBranchSchema } from './database/schemaConversationBranch';
import { applySessionForkPortabilitySchema } from './database/schemaSessionForkPortability';
import { applyIndexes } from './database/indexes';
import { ensureWalShmConsistency } from './database/walShmConsistency';
import { applySessionsMigrations, applyTelemetryTurnsMigrations, applyEvaluationCleanupMigration } from './database/migrations';
import { applyDistillSignalsMigration } from './database/migrations/distillSignals';
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

import { SessionRepository, SessionForkRepository, SessionForkWorkspaceRepository, ConversationBranchRepository, SessionForkPortabilityRepository, digestSessionForkAnchorMessage, isCompletedSessionForkAnchor, MemoryRepository, ConfigRepository, CaptureRepository, ExperimentRepository, ProjectRepository, PendingApprovalRepository, GenerativeUIRepository, PermissionDecisionRepository, type PermissionDecisionInput, type PermissionDecisionRecord, ToolExecutionEventRepository, type ToolExecutionBeginInput, type ToolExecutionCompleteInput, type OpenToolExecution, SwarmLedgerRepository, UsageLedgerRepository, type UsageLedgerEntryInput, type UsageLedgerEntry, AgentWakeRepository, TurnCostRepository } from './repositories';
import type {
  CreateForkRepositoryInput,
  CreateForkRepositoryResult,
  SessionForkContextHandoffRecord,
  SessionForkContextSource,
} from './repositories/SessionForkRepository';
import type {
  SessionForkAnchorEvidenceRecord,
} from './repositories/SessionForkWorkspaceRepository';
import type {
  EnqueueSessionForkOutboundInput,
  ExportSessionForkInput,
  FlushSessionForkOutboundOptions,
  ImportSessionForkInput,
  ImportSessionForkResult,
  IngestSessionForkInboundInput,
} from './repositories/SessionForkPortabilityRepository';
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
  ImportedPortableAnchorWorkspaceMaterializer,
  IsolatedAnchorWorkspaceService,
  NodeWorkspaceCommandRunner,
  digestWorkspaceValue,
  projectChildWorkspaceScope,
  type TrustedSingleRootGitProjectWorkspace,
} from '../sessionFork/workspace';
import type { WorkspaceScope } from '../../../shared/contract/project';
import {
  LOCAL_SESSION_FORK_OWNER_SCOPE_ID,
  type PortableIsolatedAnchorEvidenceV1,
  type PortableSessionWorkspaceV2,
} from '../../../shared/contract/sessionForkPortability';
import type { SessionForkWorkspaceMode } from '../../../shared/contract/sessionFork';
import {
  readPublishedImportedPortableWorkspace,
} from './repositories/sessionForkPublishedWorkspaceReader';

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

export interface PublishImportedIsolatedWorkspaceInput {
  importedSessionId: string;
  importedAnchorMessageId: string;
  ownerUserId: string | null;
  targetProjectId: string;
  workspaceBinding: TrustedSingleRootGitProjectWorkspace;
  portableEvidence: PortableIsolatedAnchorEvidenceV1;
  now?: number;
}

export interface PublishedImportedIsolatedWorkspace {
  sessionId: string;
  intentId: string;
  workspacePath: string;
  evidenceDigest: string;
  workspaceScopeVersion: string;
  publishedAt: number;
}

export interface PreparedImportedIsolatedWorkspace {
  sessionId: string;
  anchorMessageId: string;
  forkId: string;
  intentId: string;
  workspacePath: string;
  evidenceId: string;
  evidenceDigest: string;
  workspaceScopeVersion: string;
  sourcePrimaryRoot: string;
  baseCommit: string;
  sourceIdentity: Record<string, unknown>;
  pathMappings: Array<{
    sourceId: string;
    sourcePath: string;
    sourceRelativePath: string;
    isolatedRelativePath: string;
  }>;
  portableEvidenceId: string;
  portablePayloadDigest: string;
  sourceExportId: string;
  sourcePayloadDigest: string | null;
  targetProjectId: string;
  ownerUserId: string | null;
  state: 'ready' | 'published';
  graphPublicationRequired: boolean;
  publishedAt?: number;
}

export interface ImportedWorkspaceGraphSession {
  sessionId: string;
  readOnly: boolean;
  workspaceMode: SessionForkWorkspaceMode;
}

export interface PublishPreparedImportedWorkspaceGraphInput {
  importId?: string;
  sourceExportId: string;
  sourcePayloadDigest?: string;
  ownerUserId: string | null;
  targetProjectId: string;
  sessions: ImportedWorkspaceGraphSession[];
  workspaces: PreparedImportedIsolatedWorkspace[];
  now?: number;
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
  private conversationBranchRepo!: ConversationBranchRepository;
  private sessionForkPortabilityRepo!: SessionForkPortabilityRepository;
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

    // 开库前的 -shm 一致性保障：过小就补大，永不删除（见 walShmConsistency.ts 顶部注释）
    ensureWalShmConsistency(this.dbPath, logger);

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
      applyDistillSignalsMigration(this.db, logger);
      this.applyDurableRunMigration(this.db);
      // Create immutable ledger tables before repositories are constructed,
      // but defer legacy rows until project ownership has been backfilled.
      applyConversationBranchSchema(this.db, { backfillLegacy: false });
      applySessionForkPortabilitySchema(this.db);
      step('migrations');
      applyIndexes(this.db);
      step('indexes');

      // 初始化 Repositories
      this.conversationBranchRepo = new ConversationBranchRepository(this.db);
      this.sessionRepo = new SessionRepository(this.db);
      this.sessionForkRepo = new SessionForkRepository(this.db, this.conversationBranchRepo);
      this.sessionForkWorkspaceRepo = new SessionForkWorkspaceRepository(this.db);
      this.sessionForkPortabilityRepo = new SessionForkPortabilityRepository(
        this.db,
        this.conversationBranchRepo,
      );
      const recoveredPortabilityUploads = this.sessionForkPortabilityRepo
        .recoverInterruptedSync(Date.now());
      if (recoveredPortabilityUploads > 0) {
        logger.warn(
          `[DatabaseService] recovered ${recoveredPortabilityUploads} interrupted Session Fork upload(s) to local-only`,
        );
      }
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
        db: this.db,
        sessionRepo: this.sessionRepo,
        memoryRepo: this.memoryRepo,
        toolExecutionEventRepo: this.toolExecutionEventRepo,
        permissionDecisionRepo: this.permissionDecisionRepo,
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
        await this.isolatedAnchorWorkspaceService.advertiseAndFinalize(
          saga.intentId,
          () => this.sessionForkWorkspaceRepo.finalizeSaga(saga.intentId),
        );
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

  /** 库文件绝对路径 —— 供需要在别的进程里开同一个库的场景使用（如 VACUUM 子进程） */
  getDbPath(): string {
    return this.dbPath;
  }

  /**
   * Backfill legacy sessions only after Project ownership has reached its
   * canonical local projection. Existing immutable rows are never rewritten.
   */
  backfillConversationBranchLedger(): void {
    this.ensureDb();
    applyConversationBranchSchema(this.db!);
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
    if (!rebuilt) return stored;
    // 活跃 run 也以 ledger 为真；仅保留一条崩溃兼容：历史 rollup 已终态而旧账本
    // 缺 run_closed 时，不能把完整终态降回 running。
    if (rebuilt.run.status === 'running' && stored && stored.run.status !== 'running') return stored;
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
      projectId?: string | null;
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
  async clearAllSessions(): Promise<number> {
    this.ensureDb();
    const { deleteAllTerminalFrames } = await import('../surfaceExecution/TerminalFrameStore');
    await deleteAllTerminalFrames();
    return this.sessionRepo.clearAllSessions();
  }
  markCrashedActiveSessions(now?: number): {
    interrupted: number;
    orphaned: number;
  } {
    this.ensureDb();
    return this.sessionRepo.markCrashedActiveSessions(now);
  }
  async clearAllMessages(): Promise<number> {
    this.ensureDb();
    const { deleteAllTerminalFrames } = await import('../surfaceExecution/TerminalFrameStore');
    await deleteAllTerminalFrames();
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

  getLatestUserAuthorId(sessionId: string): string | null {
    this.ensureDb();
    return this.sessionRepo.getLatestUserAuthorId(sessionId);
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
  ): Promise<SessionForkAnchorEvidenceRecord | null> {
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
  ): SessionForkAnchorEvidenceRecord | null {
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
    const importedSession = this.sessionRepo.getSession(
      sessionId,
      ownerUserId === undefined
        ? { includeDeleted: true }
        : { includeDeleted: true, userId: ownerUserId },
    );
    const importedPublication = importedSession?.metadata?.importedWorkspacePublicationV1;
    if (
      importedPublication
      && typeof importedPublication === 'object'
      && !Array.isArray(importedPublication)
    ) {
      let projection: ReturnType<typeof projectChildWorkspaceScope>;
      try {
        projection = projectChildWorkspaceScope(importedSession?.metadata);
      } catch (error) {
        throw new SessionForkError(
          'WORKSPACE_IDENTITY_DRIFT',
          `the imported isolated WorkspaceScope metadata is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const publication = importedPublication as Record<string, unknown>;
      const row = rawDb.prepare(`
        SELECT
          intent.status AS intent_status,
          intent.advertisable AS intent_advertisable,
          intent.workspace_path AS intent_workspace_path,
          intent.evidence_digest AS intent_evidence_digest,
          evidence.id AS evidence_id,
          evidence.source_session_id AS evidence_source_session_id,
          evidence.project_id AS evidence_project_id,
          evidence.workspace_scope_version AS evidence_workspace_scope_version,
          evidence.source_identity_digest AS evidence_source_identity_digest,
          evidence.source_identity_json AS evidence_source_identity_json,
          evidence.repository_root AS evidence_repository_root,
          evidence.base_commit AS evidence_base_commit,
          evidence.evidence_digest AS evidence_digest,
          evidence.evidence_json AS evidence_json,
          evidence.status AS evidence_status
        FROM session_fork_workspace_intents AS intent
        JOIN session_fork_anchor_evidence AS evidence
          ON evidence.id = ?
        WHERE intent.intent_id = ?
        LIMIT 1
      `).get(publication.evidenceId, publication.intentId) as Record<string, unknown> | undefined;
      const engineCwd = importedSession?.engine?.cwd;
      const evidence = parseJsonValue(row?.evidence_json);
      const manifest = evidence && typeof evidence === 'object' && !Array.isArray(evidence)
        ? (evidence as { manifest?: Record<string, unknown> }).manifest
        : null;
      const storedIdentity = parseJsonValue(row?.evidence_source_identity_json);
      const expectedMappings = Array.isArray(manifest?.pathMappings)
        ? manifest.pathMappings.map((candidate) => {
          const mapping = candidate as Record<string, unknown>;
          return {
            sourceId: mapping.sourceId,
            sourcePath: mapping.sourcePath,
            sourceRelativePath: mapping.repositoryRelativePath,
            isolatedRelativePath: mapping.isolatedRelativePath,
          };
        })
        : null;
      const matches = Boolean(
        importedSession
        && projection
        && importedSession.readOnly === false
        && importedSession.workingDirectory === importedSession.workspace
        && importedSession.workingDirectory === row?.intent_workspace_path
        && importedSession.projectId === row?.evidence_project_id
        && engineCwd === importedSession.workingDirectory
        && row?.intent_status === 'advertised'
        && Number(row?.intent_advertisable) === 1
        && row?.evidence_status === 'complete'
        && row?.evidence_source_session_id === sessionId
        && publication.intentId === projection.verification.intentId
        && publication.evidenceId === projection.verification.evidenceId
        && row?.intent_evidence_digest === row?.evidence_digest
        && projection.verification.projectId === row?.evidence_project_id
        && projection.verification.sourceWorkspaceScopeVersion
          === row?.evidence_workspace_scope_version
        && projection.verification.sourcePrimaryRoot === row?.evidence_repository_root
        && projection.verification.isolatedPrimaryRoot === row?.intent_workspace_path
        && projection.verification.baseCommit === row?.evidence_base_commit
        && projection.verification.evidenceDigest === row?.evidence_digest
        && storedIdentity
        && digestWorkspaceValue(projection.provenance.sourceIdentity)
          === digestWorkspaceValue(storedIdentity)
        && row?.evidence_source_identity_digest === digestWorkspaceValue(storedIdentity)
        && expectedMappings
        && digestWorkspaceValue(projection.provenance.pathMappings)
          === digestWorkspaceValue(expectedMappings)
      );
      if (!matches || !projection) {
        throw new SessionForkError(
          'WORKSPACE_IDENTITY_DRIFT',
          'the imported isolated WorkspaceScope does not match its atomic publication evidence',
        );
      }
      return projection.scope;
    }
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
    input: CreateForkRepositoryInput,
  ): Promise<CreateForkRepositoryResult> {
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
    if (saga.state === 'completed') {
      if (!saga.workspacePath) {
        throw new SessionForkError(
          'FORK_OPERATION_FAILED',
          'completed isolated workspace saga has no durable workspace path',
        );
      }
      return this.sessionForkRepo.createFork({
        ...input,
        forkId: saga.proposedForkId,
        childSessionId: saga.proposedChildSessionId,
        childTitle: saga.childTitle,
        workspaceMode: 'isolated_at_anchor',
        childWorkingDirectory: saga.workspacePath,
        workspaceSnapshotId: saga.intentId,
      });
    }

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
      await this.isolatedAnchorWorkspaceService.advertiseAndFinalize(
        saga.intentId,
        () => this.sessionForkWorkspaceRepo.finalizeSaga(saga.intentId, input.now),
      );
      workspaceAdvertised = true;
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
    input: CreateForkRepositoryInput,
  ): CreateForkRepositoryResult {
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
  getSessionForkContextSource(childSessionId: string): SessionForkContextSource | null {
    this.ensureDb();
    return this.sessionForkRepo.getContextSource(childSessionId);
  }
  prepareSessionForkContextHandoff(
    forkId: string,
    engine: import('../../../shared/contract/agentEngine').ExternalAgentEngineKind,
    payloadDigest: string,
    preparedAt?: number,
  ): SessionForkContextHandoffRecord {
    this.ensureDb();
    return this.sessionForkRepo.prepareContextHandoff(forkId, engine, payloadDigest, preparedAt);
  }
  markSessionForkContextHandoffDispatching(
    forkId: string,
    payloadDigest: string,
    attemptId: string,
    startedAt?: number,
  ): SessionForkContextHandoffRecord {
    this.ensureDb();
    return this.sessionForkRepo.markContextHandoffDispatching(forkId, payloadDigest, attemptId, startedAt);
  }
  markSessionForkContextHandoffConsumed(
    forkId: string,
    payloadDigest: string,
    attemptId: string,
    consumedAt?: number,
  ): SessionForkContextHandoffRecord {
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
  replayConversationBranch(
    sessionId: string,
    boundary: import('../../../shared/contract/conversationBranch').ConversationBoundary,
    options?: { includeRewound?: boolean; allowRepairOverride?: boolean },
  ): import('../../../shared/contract/conversationBranch').ConversationReplay {
    this.ensureDb();
    return this.conversationBranchRepo.replay(sessionId, boundary, options);
  }
  compareConversationBranches(
    leftSessionId: string,
    rightSessionId: string,
    boundary: import('../../../shared/contract/conversationBranch').ConversationBoundary,
  ): import('../../../shared/contract/conversationBranch').ConversationBranchComparison {
    this.ensureDb();
    return this.conversationBranchRepo.compareBranches({ leftSessionId, rightSessionId, boundary });
  }
  traceConversationProvenance(
    sessionId: string,
    messageId: string,
    boundary: import('../../../shared/contract/conversationBranch').ConversationBoundary,
  ): import('../../../shared/contract/conversationBranch').ConversationProvenanceTrace {
    this.ensureDb();
    return this.conversationBranchRepo.traceProvenance({ sessionId, messageId, boundary });
  }
  auditConversationLineage(
    sessionId: string,
    boundary: import('../../../shared/contract/conversationBranch').ConversationBoundary,
  ): import('../../../shared/contract/conversationBranch').ConversationLineageAudit {
    this.ensureDb();
    return this.conversationBranchRepo.auditLineage(sessionId, boundary);
  }
  quarantineConversationLineage(
    sessionId: string,
    boundary: import('../../../shared/contract/conversationBranch').ConversationBoundary,
    idempotencyKey: string,
    createdAt?: number,
  ): import('../../../shared/contract/conversationBranch').ConversationLineageAudit {
    this.ensureDb();
    return this.conversationBranchRepo.auditAndQuarantine({
      sessionId,
      boundary,
      idempotencyKey,
      createdAt,
    });
  }
  repairConversationLineage(
    input: {
      sessionId: string;
      boundary: import('../../../shared/contract/conversationBranch').ConversationBoundary;
      issueDigest: string;
      reason: string;
      idempotencyKey: string;
      createdAt?: number;
    },
  ): import('../../../shared/contract/conversationBranch').ConversationLineageAudit {
    this.ensureDb();
    return this.conversationBranchRepo.repairCompatibilityProjection(input);
  }
  recordConversationLineageRepairOverride(
    input: {
      sessionId: string;
      boundary: import('../../../shared/contract/conversationBranch').ConversationBoundary;
      issueDigest: string;
      reason: string;
      idempotencyKey: string;
      createdAt?: number;
    },
  ): import('../../../shared/contract/conversationBranch').ConversationLineageAudit {
    this.ensureDb();
    return this.conversationBranchRepo.recordRepairOverride(input);
  }
  recordConversationEvaluationAttribution(
    input: {
      sessionId: string;
      boundary: import('../../../shared/contract/conversationBranch').ConversationBoundary;
      evaluationId: string;
      runId?: string | null;
      metric: string;
      value: number;
      attributedMessageIds: string[];
      idempotencyKey: string;
      createdAt?: number;
    },
  ): import('../../../shared/contract/conversationBranch').ConversationEvaluationAttribution {
    this.ensureDb();
    return this.conversationBranchRepo.recordEvaluationAttribution(input);
  }
  listConversationEvaluationAttributions(
    sessionId: string,
    boundary: import('../../../shared/contract/conversationBranch').ConversationBoundary,
  ): import('../../../shared/contract/conversationBranch').ConversationEvaluationAttribution[] {
    this.ensureDb();
    return this.conversationBranchRepo.listEvaluationAttributions(sessionId, boundary);
  }
  exportSessionFork(
    input: ExportSessionForkInput,
  ): import('../../../shared/contract/sessionForkPortability').SessionExportEnvelopeV2 {
    this.ensureDb();
    return this.sessionForkPortabilityRepo.exportSessionFork(input);
  }
  getDurableSessionForkExport(
    exportId: string,
    ownerScopeId: string,
    projectId: string,
  ): import('../../../shared/contract/sessionForkPortability').SessionExportEnvelopeV2 | null {
    this.ensureDb();
    return this.sessionForkPortabilityRepo.getDurableEnvelope(exportId, ownerScopeId, projectId);
  }
  importSessionFork(
    input: ImportSessionForkInput,
  ): ImportSessionForkResult {
    this.ensureDb();
    return this.sessionForkPortabilityRepo.importSessionFork(input);
  }
  async prepareImportedIsolatedWorkspace(
    input: PublishImportedIsolatedWorkspaceInput,
  ): Promise<PreparedImportedIsolatedWorkspace> {
    this.ensureDb();
    const rawDb = this.db;
    if (!rawDb) throw new Error('Database not initialized');
    const importedSessionId = input.importedSessionId.trim();
    const importedAnchorMessageId = input.importedAnchorMessageId.trim();
    const targetProjectId = input.targetProjectId.trim();
    if (!importedSessionId || !importedAnchorMessageId || !targetProjectId) {
      throw new Error('IMPORTED_WORKSPACE_BOUNDARY_MISMATCH: session, anchor, and Project are required');
    }
    const intentId = `import_workspace_${digestWorkspaceValue({
      importedSessionId,
      portableEvidenceId: input.portableEvidence.evidenceId,
      portablePayloadDigest: input.portableEvidence.content.payloadDigest,
      targetProjectId,
    }).slice(0, 32)}`;
    const destinationName = `imported-${digestWorkspaceValue(importedSessionId).slice(0, 32)}`;
    const readSessionRow = (): {
      id: string;
      user_id: string | null;
      project_id: string | null;
      origin: string | null;
      metadata: string | null;
      agent_engine: string | null;
      read_only: number;
      working_directory: string | null;
      workspace: string | null;
      is_deleted: number;
      status: string;
    } | undefined => rawDb.prepare(`
      SELECT id, user_id, project_id, origin, metadata, agent_engine, read_only,
             working_directory, workspace, is_deleted, status
      FROM sessions
      WHERE id = ?
      LIMIT 1
    `).get(importedSessionId) as ReturnType<typeof readSessionRow>;
    const requireCurrentBinding = async (): Promise<WorkspaceScope> => {
      const { getProjectService } = await import('../project/projectService');
      const scope = getProjectService().getWorkspaceScope(targetProjectId);
      if (!scope) {
        throw new Error(
          'IMPORTED_WORKSPACE_BOUNDARY_MISMATCH: current Project is not the trusted single-root binding',
        );
      }
      const primary = scope.roots[0];
      const canonicalBoundRoot = fs.realpathSync.native(input.workspaceBinding.repositoryRoot);
      if (
        scope.projectId !== targetProjectId
        || input.workspaceBinding.projectId !== targetProjectId
        || input.workspaceBinding.topology !== 'single_root_git'
        || input.workspaceBinding.identityTrust !== 'verified'
        || scope.roots.length !== 1
        || primary?.role !== 'primary'
        || scope.version !== input.workspaceBinding.workspaceScopeVersion
        || fs.realpathSync.native(scope.primaryRoot) !== canonicalBoundRoot
        || fs.realpathSync.native(primary.path) !== canonicalBoundRoot
      ) {
        throw new Error(
          'IMPORTED_WORKSPACE_BOUNDARY_MISMATCH: current Project is not the trusted single-root binding',
        );
      }
      return scope;
    };
    const requireImportedSession = (allowPublished: boolean): {
      row: NonNullable<ReturnType<typeof readSessionRow>>;
      metadata: Record<string, unknown>;
    } => {
      const row = readSessionRow();
      if (!row) {
        throw new Error(
          'IMPORTED_WORKSPACE_BOUNDARY_MISMATCH: session is not the exact hidden imported isolated workspace',
        );
      }
      const metadata = parseJsonValue(row.metadata);
      const origin = parseJsonValue(row.origin);
      const workspace = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>).portableWorkspaceV2
        : null;
      const portableAnchor = workspace && typeof workspace === 'object' && !Array.isArray(workspace)
        ? (workspace as Record<string, unknown>).isolatedAnchor
        : null;
      const lineage = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>).forkLineage
        : null;
      const portableAnchorMessageId = workspace
        && typeof workspace === 'object'
        && !Array.isArray(workspace)
        && typeof (workspace as Record<string, unknown>).anchorChildMessageId === 'string'
        ? String((workspace as Record<string, unknown>).anchorChildMessageId)
        : lineage
          && typeof lineage === 'object'
          && !Array.isArray(lineage)
          && typeof (lineage as Record<string, unknown>).anchorChildMessageId === 'string'
          ? String((lineage as Record<string, unknown>).anchorChildMessageId)
          : null;
      if (
        row.user_id !== input.ownerUserId
        || row.project_id !== targetProjectId
        || Number(row.is_deleted) !== 0
        || row.status !== 'idle'
        || !origin
        || typeof origin !== 'object'
        || Array.isArray(origin)
        || (origin as Record<string, unknown>).kind !== 'import'
        || !metadata
        || typeof metadata !== 'object'
        || Array.isArray(metadata)
        || !workspace
        || typeof workspace !== 'object'
        || Array.isArray(workspace)
        || (workspace as Record<string, unknown>).mode !== 'isolated_at_anchor'
        || portableAnchorMessageId !== importedAnchorMessageId
        || !portableAnchor
        || digestWorkspaceValue(portableAnchor) !== digestWorkspaceValue(input.portableEvidence)
        || (!allowPublished && (
          Number(row.read_only) !== 1
          || row.working_directory !== null
          || row.workspace !== null
        ))
      ) {
        throw new Error(
          'IMPORTED_WORKSPACE_BOUNDARY_MISMATCH: session is not the exact hidden imported isolated workspace',
        );
      }
      return { row, metadata: metadata as Record<string, unknown> };
    };
    const importIdentity = (metadata: Record<string, unknown>): {
      sourceExportId: string;
      sourcePayloadDigest: string | null;
    } => {
      const value = metadata.portabilityImportV2;
      if (
        !value
        || typeof value !== 'object'
        || Array.isArray(value)
        || typeof (value as Record<string, unknown>).sourceExportId !== 'string'
        || !String((value as Record<string, unknown>).sourceExportId).trim()
      ) {
        throw new Error(
          'IMPORTED_WORKSPACE_BOUNDARY_MISMATCH: imported session lost its source export identity',
        );
      }
      const record = value as Record<string, unknown>;
      return {
        sourceExportId: String(record.sourceExportId),
        sourcePayloadDigest: typeof record.sourcePayloadDigest === 'string'
          ? record.sourcePayloadDigest
          : null,
      };
    };

    await requireCurrentBinding();
    const initial = requireImportedSession(true);
    const importedFrom = importIdentity(initial.metadata);
    const publishedProjection = initial.metadata.importedWorkspacePublicationV1;
    if (
      publishedProjection
      && typeof publishedProjection === 'object'
      && !Array.isArray(publishedProjection)
    ) {
      const publication = publishedProjection as Record<string, unknown>;
      const intent = await this.sessionForkWorkspaceRepo.get(intentId);
      const projection = projectChildWorkspaceScope(initial.metadata);
      const forkId = projection?.verification.forkId;
      const portable = initial.metadata.portableWorkspaceV2 as PortableSessionWorkspaceV2;
      if (
        !intent
        || !projection
        || !forkId
        || projection.verification.intentId !== intentId
        || publication.intentId !== intentId
        || publication.portableEvidenceId !== input.portableEvidence.evidenceId
        || publication.portablePayloadDigest !== input.portableEvidence.content.payloadDigest
      ) {
        throw new Error('IMPORTED_WORKSPACE_PUBLICATION_DRIFT: published workspace projection is invalid');
      }
      readPublishedImportedPortableWorkspace(rawDb, {
        fork: {
          id: forkId,
          child_session_id: importedSessionId,
          anchor_child_message_id: importedAnchorMessageId,
          requireLineage: Boolean(initial.metadata.forkLineage),
        },
        session: initial.row,
        metadata: initial.metadata,
        importedPortable: portable,
        publication,
      });
      return {
        sessionId: importedSessionId,
        anchorMessageId: importedAnchorMessageId,
        forkId,
        intentId,
        workspacePath: intent.workspacePath,
        evidenceId: projection.verification.evidenceId,
        evidenceDigest: intent.evidenceDigest,
        workspaceScopeVersion: projection.verification.sourceWorkspaceScopeVersion,
        sourcePrimaryRoot: projection.verification.sourcePrimaryRoot,
        baseCommit: projection.verification.baseCommit,
        sourceIdentity: structuredClone(projection.provenance.sourceIdentity),
        pathMappings: structuredClone(projection.provenance.pathMappings),
        portableEvidenceId: input.portableEvidence.evidenceId,
        portablePayloadDigest: input.portableEvidence.content.payloadDigest,
        sourceExportId: importedFrom.sourceExportId,
        sourcePayloadDigest: importedFrom.sourcePayloadDigest,
        targetProjectId,
        ownerUserId: input.ownerUserId,
        state: 'published',
        graphPublicationRequired: Boolean(
          initial.metadata.portabilityPublicationBarrierV1,
        ),
        publishedAt: Number(publication.publishedAt),
      };
    }
    requireImportedSession(false);
    const anchor = this.getMessageById(
      importedSessionId,
      importedAnchorMessageId,
      { includeRewound: true },
    );
    if (!anchor || !isCompletedSessionForkAnchor(anchor)) {
      throw new Error(
        'IMPORTED_WORKSPACE_BOUNDARY_MISMATCH: imported anchor must be a completed assistant reply',
      );
    }
    const materializerInput = {
      portableEvidence: input.portableEvidence,
      targetProjectId,
      workspaceBinding: input.workspaceBinding,
      intentId,
      sourceSessionId: importedSessionId,
      proposedChildSessionId: importedSessionId,
      destinationName,
    };
    const materializer = new ImportedPortableAnchorWorkspaceMaterializer({
      workspaceService: this.isolatedAnchorWorkspaceService,
    });
    const rebound = await materializer.rebindEvidence(materializerInput);
    const scopeBeforeMaterialization = await requireCurrentBinding();
    const sourceIdentity = forkWorkspaceSourceIdentity(scopeBeforeMaterialization);
    const existingEvidence = this.sessionForkWorkspaceRepo.getAnchorEvidence(
      importedSessionId,
      importedAnchorMessageId,
      input.ownerUserId,
    );
    if (
      existingEvidence?.status === 'complete'
      && existingEvidence.evidenceDigest !== rebound.evidence.manifest.evidenceDigest
    ) {
      throw new Error(
        'IMPORTED_WORKSPACE_EVIDENCE_CONFLICT: imported anchor is already bound to different evidence',
      );
    }
    const evidenceRecord = this.sessionForkWorkspaceRepo.recordAnchorEvidence({
      sourceSessionId: importedSessionId,
      anchorMessageId: importedAnchorMessageId,
      ownerUserId: input.ownerUserId,
      projectId: targetProjectId,
      workspaceScopeVersion: scopeBeforeMaterialization.version,
      sourceIdentityDigest: digestWorkspaceValue(sourceIdentity),
      sourceIdentity,
      messageDigest: digestSessionForkAnchorMessage(anchor),
      repositoryRoot: rebound.repositoryRoot,
      evidence: rebound.evidence,
      status: 'complete',
      summary: {
        importedPortableEvidenceId: input.portableEvidence.evidenceId,
        portablePayloadDigest: input.portableEvidence.content.payloadDigest,
      },
      now: input.now,
    });
    const prepared = await materializer.materialize(materializerInput);
    const currentScope = await requireCurrentBinding();
    const latest = requireImportedSession(false);
    const lineage = latest.metadata.forkLineage;
    const forkId = lineage && typeof lineage === 'object' && !Array.isArray(lineage)
      && typeof (lineage as Record<string, unknown>).forkId === 'string'
      ? String((lineage as Record<string, unknown>).forkId)
      : `imported:${importedSessionId}`;
    return {
      sessionId: importedSessionId,
      anchorMessageId: importedAnchorMessageId,
      forkId,
      intentId,
      workspacePath: prepared.workspacePath,
      evidenceId: evidenceRecord.id,
      evidenceDigest: prepared.evidenceDigest,
      workspaceScopeVersion: currentScope.version,
      sourcePrimaryRoot: rebound.repositoryRoot,
      baseCommit: prepared.baseCommit,
      sourceIdentity: forkWorkspaceSourceIdentity(currentScope),
      pathMappings: rebound.evidence.manifest.pathMappings.map((mapping) => ({
        sourceId: mapping.sourceId,
        sourcePath: mapping.sourcePath,
        sourceRelativePath: mapping.repositoryRelativePath,
        isolatedRelativePath: mapping.isolatedRelativePath,
      })),
      portableEvidenceId: input.portableEvidence.evidenceId,
      portablePayloadDigest: input.portableEvidence.content.payloadDigest,
      sourceExportId: importedFrom.sourceExportId,
      sourcePayloadDigest: importedFrom.sourcePayloadDigest,
      targetProjectId,
      ownerUserId: input.ownerUserId,
      state: 'ready',
      graphPublicationRequired: Boolean(
        latest.metadata.portabilityPublicationBarrierV1,
      ),
    };
  }

  async publishPreparedImportedWorkspaceGraph(
    input: PublishPreparedImportedWorkspaceGraphInput,
  ): Promise<PublishedImportedIsolatedWorkspace[]> {
    this.ensureDb();
    const rawDb = this.db;
    if (!rawDb) throw new Error('Database not initialized');
    const targetProjectId = input.targetProjectId.trim();
    const sourceExportId = input.sourceExportId.trim();
    if (!targetProjectId || !sourceExportId || input.sessions.length === 0) {
      throw new Error('IMPORTED_WORKSPACE_GRAPH_INVALID: import graph identity is required');
    }
    const sessionIds = input.sessions.map((session) => session.sessionId.trim());
    const workspaceSessionIds = input.workspaces.map((workspace) => workspace.sessionId.trim());
    if (
      sessionIds.some((sessionId) => !sessionId)
      || new Set(sessionIds).size !== sessionIds.length
      || workspaceSessionIds.some((sessionId) => !sessionId)
      || new Set(workspaceSessionIds).size !== workspaceSessionIds.length
    ) {
      throw new Error('IMPORTED_WORKSPACE_GRAPH_INVALID: graph session identities must be unique');
    }
    const durableGraphRequired = input.workspaces.some(
      (workspace) => workspace.graphPublicationRequired,
    ) || sessionIds.some((sessionId) => {
      const row = rawDb.prepare(`
        SELECT metadata FROM sessions WHERE id = ? LIMIT 1
      `).get(sessionId) as { metadata: string | null } | undefined;
      const metadata = parseJsonValue(row?.metadata);
      return Boolean(
        metadata
        && typeof metadata === 'object'
        && !Array.isArray(metadata)
        && Object.prototype.hasOwnProperty.call(
          metadata,
          'portabilityPublicationBarrierV1',
        ),
      );
    });
    if (durableGraphRequired) {
      const importId = input.importId?.trim();
      if (!importId) {
        throw new Error(
          'IMPORTED_WORKSPACE_GRAPH_INVALID: a staged import graph requires its durable import id',
        );
      }
      const importRow = rawDb.prepare(`
        SELECT target_owner_scope_id, target_project_id, source_export_id, plan_json
        FROM session_fork_portability_imports
        WHERE import_id = ?
        LIMIT 1
      `).get(importId) as {
        target_owner_scope_id: string;
        target_project_id: string;
        source_export_id: string;
        plan_json: string;
      } | undefined;
      const storedPlan = parseJsonValue(importRow?.plan_json);
      const storedResult = storedPlan
        && typeof storedPlan === 'object'
        && !Array.isArray(storedPlan)
        && (storedPlan as Record<string, unknown>).schema === 'neo.session-fork-import-plan'
        ? (storedPlan as Record<string, unknown>).result
        : storedPlan;
      const storedSessionMap = storedResult
        && typeof storedResult === 'object'
        && !Array.isArray(storedResult)
        ? (storedResult as Record<string, unknown>).sessionIdMap
        : null;
      const storedSessionIds = storedSessionMap
        && typeof storedSessionMap === 'object'
        && !Array.isArray(storedSessionMap)
        ? Object.values(storedSessionMap as Record<string, unknown>)
          .filter((value): value is string => typeof value === 'string')
          .sort()
        : [];
      const expectedOwnerScopeId = input.ownerUserId
        ?? LOCAL_SESSION_FORK_OWNER_SCOPE_ID;
      if (
        importRow?.target_owner_scope_id !== expectedOwnerScopeId
        || importRow.target_project_id !== targetProjectId
        || importRow.source_export_id !== sourceExportId
        || JSON.stringify(storedSessionIds) !== JSON.stringify([...sessionIds].sort())
      ) {
        throw new Error(
          'IMPORTED_WORKSPACE_GRAPH_INVALID: session list does not close the durable import graph',
        );
      }
    }
    const expectedIsolated = input.sessions
      .filter((session) => session.workspaceMode === 'isolated_at_anchor')
      .map((session) => session.sessionId)
      .sort();
    if (
      expectedIsolated.length === 0
      || JSON.stringify([...workspaceSessionIds].sort()) !== JSON.stringify(expectedIsolated)
    ) {
      throw new Error(
        'IMPORTED_WORKSPACE_GRAPH_INVALID: every isolated session requires one sealed workspace',
      );
    }
    for (const workspace of input.workspaces) {
      if (
        workspace.ownerUserId !== input.ownerUserId
        || workspace.targetProjectId !== targetProjectId
        || workspace.sourceExportId !== sourceExportId
        || (
          input.sourcePayloadDigest
          && workspace.sourcePayloadDigest !== input.sourcePayloadDigest
        )
      ) {
        throw new Error('IMPORTED_WORKSPACE_GRAPH_INVALID: prepared workspace crossed its import boundary');
      }
    }

    const { getProjectService } = await import('../project/projectService');
    const currentScope = getProjectService().getWorkspaceScope(targetProjectId);
    if (
      currentScope?.roots.length !== 1
      || currentScope.roots[0]?.role !== 'primary'
    ) {
      throw new Error(
        'IMPORTED_WORKSPACE_BOUNDARY_MISMATCH: current Project is not the trusted single-root binding',
      );
    }
    const canonicalPrimaryRoot = fs.realpathSync.native(currentScope.primaryRoot);
    for (const workspace of input.workspaces) {
      if (
        currentScope.version !== workspace.workspaceScopeVersion
        || fs.realpathSync.native(workspace.sourcePrimaryRoot) !== canonicalPrimaryRoot
      ) {
        throw new Error(
          'IMPORTED_WORKSPACE_BOUNDARY_MISMATCH: prepared workspace Project binding drifted',
        );
      }
      if (workspace.state === 'ready') {
        const recovered = await this.isolatedAnchorWorkspaceService.recoverIntent(
          workspace.intentId,
          { strategy: 'resume' },
        );
        if (
          recovered.outcome !== 'ready'
          || recovered.workspacePath !== workspace.workspacePath
        ) {
          throw new Error(
            `IMPORTED_WORKSPACE_SEAL_INVALID: ready workspace ${workspace.sessionId} failed verification`,
          );
        }
      }
    }

    const readSession = (sessionId: string) => rawDb.prepare(`
      SELECT id, user_id, project_id, origin, metadata, agent_engine, read_only,
             working_directory, workspace, is_deleted, status
      FROM sessions
      WHERE id = ?
      LIMIT 1
    `).get(sessionId) as {
      id: string;
      user_id: string | null;
      project_id: string | null;
      origin: string | null;
      metadata: string | null;
      agent_engine: string | null;
      read_only: number;
      working_directory: string | null;
      workspace: string | null;
      is_deleted: number;
      status: string;
    } | undefined;
    const parseSessionBoundary = (sessionId: string) => {
      const row = readSession(sessionId);
      const origin = parseJsonValue(row?.origin);
      const metadata = parseJsonValue(row?.metadata);
      const portability = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>).portabilityImportV2
        : null;
      const portableWorkspace = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>).portableWorkspaceV2
        : null;
      const actualWorkspaceMode = portableWorkspace
        && typeof portableWorkspace === 'object'
        && !Array.isArray(portableWorkspace)
        && (portableWorkspace as Record<string, unknown>).mode === 'isolated_at_anchor'
        ? 'isolated_at_anchor'
        : 'shared_current';
      const target = input.sessions.find((candidate) => candidate.sessionId === sessionId);
      if (
        row?.user_id !== input.ownerUserId
        || row.project_id !== targetProjectId
        || Number(row.is_deleted) !== 0
        || row.status !== 'idle'
        || !origin
        || typeof origin !== 'object'
        || Array.isArray(origin)
        || (origin as Record<string, unknown>).kind !== 'import'
        || !metadata
        || typeof metadata !== 'object'
        || Array.isArray(metadata)
        || !portability
        || typeof portability !== 'object'
        || Array.isArray(portability)
        || (portability as Record<string, unknown>).sourceExportId !== sourceExportId
        || (
          input.sourcePayloadDigest
          && (portability as Record<string, unknown>).sourcePayloadDigest
            !== input.sourcePayloadDigest
        )
        || target?.workspaceMode !== actualWorkspaceMode
      ) {
        throw new Error(
          `IMPORTED_WORKSPACE_GRAPH_INVALID: session ${sessionId} crossed its import boundary`,
        );
      }
      return { row, metadata: metadata as Record<string, unknown> };
    };

    for (const workspace of input.workspaces.filter((candidate) => candidate.state === 'published')) {
      const { row, metadata } = parseSessionBoundary(workspace.sessionId);
      const portable = metadata.portableWorkspaceV2 as PortableSessionWorkspaceV2;
      const projection = projectChildWorkspaceScope(metadata);
      const publication = metadata.importedWorkspacePublicationV1;
      if (
        projection?.verification.forkId !== workspace.forkId
        || projection.verification.intentId !== workspace.intentId
        || projection.verification.evidenceId !== workspace.evidenceId
        || row.working_directory !== workspace.workspacePath
      ) {
        throw new Error(
          `IMPORTED_WORKSPACE_PUBLICATION_DRIFT: session ${workspace.sessionId} projection changed`,
        );
      }
      readPublishedImportedPortableWorkspace(rawDb, {
        fork: {
          id: workspace.forkId,
          child_session_id: workspace.sessionId,
          anchor_child_message_id: workspace.anchorMessageId,
          requireLineage: Boolean(metadata.forkLineage),
        },
        session: row,
        metadata,
        importedPortable: portable,
        publication,
      });
    }

    const now = input.now ?? Date.now();
    const workspaceBySession = new Map(
      input.workspaces.map((workspace) => [workspace.sessionId, workspace]),
    );
    const publish = rawDb.transaction(() => {
      const ownerPredicate = input.ownerUserId === null
        ? 'user_id IS NULL'
        : 'user_id = ?';
      const ownerParams = input.ownerUserId === null ? [] : [input.ownerUserId];
      for (const target of input.sessions) {
        const { row, metadata } = parseSessionBoundary(target.sessionId);
        const workspace = workspaceBySession.get(target.sessionId);
        const barrier = metadata.portabilityPublicationBarrierV1;
        if (barrier !== undefined && (
          typeof barrier !== 'object'
          || barrier === null
          || Array.isArray(barrier)
          || (barrier as Record<string, unknown>).sourceExportId !== sourceExportId
          || (
            input.sourcePayloadDigest
            && (barrier as Record<string, unknown>).sourcePayloadDigest
              !== input.sourcePayloadDigest
          )
          || (barrier as Record<string, unknown>).workspaceMode !== target.workspaceMode
          || Boolean((barrier as Record<string, unknown>).desiredReadOnly) !== target.readOnly
        )) {
          throw new Error(
            `IMPORTED_WORKSPACE_GRAPH_INVALID: session ${target.sessionId} publication barrier drifted`,
          );
        }

        if (workspace?.state === 'published') {
          const intentRow = rawDb.prepare(`
            SELECT status, advertisable, source_session_id, proposed_child_session_id,
                   workspace_path, evidence_digest
            FROM session_fork_workspace_intents
            WHERE intent_id = ?
            LIMIT 1
          `).get(workspace.intentId) as Record<string, unknown> | undefined;
          if (
            intentRow?.status !== 'advertised'
            || Number(intentRow.advertisable) !== 1
            || intentRow.source_session_id !== workspace.sessionId
            || intentRow.proposed_child_session_id !== workspace.sessionId
            || intentRow.workspace_path !== workspace.workspacePath
            || intentRow.evidence_digest !== workspace.evidenceDigest
            || Number(row.read_only) !== 0
          ) {
            throw new Error(
              `IMPORTED_WORKSPACE_PUBLICATION_DRIFT: session ${workspace.sessionId} is incomplete`,
            );
          }
          continue;
        }

        if (!workspace) {
          if (barrier === undefined) {
            if (
              Number(row.read_only) !== (target.readOnly ? 1 : 0)
              || row.working_directory !== null
              || row.workspace !== null
            ) {
              throw new Error(
                `IMPORTED_WORKSPACE_PUBLICATION_DRIFT: session ${target.sessionId} is incomplete`,
              );
            }
            continue;
          }
          if (
            Number(row.read_only) !== 1
            || row.working_directory !== null
            || row.workspace !== null
          ) {
            throw new Error(
              `IMPORTED_WORKSPACE_PUBLICATION_CONFLICT: session ${target.sessionId} is not hidden`,
            );
          }
          const {
            portabilityPublicationBarrierV1: _publicationBarrier,
            ...publishedMetadata
          } = metadata;
          const sessionUpdate = rawDb.prepare(`
            UPDATE sessions
            SET metadata = ?, read_only = ?, updated_at = ?, synced_at = NULL
            WHERE id = ? AND ${ownerPredicate} AND project_id = ?
              AND metadata = ? AND read_only = 1
              AND working_directory IS NULL AND workspace IS NULL
              AND is_deleted = 0 AND status = 'idle'
          `).run(
            JSON.stringify(publishedMetadata),
            target.readOnly ? 1 : 0,
            now,
            target.sessionId,
            ...ownerParams,
            targetProjectId,
            row.metadata,
          );
          if (sessionUpdate.changes !== 1) {
            throw new Error(
              `IMPORTED_WORKSPACE_PUBLICATION_CONFLICT: session ${target.sessionId} changed`,
            );
          }
          continue;
        }

        if (
          Number(row.read_only) !== 1
          || row.working_directory !== null
          || row.workspace !== null
        ) {
          throw new Error(
            `IMPORTED_WORKSPACE_PUBLICATION_CONFLICT: session ${workspace.sessionId} is not hidden`,
          );
        }
        const intentRow = rawDb.prepare(`
          SELECT revision, status, advertisable, source_session_id,
                 proposed_child_session_id, workspace_path, evidence_digest, intent_json
          FROM session_fork_workspace_intents
          WHERE intent_id = ?
          LIMIT 1
        `).get(workspace.intentId) as {
          revision: number;
          status: string;
          advertisable: number;
          source_session_id: string;
          proposed_child_session_id: string;
          workspace_path: string;
          evidence_digest: string;
          intent_json: string;
        } | undefined;
        if (
          intentRow?.status !== 'ready'
          || Number(intentRow.advertisable) !== 1
          || intentRow.source_session_id !== workspace.sessionId
          || intentRow.proposed_child_session_id !== workspace.sessionId
          || intentRow.workspace_path !== workspace.workspacePath
          || intentRow.evidence_digest !== workspace.evidenceDigest
        ) {
          throw new Error(
            `IMPORTED_WORKSPACE_INTENT_CONFLICT: ready intent ${workspace.intentId} changed`,
          );
        }
        const storedIntent = JSON.parse(intentRow.intent_json) as Record<string, unknown>;
        const nextRevision = Number(intentRow.revision) + 1;
        const intentUpdate = rawDb.prepare(`
          UPDATE session_fork_workspace_intents
          SET revision = ?, intent_json = ?, status = 'advertised',
              advertisable = 1, updated_at = ?
          WHERE intent_id = ? AND revision = ? AND status = 'ready' AND advertisable = 1
        `).run(
          nextRevision,
          JSON.stringify({
            ...storedIntent,
            revision: nextRevision,
            status: 'advertised',
            advertisable: true,
            updatedAt: now,
          }),
          now,
          workspace.intentId,
          intentRow.revision,
        );
        const {
          portabilityPublicationBarrierV1: _publicationBarrier,
          ...baseMetadata
        } = metadata;
        const projection = {
          version: 1,
          forkId: workspace.forkId,
          intentId: workspace.intentId,
          evidenceId: workspace.evidenceId,
          projectId: targetProjectId,
          sourceWorkspaceScopeVersion: workspace.workspaceScopeVersion,
          sourcePrimaryRoot: workspace.sourcePrimaryRoot,
          isolatedPrimaryRoot: workspace.workspacePath,
          baseCommit: workspace.baseCommit,
          evidenceDigest: workspace.evidenceDigest,
          sourceIdentity: workspace.sourceIdentity,
          pathMappings: workspace.pathMappings,
        };
        const publishedMetadata = {
          ...baseMetadata,
          forkWorkspaceScopeV1: projection,
          importedWorkspacePublicationV1: {
            version: 1,
            intentId: workspace.intentId,
            evidenceId: workspace.evidenceId,
            portableEvidenceId: workspace.portableEvidenceId,
            portablePayloadDigest: workspace.portablePayloadDigest,
            evidenceDigest: workspace.evidenceDigest,
            workspaceScopeVersion: workspace.workspaceScopeVersion,
            publishedAt: now,
          },
        };
        const engine = parseJsonValue(row.agent_engine);
        const publishedEngine = {
          ...(engine && typeof engine === 'object' && !Array.isArray(engine)
            ? engine as Record<string, unknown>
            : {}),
          cwd: workspace.workspacePath,
        };
        const sessionUpdate = rawDb.prepare(`
          UPDATE sessions
          SET working_directory = ?, workspace = ?, metadata = ?, agent_engine = ?,
              read_only = 0, updated_at = ?, synced_at = NULL
          WHERE id = ? AND ${ownerPredicate} AND project_id = ?
            AND metadata = ? AND agent_engine = ?
            AND read_only = 1 AND working_directory IS NULL AND workspace IS NULL
            AND is_deleted = 0 AND status = 'idle'
        `).run(
          workspace.workspacePath,
          workspace.workspacePath,
          JSON.stringify(publishedMetadata),
          JSON.stringify(publishedEngine),
          now,
          workspace.sessionId,
          ...ownerParams,
          targetProjectId,
          row.metadata,
          row.agent_engine,
        );
        if (intentUpdate.changes !== 1 || sessionUpdate.changes !== 1) {
          throw new Error(
            `IMPORTED_WORKSPACE_PUBLICATION_CONFLICT: session ${workspace.sessionId} changed`,
          );
        }
      }
    });
    publish.immediate();
    return input.workspaces.map((workspace) => ({
      sessionId: workspace.sessionId,
      intentId: workspace.intentId,
      workspacePath: workspace.workspacePath,
      evidenceDigest: workspace.evidenceDigest,
      workspaceScopeVersion: workspace.workspaceScopeVersion,
      publishedAt: workspace.state === 'published'
        ? workspace.publishedAt ?? now
        : now,
    }));
  }

  async publishImportedIsolatedWorkspace(
    input: PublishImportedIsolatedWorkspaceInput,
  ): Promise<PublishedImportedIsolatedWorkspace> {
    const prepared = await this.prepareImportedIsolatedWorkspace(input);
    if (prepared.graphPublicationRequired) {
      throw new Error(
        'IMPORTED_WORKSPACE_GRAPH_INVALID: staged import workspaces require graph publication',
      );
    }
    const [published] = await this.publishPreparedImportedWorkspaceGraph({
      sourceExportId: prepared.sourceExportId,
      ...(prepared.sourcePayloadDigest
        ? { sourcePayloadDigest: prepared.sourcePayloadDigest }
        : {}),
      ownerUserId: input.ownerUserId,
      targetProjectId: input.targetProjectId,
      sessions: [{
        sessionId: prepared.sessionId,
        readOnly: false,
        workspaceMode: 'isolated_at_anchor',
      }],
      workspaces: [prepared],
      now: input.now,
    });
    if (!published) {
      throw new Error('IMPORTED_WORKSPACE_PUBLICATION_CONFLICT: graph returned no workspace');
    }
    return published;
  }
  enqueueSessionForkOutbound(
    input: EnqueueSessionForkOutboundInput,
  ): import('../../../shared/contract/sessionForkPortability').SessionForkSyncEnvelopeRecord {
    this.ensureDb();
    return this.sessionForkPortabilityRepo.enqueueOutbound(input);
  }
  flushSessionForkOutbound(
    syncEnvelopeId: string,
    ownerScopeId: string,
    projectId: string,
    options: FlushSessionForkOutboundOptions = {},
  ): Promise<import('../../../shared/contract/sessionForkPortability').SessionForkSyncEnvelopeRecord> {
    this.ensureDb();
    return this.sessionForkPortabilityRepo.flushOutbound(
      syncEnvelopeId,
      ownerScopeId,
      projectId,
      options,
    );
  }
  ingestSessionForkInbound(
    input: IngestSessionForkInboundInput,
  ): import('../../../shared/contract/sessionForkPortability').SessionForkSyncEnvelopeRecord {
    this.ensureDb();
    return this.sessionForkPortabilityRepo.ingestInbound(input);
  }
  applySessionForkInbound(
    syncEnvelopeId: string,
    ownerScopeId: string,
    projectId: string,
    now?: number,
  ): import('../../../shared/contract/sessionForkPortability').SessionForkSyncEnvelopeRecord {
    this.ensureDb();
    return this.sessionForkPortabilityRepo.applyInbound(
      syncEnvelopeId,
      ownerScopeId,
      projectId,
      now,
    );
  }
  getSessionForkSyncRecord(
    direction: 'outbox' | 'inbox',
    syncEnvelopeId: string,
    ownerScopeId: string,
    projectId: string,
  ): import('../../../shared/contract/sessionForkPortability').SessionForkSyncEnvelopeRecord | null {
    this.ensureDb();
    return this.sessionForkPortabilityRepo.getSyncRecord(
      direction,
      syncEnvelopeId,
      ownerScopeId,
      projectId,
    );
  }
  searchDurableSessionForks(
    exportId: string,
    ownerScopeId: string,
    projectId: string,
    query: string,
  ): import('../../../shared/contract/sessionForkPortability').ForkSearchDocument[] {
    this.ensureDb();
    return this.sessionForkPortabilityRepo.searchDurableForks(
      exportId,
      ownerScopeId,
      projectId,
      query,
    );
  }
  getDurableSessionForkTree(
    exportId: string,
    ownerScopeId: string,
    projectId: string,
  ): import('../../../shared/contract/sessionForkPortability').ForkTreeNodeProjection {
    this.ensureDb();
    return this.sessionForkPortabilityRepo.getDurableForkTree(
      exportId,
      ownerScopeId,
      projectId,
    );
  }
  getDurableSessionForkNeighborhood(
    exportId: string,
    ownerScopeId: string,
    projectId: string,
    centerSessionId: string,
    radius?: number,
  ): import('../../../shared/contract/sessionForkPortability').ForkNeighborhoodProjection {
    this.ensureDb();
    return this.sessionForkPortabilityRepo.getDurableForkNeighborhood(
      exportId,
      ownerScopeId,
      projectId,
      centerSessionId,
      radius,
    );
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
    options?: Parameters<import('./repositories').SessionRepository['searchSessionMessagesFts']>[1]
  ): ReturnType<import('./repositories').SessionRepository['searchSessionMessagesFts']> {
    this.ensureDb();
    return this.sessionRepo.searchSessionMessagesFts(query, options);
  }
  countSessionMessagesFts(
    query: string,
    options?: Parameters<import('./repositories').SessionRepository['countSessionMessagesFts']>[1]
  ): ReturnType<import('./repositories').SessionRepository['countSessionMessagesFts']> {
    this.ensureDb();
    return this.sessionRepo.countSessionMessagesFts(query, options);
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
  let projectBoundaryReady = false;
  try {
    const { getProjectService } = await import('../project/projectService');
    const backfillStart = performance.now();
    const migrated = getProjectService().backfillSessions(Date.now());
    projectBoundaryReady = true;
    if (migrated > 0) {
      logger.info(`[DatabaseService] P0-2 backfill: ${migrated} 个存量 session 已归桶到项目 (${Math.round(performance.now() - backfillStart)}ms)`);
    }
  } catch (err) {
    logger.warn('[DatabaseService] P0-2 backfill 失败（不阻塞启动）:', err instanceof Error ? err.message : String(err));
  }
  if (projectBoundaryReady) {
    db.backfillConversationBranchLedger();
  } else {
    logger.warn('[DatabaseService] immutable conversation backfill deferred: Project boundary is unavailable');
  }
  return db;
}
