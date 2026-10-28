// ============================================================================
// CloudRunLedger — 云端 run 账本（ADR-086 S1：持久 run 行 + 可订阅迁移）
// ============================================================================
// 账户只从注入的 accountResolver 来（缺省 = 绑定的 AuthService 已验证会话）；
// createRun 不收 accountId 参数，请求体里的用户字段进不到 account_id。
// runId / workspaceId 由账本铸造，写入后由 schema 触发器保不可变。
// S1 只有存储与迁移；admit / 配额 / 取消在 S2+，路由接线是后续单。
//
// 账户事实源用「authService 装载时注册」而不是本文件静态 import AuthService：
// 静态 import 会把 services/core barrel（configService 的 import 期 .env 副作用）
// 提前拉进潜在消费方的导入图，锁死 appPaths 的 userData 缓存，破坏
// databaseService.recovery.test 的 CODE_AGENT_DATA_DIR 契约。authService 本就
// 在暖图里，反向注册不新增任何边；没绑定时一律拒绝创建（fail-closed）。
// ============================================================================

import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import {
  CLOUD_RUN_TRIGGERS,
  CloudRunAccountRequiredError,
  canTransitionCloudRunState,
  isTerminalCloudRunState,
  type CloudRunState,
  type CloudRunTrigger,
} from '../../../shared/contract/cloudRun';
import { CLOUD_RUN_MAX_IN_FLIGHT } from '../../../shared/constants';
import { createLogger } from '../infra/logger';
import {
  CloudRunRepository,
  type CloudRunRecord,
  type CloudRunTransitionRecord,
} from '../core/repositories/CloudRunRepository';

const logger = createLogger('CloudRunLedger');

type CloudRunAccountResolver = () => string | null;

type CloudRunTransitionListener = (transition: CloudRunTransitionRecord) => void;

/** AuthService 的最小账户面：已验证会话才给得出账户 id。 */
interface CloudRunAccountSource {
  hasVerifiedSession(): boolean;
  getCurrentUser(): { id: string } | null;
}

let accountSource: CloudRunAccountSource | null = null;

/** AuthService 模块装载时注册自己（见 authService.ts 底部）。 */
export function bindCloudRunAccountSource(source: CloudRunAccountSource): void {
  accountSource = source;
}

/** ADR-086 合同 1：只有 hasVerifiedSession() 为真才给出账户 id；未绑定即拒绝。 */
function defaultAccountResolver(): string | null {
  const source = accountSource;
  if (!source?.hasVerifiedSession()) return null;
  return source.getCurrentUser()?.id ?? null;
}

interface CloudRunLedgerDeps {
  db: BetterSqlite3.Database;
  /** 缺省走已注册的 AuthService；测试注入替身。 */
  accountResolver?: CloudRunAccountResolver;
  /** 仓库层禁裸取当前时间（repositories grep 门），真钟缺省只落在这里。 */
  clock?: () => number;
}

interface CreateCloudRunInput {
  sessionId: string;
  trigger: CloudRunTrigger;
}

interface AdmitCloudRunInput extends CreateCloudRunInput {
  requestJson: string;
  clientMessageId?: string;
}

export class CloudRunLedger {
  private readonly repository: CloudRunRepository;
  private readonly accountResolver: CloudRunAccountResolver;
  private readonly clock: () => number;
  private readonly listeners = new Set<CloudRunTransitionListener>();

  constructor(deps: CloudRunLedgerDeps) {
    this.repository = new CloudRunRepository(deps.db);
    this.accountResolver = deps.accountResolver ?? defaultAccountResolver;
    this.clock = deps.clock ?? Date.now;
  }

  /** 无已验证账户即抛 CloudRunAccountRequiredError（稳定码 CLOUD_RUN_ACCOUNT_REQUIRED），一行不落。 */
  createRun(input: CreateCloudRunInput): CloudRunRecord {
    this.validateCreateInput(input);
    const accountId = this.requireAccountId();
    const now = this.clock();
    return this.repository.insertRun({
      runId: randomUUID(),
      accountId,
      sessionId: input.sessionId,
      trigger: input.trigger,
      workspaceId: `ws_${randomUUID()}`,
      now,
    });
  }

