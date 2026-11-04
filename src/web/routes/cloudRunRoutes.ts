import { randomUUID } from 'node:crypto';
import type { Request, Response, Router } from 'express';

import type { DurableRunReadService } from '../../host/app/durableRunReadService';
import type { RunRegistry } from '../../host/runtime/runRegistry';
import type { CloudRunLedger } from '../../host/services/cloudRun/cloudRunLedger';
import type { CloudRunRecord } from '../../host/services/core/repositories/CloudRunRepository';
import { CANCELLATION_TIMEOUTS } from '../../shared/constants';
import type { DelegationOriginMarker } from '../../shared/contract/queuedInput';
import { readPersistedExecutionEnvironment } from '../../shared/contract/executionEnvironmentMarker';
import {
  CloudRunAccountRequiredError,
  isTerminalCloudRunState,
  type CloudRunState,
} from '../../shared/contract/cloudRun';
import { AgentRunBodySchema, type AgentRunBody } from './agentBodySchemas';
import { waitForCancelSettlement } from './registerAgentCancelRoute';
import type { WebRouteLogger } from './routeTypes';

interface CloudRunRuntimeDeps {
  getLedger: () => CloudRunLedger;
  runRegistry: RunRegistry;
  execute: (
    body: AgentRunBody,
    cloudRunId: string,
    options?: {
      delegationOrigin?: DelegationOriginMarker;
      /** ADR-072 INV-4（rework r1）：提升起跑的 delegate 轮用它回填委托行 target_run_id。 */
      onDurableActivated?: (activation: { runId: string; activatedAt: number }) => void;
    },
  ) => Promise<void>;
  /**
   * ADR-072 INV-4（rework r1）：排进账本的委托提升起跑时回填委托行 target_run_id。
   * queued input id 就是 delegate 行 body.clientMessageId（drain / sendNow 都这么带）；
   * 交接即 markConsumed，drain 的 onActivated 再无触发点，只能挂在这里。
   */
  onDelegateRunActivated?: (activation: {
    queuedInputId: string;
    sessionId: string;
    runId: string;
    activatedAt: number;
  }) => void;
  /**
   * ADR-087 S4：提升上来的 cron 行交这里执行（request_json 不是 AgentRunBody，
   * 绝不走上面的 parse 路径）。缺省 fail-closed：settle failed + 留痕，
   * 在 OpenClaw 核对单（N-CLOUD-RUN-LEDGER-DESIGN-FU5）关账前不放开。
   */
  executeCronRun?: (record: CloudRunRecord) => Promise<void>;
  /**
   * ADR-087 S4B：提升起跑的 channel 行交这里执行（request_json 是通道入站载荷，
   * 不是 AgentRunBody）。缺省 fail-closed：settle failed + 留痕；
   * 通道入站接线（IngressPipeline）是另一张单。
   */
  executeChannelRun?: (record: CloudRunRecord) => Promise<void>;
  /**
   * ADR-081/087 S4B：manual 云端轮准入后给会话打「跑过云」粘性标记（永不清理）。
   * 实现须自带等值跳过与失败兜底（见 createMarkSessionExecutionEnvironment）；
   * 这里再兜一层 dep 自身 reject，绝不影响 admit 主路径。
   */
  markSessionExecutionEnvironment?: (sessionId: string, environmentId: string) => Promise<boolean>;
  logger: WebRouteLogger;
}

export class CloudRunRouteRuntime {
  private observedLedger: CloudRunLedger | null = null;
  private startupPromise: Promise<void> | null = null;

  constructor(private readonly deps: CloudRunRuntimeDeps) {}

