import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import type { Response } from 'express';

import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { createCloudRunLedger, type CloudRunLedger } from '../../../src/host/services/cloudRun/cloudRunLedger';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { QueuedInputRepository } from '../../../src/host/services/core/repositories/QueuedInputRepository';
import { SessionDelegationRepository } from '../../../src/host/services/core/repositories/SessionDelegationRepository';
import { createDelegationDrainHooks } from '../../../src/host/services/delegation/delegationDrainHooks';
import type { DelegationOriginMarker } from '../../../src/shared/contract/queuedInput';
import { admitDelegatedTurn, CloudRunRouteRuntime } from '../../../src/web/routes/cloudRunRoutes';
import { buildQueuedAgentRunBody } from '../../../src/web/routes/agent';
import type { AgentRunBody } from '../../../src/web/routes/agentBodySchemas';
import { createWebQueuedInputDrain } from '../../../src/web/routes/webQueuedInputDrain';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const ACCOUNT = 'acct_delegate';
const ORIGIN: DelegationOriginMarker = { delegationId: 'dlg_1', actionFingerprint: 'fp_1' };
const CLOUD_MARKER = { executionEnvironment: { kind: 'cloud', environmentId: 'cloud-test', setAt: 1 } };

interface TurnCall { body: AgentRunBody; cloudRunId?: string; delegationOrigin?: DelegationOriginMarker }

interface TurnOptions {
  delegationOrigin?: DelegationOriginMarker;
  onDurableActivated?: (activation: { runId: string; activatedAt: number }) => void;
}