  admit(input: AdmitCloudRunInput) {
    this.validateCreateInput(input);
    if (!input.requestJson) throw new Error('Cloud run requestJson must be non-empty');
    const accountId = this.requireAccountId();
    const admission = this.repository.admitRun({
      runId: randomUUID(),
      accountId,
      sessionId: input.sessionId,
      trigger: input.trigger,
      workspaceId: `ws_${randomUUID()}`,
      requestJson: input.requestJson,
      clientMessageId: input.clientMessageId?.trim() || undefined,
      maxInFlight: CLOUD_RUN_MAX_IN_FLIGHT,
      now: this.clock(),
    });
    return {
      ...admission,
      position: this.repository.getQueuePosition(admission.record),
    };
  }

  readRun(runId: string) {
    const accountId = this.requireAccountId();
    const record = this.repository.getRunForAccount(runId, accountId);
    if (!record) return null;
    return { record, position: this.repository.getQueuePosition(record) };
  }

  bindExecutionRunId(runId: string, executionRunId: string): CloudRunRecord {
    return this.repository.bindExecutionRunId(runId, executionRunId, this.clock());
  }

  requestCancel(runId: string): CloudRunRecord {
    return this.repository.requestCancel(runId, this.clock());
  }

  countInFlight(accountId: string): number {
    return this.repository.countInFlight(accountId);
  }

  listInFlightRuns(): CloudRunRecord[] {
    return this.repository.listInFlightRuns();
  }

  listQueuedAccountIds(): string[] {
    return this.repository.listQueuedAccountIds();
  }

  promoteNext(accountId: string): CloudRunRecord | null {
    const promoted = this.repository.promoteNext(accountId, CLOUD_RUN_MAX_IN_FLIGHT, this.clock());
    if (!promoted) return null;
    this.notify(promoted.transition);
    return promoted.record;
  }

  /** 合同迁移表是终态守卫的唯一事实源；这里只把拒绝原因说成可区分的两类。 */
  transition(runId: string, to: CloudRunState): CloudRunRecord {
    const current = this.repository.getRun(runId);
    if (!current) throw new Error(`Unknown cloud run: ${runId}`);
    if (!canTransitionCloudRunState(current.state, to)) {
      const reason = isTerminalCloudRunState(current.state)
        ? `run is terminal (${current.state})`
        : `illegal transition ${current.state} -> ${to}`;
      throw new Error(`Cloud run transition rejected for ${runId}: ${reason}`);
    }
    const transition = this.repository.applyTransition({
      runId,
      fromState: current.state,
      toState: to,
      now: this.clock(),
    });
    this.notify(transition);
    const updated = this.repository.getRun(runId);
    if (!updated) throw new Error(`Cloud run ${runId} disappeared after transition`);
    return updated;
  }

  /** 进程内订阅，返回退订函数。监听器在迁移提交之后收到通知。 */
  onTransition(listener: CloudRunTransitionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** seq 全序读口；重启后新实例无监听器，用 afterSeq 补读增量。 */
  listTransitions(afterSeq = 0): CloudRunTransitionRecord[] {
    return this.repository.listTransitions(afterSeq);
  }

  getRun(runId: string): CloudRunRecord | null {
    return this.repository.getRun(runId);
  }

  private validateCreateInput(input: CreateCloudRunInput): void {
    if (!input.sessionId) throw new Error('Cloud run sessionId must be non-empty');
    if (!(CLOUD_RUN_TRIGGERS as readonly string[]).includes(input.trigger)) {
      throw new Error(`Unsupported cloud run trigger: ${String(input.trigger)}`);
    }
  }

  private requireAccountId(): string {
    const accountId = this.accountResolver();
    if (typeof accountId !== 'string' || !accountId) {
      throw new CloudRunAccountRequiredError();
    }
    return accountId;
  }

  /** 迁移已提交：监听器抛错只 warn 留痕，绝不回滚、不中断其余监听器。 */
  private notify(transition: CloudRunTransitionRecord): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(transition);
      } catch (error) {
        logger.warn(
          '[CloudRunLedger] onTransition listener threw after commit; transition stays committed',
          {
            runId: transition.runId,
            seq: transition.seq,
            toState: transition.toState,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
  }
}

export function createCloudRunLedger(deps: CloudRunLedgerDeps): CloudRunLedger {
  return new CloudRunLedger(deps);
}