  async admit(body: AgentRunBody, options?: {
    delegationOrigin?: DelegationOriginMarker;
    /**
     * rework r1：失败重投的再准入。dedupe 命中的旧行已终态（不可能再执行），
     * dedupe 键让路建新行；body 原样保留——clientMessageId 仍是 queued input id，
     * runAgentTurn 的失败重放预检与 INV-4 回填都靠它。
     */
    redelivery?: boolean;
  }) {
    const delegationOrigin = options?.delegationOrigin;
    const sessionId = body.sessionId?.trim() || `web-session-${randomUUID()}`;
    const sanitizedBody = { ...body, sessionId };
    const admission = this.ledger().admit({
      sessionId,
      trigger: delegationOrigin ? 'delegate' : 'manual',
      // delegate 行存 { body, delegationOrigin }：排队后提升时来源标记不能丢。
      requestJson: JSON.stringify(delegationOrigin ? { body: sanitizedBody, delegationOrigin } : sanitizedBody),
      clientMessageId: options?.redelivery ? undefined : body.clientMessageId,
    });
    // ADR-081/087 S4B：ledger admit 成功后打「跑过云」标记。判等跳过在 mark
    // 实现内（重复 admit 无害）；mark 失败/抛异常只 warn，不进 admit 失败路径。
    const environmentId = sanitizedBody.environmentSelection?.environmentId;
    if (environmentId && this.deps.markSessionExecutionEnvironment) {
      try {
        await this.deps.markSessionExecutionEnvironment(sessionId, environmentId);
      } catch (error) {
        this.deps.logger.warn('[CloudRun] markSessionExecutionEnvironment dep rejected', {
          sessionId,
          environmentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { ...admission, body: sanitizedBody };
  }

  bindExecutionRunId(cloudRunId: string, executionRunId: string): void {
    this.ledger().bindExecutionRunId(cloudRunId, executionRunId);
    this.consumePendingCancel(cloudRunId, executionRunId);
  }

  // bind 前到达的取消只能在 cancel 路由落 cancel_requested_at 标记（当时还没有
  // execution_run_id 可停）。这里就是该标记的唯一消费点：执行体刚注册进 registry、
  // agent loop 还没起步，立即停掉，否则标记无人再读、run 照常跑完落自然终态。
  private consumePendingCancel(cloudRunId: string, executionRunId: string): void {
    const record = this.ledger().getRun(cloudRunId);
    if (!record || record.cancelRequestedAt === null || isTerminalCloudRunState(record.state)) return;
    const target = this.deps.runRegistry.get(executionRunId);
    if (!target) return;
    void target.cancel('user').catch((error: unknown) => {
      this.deps.logger.error(`[CloudRun] Pre-bind cancel for run ${cloudRunId} failed`, error);
    });
  }

  readRun(runId: string) {
    return this.ledger().readRun(runId);
  }

  settle(cloudRunId: string, state: CloudRunState): void {
    const ledger = this.ledger();
    const current = ledger.getRun(cloudRunId);
    if (!current || isTerminalCloudRunState(current.state)) return;
    ledger.transition(cloudRunId, state);
  }

  runStartupSweep(): Promise<void> {
    this.startupPromise ??= this.startupSweep().catch((error) => {
      this.startupPromise = null;
      throw error;
    });
    return this.startupPromise;
  }

  ledger(): CloudRunLedger {
    const ledger = this.deps.getLedger();
    if (this.observedLedger !== ledger) {
      this.observedLedger = ledger;
      ledger.onTransition((transition) => {
        if (!isTerminalCloudRunState(transition.toState)) return;
        const accountId = ledger.getRun(transition.runId)?.accountId;
        if (accountId) this.promoteAccount(accountId);
      });
    }
    return ledger;
  }

  private async startupSweep(): Promise<void> {
    const ledger = this.ledger();
    for (const record of ledger.listInFlightRuns()) {
      const live = record.executionRunId !== null
        && this.deps.runRegistry.get(record.executionRunId) !== undefined;
      if (!live) this.settle(record.runId, 'interrupted');
    }
    for (const accountId of ledger.listQueuedAccountIds()) {
      this.promoteAccount(accountId);
    }
  }

  private promoteAccount(accountId: string): void {
    let promoted = this.ledger().promoteNext(accountId);
    while (promoted) {
      this.startPromoted(promoted);
      promoted = this.ledger().promoteNext(accountId);
    }
  }

  private startPromoted(record: CloudRunRecord): void {
    // ADR-087 S4：cron 行的 request_json 是调度载荷，不是 AgentRunBody——
    // 走 parse 路径会把 cron 行误跑或误 settle failed，必须先分流。
    if (record.trigger === 'cron') {
      this.startPromotedCronRun(record);
      return;
    }
    if (record.trigger === 'channel') {
      this.startPromotedChannelRun(record);
      return;
    }
    let delegationOrigin: DelegationOriginMarker | undefined;
    let parsed: ReturnType<typeof AgentRunBodySchema.safeParse>;
    try {
      let payload: unknown = JSON.parse(record.requestJson ?? 'null');
      if (record.trigger === 'delegate') {
        const stored = payload as { body?: unknown; delegationOrigin?: Partial<DelegationOriginMarker> } | null;
        const origin = stored?.delegationOrigin;
        if (typeof origin?.delegationId !== 'string' || typeof origin.actionFingerprint !== 'string') {
          this.deps.logger.error('[CloudRun] Persisted delegate request has no valid delegationOrigin', {
            runId: record.runId,
          });
          this.settle(record.runId, 'failed');
          return;
        }
        delegationOrigin = { delegationId: origin.delegationId, actionFingerprint: origin.actionFingerprint };
        payload = stored?.body;
      }
      parsed = AgentRunBodySchema.safeParse(payload);
    } catch (error) {
      this.deps.logger.error('[CloudRun] Persisted request is not valid JSON', error);
      this.settle(record.runId, 'failed');
      return;
    }
    if (!parsed.success) {
      this.deps.logger.error('[CloudRun] Persisted request does not match the agent run schema');
      this.settle(record.runId, 'failed');
      return;
    }
    // ADR-072 INV-4（rework r1）：排进账本的委托提升起跑时也要回填 target_run_id——
    // 交接那一刻 queued input 已 markConsumed，drain 的 onActivated 再无触发点。
    const clientMessageId = parsed.data.clientMessageId?.trim();
    const onDurableActivated = delegationOrigin && clientMessageId && this.deps.onDelegateRunActivated
      ? (activation: { runId: string; activatedAt: number }) => {
        this.deps.onDelegateRunActivated?.({
          queuedInputId: clientMessageId,
          sessionId: record.sessionId,
          ...activation,
        });
      }
      : undefined;
    void this.deps.execute(parsed.data, record.runId, {
      ...(delegationOrigin ? { delegationOrigin } : {}),
      ...(onDurableActivated ? { onDurableActivated } : {}),
    }).catch((error: unknown) => {
      this.deps.logger.error(`[CloudRun] Promoted run ${record.runId} failed`, error);
      this.settle(record.runId, 'failed');
    });
  }

  private startPromotedChannelRun(record: CloudRunRecord): void {
    const executor = this.deps.executeChannelRun;
    if (!executor) {
      this.deps.logger.error(
        '[CloudRun] Promoted channel run has no executor configured; settling failed (S4B fail-closed)',
        { runId: record.runId, sessionId: record.sessionId },
      );
      this.settle(record.runId, 'failed');
      return;
    }
    void executor(record).catch((error: unknown) => {
      this.deps.logger.error(`[CloudRun] Promoted channel run ${record.runId} failed`, error);
      this.settle(record.runId, 'failed');
    });
  }

  private startPromotedCronRun(record: CloudRunRecord): void {
    const executor = this.deps.executeCronRun;
    if (!executor) {
      this.deps.logger.error(
        '[CloudRun] Promoted cron run has no executor configured; settling failed (S4 fail-closed)',
        { runId: record.runId, sessionId: record.sessionId },
      );
      this.settle(record.runId, 'failed');
      return;
    }
    void executor(record).catch((error: unknown) => {
      this.deps.logger.error(`[CloudRun] Promoted cron run ${record.runId} failed`, error);
      this.settle(record.runId, 'failed');
    });
  }
}

function sendAccountRequired(res: Response): void {
  res.status(401).json({ success: false, error: { code: 'CLOUD_RUN_ACCOUNT_REQUIRED' } });
}

function queuePayload(record: CloudRunRecord, position: { queuePosition: number; ahead: number } | null) {
  return {
    runId: record.runId,
    sessionId: record.sessionId,
    status: record.state,
    queuePosition: position?.queuePosition ?? null,
    ahead: position?.ahead ?? null,
  };
}

/**
 * ADR-087 S4B：委托投递到「跑过云」会话必须经 admit(delegate)。
 * - 'direct'：目标会话没有云标记，调用方走原有直跑路径
 * - 'queued'：已交账本（排队或重复投递），调用方不得再跑
 * - 'ran'：已准入并内联执行完
 * 无已验证账户 fail-closed：留痕后原样抛出，绝不回落直跑。
 */
export async function admitDelegatedTurn(input: {
  runtime: CloudRunRouteRuntime;
  body: AgentRunBody;
  delegationOrigin: DelegationOriginMarker;
  readSessionMetadata: (sessionId: string) => Promise<Record<string, unknown> | undefined>;
  runInline: (body: AgentRunBody, cloudRunId: string) => Promise<void>;
  logger: WebRouteLogger;
}): Promise<'direct' | 'queued' | 'ran'> {
  const sessionId = input.body.sessionId?.trim();
  if (!sessionId) return 'direct';
  const marker = readPersistedExecutionEnvironment(await input.readSessionMetadata(sessionId));
  if (!marker) return 'direct';
  try {
    let admission = await input.runtime.admit(input.body, { delegationOrigin: input.delegationOrigin });
    if (
      admission.duplicate
      && isTerminalCloudRunState(admission.record.state)
      && admission.record.state !== 'succeeded'
    ) {
      // rework r1：失败重投必须再跑一轮。dedupe 命中的是上一轮的终态失败行——
      // 判 'queued' 会让 drainOne markConsumed 把用户消息静默吞掉（与直跑路径
      // 「失败重投再跑一轮」语义相反）。终态行不可能再执行，dedupe 键让路建新行；
      // succeeded 的重投保持幂等吞掉（那轮已经真跑完，再跑就是重复轮）。
      input.logger.warn('[CloudRun] Delegated redelivery matches a terminal ledger row; re-admitting a fresh row', {
        sessionId,
        previousRunId: admission.record.runId,
        previousState: admission.record.state,
      });
      admission = await input.runtime.admit(input.body, {
        delegationOrigin: input.delegationOrigin,
        redelivery: true,
      });
    }
    if (admission.record.state === 'queued' || admission.duplicate) {
      input.logger.info('[CloudRun] Delegated delivery handed to ledger', {
        sessionId,
        runId: admission.record.runId,
        state: admission.record.state,
        queuePosition: admission.position?.queuePosition ?? null,
      });
      return 'queued';
    }
    try {
      await input.runInline(admission.body, admission.record.runId);
    } catch (error) {
      // rework r1：preflight 抛错（durable rollout 未 ready / 目录物化 IO /
      // fork lineage assert）时账本行已置 running 却无人收线，占死
      // CLOUD_RUN_MAX_IN_FLIGHT 之一直到进程重启。收线 failed 后原样抛出，
      // drain 的失败重投语义不变。
      input.logger.error('[CloudRun] Delegated inline run threw; settling ledger row failed', {
        sessionId,
        runId: admission.record.runId,
        error: error instanceof Error ? error.message : String(error),
      });
      input.runtime.settle(admission.record.runId, 'failed');
      throw error;
    }
    return 'ran';
  } catch (error) {
    if (error instanceof CloudRunAccountRequiredError) {
      input.logger.warn('[CloudRun] Delegated delivery to cloud-marked session refused: no verified account (fail-closed)', {
        sessionId,
        reason: 'cloud_account_required',
      });
    }
    throw error;
  }
}

export async function handleCloudRunAdmission(input: {
  body: AgentRunBody;
  res: Response;
  runtime: CloudRunRouteRuntime;
  runInline: (body: AgentRunBody, cloudRunId: string) => Promise<void>;
  logger?: WebRouteLogger;
}): Promise<void> {
  try {
    const admission = await input.runtime.admit(input.body);
    if (admission.record.state === 'queued' || admission.duplicate) {
      input.res.status(admission.record.state === 'queued' ? 202 : 200).json(
        queuePayload(admission.record, admission.position),
      );
      return;
    }
    try {
      await input.runInline(admission.body, admission.record.runId);
    } catch (error) {
      // rework r1：与 admitDelegatedTurn 同型兜底——runAgentTurn 的 preflight
      // 抛错（目录物化 / fork lineage assert）时账本行无人收线会占死并发额度。
      input.logger?.error('[CloudRun] Manual inline run threw; settling ledger row failed', {
        sessionId: admission.record.sessionId,
        runId: admission.record.runId,
        error: error instanceof Error ? error.message : String(error),
      });
      input.runtime.settle(admission.record.runId, 'failed');
      throw error;
    }
  } catch (error) {
    if (error instanceof CloudRunAccountRequiredError) {
      sendAccountRequired(input.res);
      return;
    }
    throw error;
  }
}

export function registerCloudRunRoutes(
  router: Router,
  input: {
    runtime: CloudRunRouteRuntime;
    runRegistry: RunRegistry;
    getReadService?: () => DurableRunReadService | undefined;
  },
): void {
  router.get('/cloud-runs/:runId', (req: Request, res: Response) => {
    try {
      const read = input.runtime.ledger().readRun(String(req.params.runId));
      if (!read) {
        res.status(404).json({ success: false, error: { code: 'CLOUD_RUN_NOT_FOUND' } });
        return;
      }
      res.json({
        runId: read.record.runId,
        sessionId: read.record.sessionId,
        state: read.record.state,
        queuePosition: read.position?.queuePosition ?? null,
        ahead: read.position?.ahead ?? null,
      });
    } catch (error) {
      if (error instanceof CloudRunAccountRequiredError) {
        sendAccountRequired(res);
        return;
      }
      throw error;
    }
  });

  router.post('/cloud-runs/:runId/cancel', async (req: Request, res: Response) => {
    try {
      const ledger = input.runtime.ledger();
      const read = ledger.readRun(String(req.params.runId));
      if (!read) {
        res.status(404).json({ success: false, error: { code: 'CLOUD_RUN_NOT_FOUND' } });
        return;
      }
      const { record } = read;
      if (record.state === 'queued') {
        input.runtime.settle(record.runId, 'cancelled');
        res.json({ runId: record.runId, status: 'cancelled' });
        return;
      }
      if (isTerminalCloudRunState(record.state)) {
        res.json({ runId: record.runId, status: record.state });
        return;
      }
      // 没绑 execution_run_id（admission 与 bind 之间的窗口）或执行体已不在 registry：
      // 只能记 cancel_requested_at 标记回 202；标记由 bindExecutionRunId 消费。
      // 反之只要执行体还活着就真停——哪怕标记已写过（早期取消不再把后续取消
      // 永久短路成 202），cancel 本身幂等、重复投递是 registry 的既定契约。
      const executionRunId = record.executionRunId;
      const target = executionRunId !== null ? input.runRegistry.get(executionRunId) : undefined;
      if (!executionRunId || !target) {
        ledger.requestCancel(record.runId);
        res.status(202).json({ runId: record.runId, status: 'cancel_requested', code: 'CANCEL_REQUESTED' });
        return;
      }

      ledger.requestCancel(record.runId);
      await target.cancel('user');
      const settlement = await waitForCancelSettlement({
        runId: executionRunId,
        sessionId: record.sessionId,
        runRegistry: input.runRegistry,
        readService: input.getReadService?.(),
        timeoutMs: CANCELLATION_TIMEOUTS.ROUTE_SETTLE_WAIT,
        pollMs: CANCELLATION_TIMEOUTS.ROUTE_SETTLE_POLL,
      });
      if (settlement === 'timeout') {
        res.status(202).json({ runId: record.runId, status: 'cancel_requested', code: 'CANCEL_REQUESTED' });
        return;
      }

      const current = ledger.getRun(record.runId);
      if (current && !isTerminalCloudRunState(current.state)) {
        input.runtime.settle(record.runId, 'cancelled');
      }
      res.json({ runId: record.runId, status: ledger.getRun(record.runId)?.state ?? 'cancelled' });
    } catch (error) {
      if (error instanceof CloudRunAccountRequiredError) {
        sendAccountRequired(res);
        return;
      }
      throw error;
    }
  });
}