describe('delegated delivery into a cloud-marked session goes through admit(delegate) (ADR-087 S4B)', () => {
  let db: BetterSqlite3.Database;
  let ledger: CloudRunLedger;
  let account: string | null;
  let calls: TurnCall[];
  let runtime: CloudRunRouteRuntime;
  let queuedRepo: QueuedInputRepository;
  let metadata: Record<string, Record<string, unknown> | undefined>;
  let drainErrors: unknown[];
  let inlineFailure: Error | null;
  let runSeq: number;

  // 与 agent.ts 里 runAgentTurn 的角色同构：记录 options 里的 cloudRunId /
  // delegationOrigin；run 注册成功即触发 onDurableActivated（对齐真实现
  // bindExecutionRunId 之后的激活点）。inlineFailure 模拟 preflight 抛错。
  const runAgentTurn = async (body: AgentRunBody, cloudRunId?: string, options?: TurnOptions) => {
    if (inlineFailure) throw inlineFailure;
    calls.push({ body, cloudRunId, delegationOrigin: options?.delegationOrigin });
    options?.onDurableActivated?.({ runId: `run_${++runSeq}`, activatedAt: 1 });
  };

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db, logger as never);
    account = ACCOUNT;
    calls = [];
    drainErrors = [];
    inlineFailure = null;
    runSeq = 0;
    metadata = { 'sess-cloud': CLOUD_MARKER, 'sess-local': {} };
    ledger = createCloudRunLedger({ db, clock: () => 1_700_000_000_000, accountResolver: () => account });
    runtime = new CloudRunRouteRuntime({
      getLedger: () => ledger,
      runRegistry: new RunRegistry(),
      execute: (body, cloudRunId, options) => runAgentTurn(body, cloudRunId, options),
      logger,
    });
    runtime.ledger();
    queuedRepo = new QueuedInputRepository(db);
    vi.clearAllMocks();
  });

  afterEach(() => db.close());

  function makeDrain() {
    return createWebQueuedInputDrain({
      getRepository: () => queuedRepo,
      hasActiveRun: () => false,
      runEnvelope: async (envelope, _res: Response, onActivated, options) => {
        const body = buildQueuedAgentRunBody(envelope);
        const origin = options?.delegationOrigin;
        const verdict = origin
          ? await admitDelegatedTurn({
            runtime,
            body,
            delegationOrigin: origin,
            logger,
            readSessionMetadata: async (sid) => metadata[sid],
            runInline: (b, runId) => runAgentTurn(b, runId, { delegationOrigin: origin, onDurableActivated: onActivated }),
          })
          : 'direct';
        if (verdict === 'direct') {
          await runAgentTurn(body, undefined, { delegationOrigin: origin, onDurableActivated: onActivated });
        }
      },
      emitAgentEvent: () => {},
      notifyQueuedInputSettled: () => {},
      notifyQueuedInputActivated: () => {},
      delegation: {
        beforeClaim: () => ({ kind: 'deliver', delegationOrigin: ORIGIN }),
        onActivated: () => {},
        onClaimConflict: () => {},
        onRetryExhausted: () => {},
        projectTerminal: () => {},
      },
      logger: { ...logger, error: (...args: unknown[]) => { drainErrors.push(args); } },
    });
  }

  async function deliver(id: string, sessionId: string) {
    queuedRepo.enqueue({ id, sessionId, envelope: { content: `work ${id}`, sessionId }, now: 1 });
    makeDrain().handleEnqueued(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  async function drainWaiting(sessionId: string) {
    makeDrain().handleEnqueued(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  function fillQuota() {
    const a = ledger.admit({ sessionId: 'busy-1', trigger: 'manual', requestJson: '{"prompt":"a"}' });
    const b = ledger.admit({ sessionId: 'busy-2', trigger: 'manual', requestJson: '{"prompt":"b"}' });
    return [a.record.runId, b.record.runId];
  }

  function delegateRunId(): string {
    return (db.prepare("SELECT run_id FROM cloud_runs WHERE trigger = 'delegate'").get() as { run_id: string }).run_id;
  }

  it('① at 2 in-flight a delegated delivery is queued at position 1, not run, in-flight stays 2', async () => {
    fillQuota();
    await deliver('q1', 'sess-cloud');
    expect(calls).toEqual([]);
    expect(ledger.countInFlight(ACCOUNT)).toBe(2);
    const read = runtime.readRun(delegateRunId());
    expect(read?.record.state).toBe('queued');
    expect(read?.position?.queuePosition).toBe(1);
    expect(queuedRepo.getById('q1')?.status).toBe('consumed');
  });

  it('②③ manual queued earlier + delegate queued later promote in submit order; delegate runs once with origin', async () => {
    const [first] = fillQuota();
    const manual = await runtime.admit({ prompt: 'm', sessionId: 'sess-manual', clientMessageId: 'cm1' });
    expect(manual.record.state).toBe('queued');
    await deliver('q2', 'sess-cloud');
    const delegateId = delegateRunId();
    expect(runtime.readRun(manual.record.runId)?.position?.queuePosition).toBe(1);
    expect(runtime.readRun(delegateId)?.position?.queuePosition).toBe(2);

    runtime.settle(first, 'succeeded');
    expect(calls.map((c) => c.body.prompt)).toEqual(['m']);
    expect(calls[0].delegationOrigin).toBeUndefined();
    expect(ledger.countInFlight(ACCOUNT)).toBe(2);

    runtime.settle(manual.record.runId, 'succeeded');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      cloudRunId: delegateId,
      delegationOrigin: ORIGIN,
      body: { prompt: 'work q2', sessionId: 'sess-cloud' },
    });

    // 再次 sweep（含重启 sweep）不得重复执行
    await runtime.runStartupSweep();
    expect(calls).toHaveLength(2);
    expect(ledger.getRun(delegateId)?.state).toBe('interrupted');
  });

  it('with a free slot a delegated delivery runs inline once with cloudRunId + origin', async () => {
    await deliver('q3', 'sess-cloud');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ delegationOrigin: ORIGIN, body: { prompt: 'work q3' } });
    expect(calls[0].cloudRunId).toBe(delegateRunId());
  });

  it('④ a non-marked target session keeps the direct path and never touches the ledger', async () => {
    fillQuota();
    await deliver('q4', 'sess-local');
    expect(calls).toHaveLength(1);
    expect(calls[0].cloudRunId).toBeUndefined();
    expect(calls[0].delegationOrigin).toEqual(ORIGIN);
    expect(db.prepare("SELECT COUNT(*) AS n FROM cloud_runs WHERE trigger = 'delegate'").get()).toEqual({ n: 0 });
  });

  it('⑤ without a verified account the delivery is not executed and a distinguishable warn is logged', async () => {
    account = null;
    await deliver('q5', 'sess-cloud');
    expect(calls).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no verified account (fail-closed)'),
      expect.objectContaining({ reason: 'cloud_account_required', sessionId: 'sess-cloud' }),
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM cloud_runs').get()).toEqual({ n: 0 });
  });

  it('a persisted delegate row with a broken origin settles failed and logs instead of running', async () => {
    const [first] = fillQuota();
    const bad = ledger.admit({
      sessionId: 'sess-cloud',
      trigger: 'delegate',
      requestJson: JSON.stringify({ body: { prompt: 'x', sessionId: 'sess-cloud' } }),
    });
    runtime.settle(first, 'succeeded');
    expect(calls).toEqual([]);
    expect(ledger.getRun(bad.record.runId)?.state).toBe('failed');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('no valid delegationOrigin'),
      expect.anything(),
    );
  });

  // ── rework r1：PR 评审三条 Important 的回归 ───────────────────────────

  it('r1-① inline preflight throw settles the ledger row failed (not stuck running) and the drain requeues for retry', async () => {
    inlineFailure = new Error('Durable Run persistence is unavailable');
    await deliver('q1', 'sess-cloud');
    const runId = delegateRunId();
    expect(ledger.getRun(runId)?.state).toBe('failed');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Delegated inline run threw'),
      expect.objectContaining({ sessionId: 'sess-cloud', runId }),
    );
    const row = queuedRepo.getById('q1');
    expect(row?.status).toBe('queued');
    expect(row?.retryCount).toBe(1);
    expect(ledger.countInFlight(ACCOUNT)).toBe(0);
  });

  it('r1-② a redelivery whose earlier delegate row failed re-runs instead of being silently consumed', async () => {
    inlineFailure = new Error('Durable Run persistence is unavailable');
    await deliver('q1', 'sess-cloud');
    const failedRunId = delegateRunId();
    expect(queuedRepo.getById('q1')?.status).toBe('queued');

    inlineFailure = null;
    await drainWaiting('sess-cloud');

    const rows = db.prepare(
      "SELECT run_id, state FROM cloud_runs WHERE trigger = 'delegate' ORDER BY enqueued_seq",
    ).all() as { run_id: string; state: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ run_id: failedRunId, state: 'failed' });
    expect(rows[1].state).toBe('running');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ delegationOrigin: ORIGIN, cloudRunId: rows[1].run_id });
    expect(queuedRepo.getById('q1')?.status).toBe('consumed');
  });

  it('r1-②b duplicate whose row is still queued stays handed over: no fresh row, no run', async () => {
    fillQuota();
    await deliver('q1', 'sess-cloud');
    expect(queuedRepo.getById('q1')?.status).toBe('consumed');
    const verdict = await admitDelegatedTurn({
      runtime,
      body: buildQueuedAgentRunBody({ content: 'work q1', sessionId: 'sess-cloud', clientMessageId: 'q1' }),
      delegationOrigin: ORIGIN,
      logger,
      readSessionMetadata: async (sid) => metadata[sid],
      runInline: (b, runId) => runAgentTurn(b, runId, { delegationOrigin: ORIGIN }),
    });
    expect(verdict).toBe('queued');
    expect(db.prepare("SELECT COUNT(*) AS n FROM cloud_runs WHERE trigger = 'delegate'").get()).toEqual({ n: 1 });
    expect(calls).toEqual([]);
  });

  it('r1-②c duplicate whose row succeeded stays consumed: no duplicate turn', async () => {
    await deliver('q1', 'sess-cloud');
    runtime.settle(delegateRunId(), 'succeeded');
    const verdict = await admitDelegatedTurn({
      runtime,
      body: buildQueuedAgentRunBody({ content: 'work q1', sessionId: 'sess-cloud', clientMessageId: 'q1' }),
      delegationOrigin: ORIGIN,
      logger,
      readSessionMetadata: async (sid) => metadata[sid],
      runInline: (b, runId) => runAgentTurn(b, runId, { delegationOrigin: ORIGIN }),
    });
    expect(verdict).toBe('queued');
    expect(calls).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cloud_runs').get()).toEqual({ n: 1 });
  });

  it('r1-③ a queued delegate row promoted later backfills the delegation row target_run_id (INV-4)', async () => {
    const delegations = new SessionDelegationRepository(db);
    delegations.insertOrGet({
      delegationId: 'dlg_1',
      originSessionId: 'sess-origin',
      originTurnId: 'turn_1',
      disposition: 'create_new',
      targetSessionId: 'sess-cloud',
      targetQueuedInputId: 'q9',
      submissionKey: 'sub_1',
      actionFingerprint: 'fp_1',
      createdAt: 1,
    });
    // 与 agent.ts 生产同构：onDelegateRunActivated → delegationHooks.onActivated
    // （真 createDelegationDrainHooks + 真 SessionDelegationRepository 回填）。
    // 换新 ledger：beforeEach 的旧 runtime 已在本 ledger 上挂了 transition
    // 监听，会抢先 promote（用它那份没有 onDelegateRunActivated 的 execute）。
    const delegationHooks = createDelegationDrainHooks({
      getDb: () => db,
      getSessionRow: () => null,
      getPermissionMode: () => null,
      evaluateFolderTrust: async () => ({ state: 'trusted', blockedItems: 0 }),
      getActiveRunId: () => null,
      logger,
    });
    ledger = createCloudRunLedger({ db, clock: () => 1_700_000_000_000, accountResolver: () => account });
    runtime = new CloudRunRouteRuntime({
      getLedger: () => ledger,
      runRegistry: new RunRegistry(),
      execute: (body, cloudRunId, options) => runAgentTurn(body, cloudRunId, options),
      onDelegateRunActivated: ({ queuedInputId, sessionId, runId }) =>
        delegationHooks.onActivated({ id: queuedInputId, sessionId }, { runId }),
      logger,
    });
    runtime.ledger();

    const [first, second] = fillQuota();
    await deliver('q9', 'sess-cloud');
    expect(queuedRepo.getById('q9')?.status).toBe('consumed');
    expect(delegations.getByTargetQueuedInputId('q9')?.targetRunId).toBeNull();

    runtime.settle(first, 'succeeded');
    runtime.settle(second, 'succeeded');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(delegations.getByTargetQueuedInputId('q9')?.targetRunId).toBe('run_1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ delegationOrigin: ORIGIN });
  });
});
