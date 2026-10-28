import { randomUUID } from 'node:crypto';
import type { Request, Response, Router } from 'express';

import type { DurableRunReadService } from '../../host/app/durableRunReadService';
import type { RunRegistry } from '../../host/runtime/runRegistry';
import type { CloudRunLedger } from '../../host/services/cloudRun/cloudRunLedger';
import type { CloudRunRecord } from '../../host/services/core/repositories/CloudRunRepository';
import { CANCELLATION_TIMEOUTS } from '../../shared/constants';
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
  execute: (body: AgentRunBody, cloudRunId: string) => Promise<void>;
  logger: WebRouteLogger;
}

export class CloudRunRouteRuntime {
  private observedLedger: CloudRunLedger | null = null;
  private startupPromise: Promise<void> | null = null;

  constructor(private readonly deps: CloudRunRuntimeDeps) {}

  admit(body: AgentRunBody) {
    const sessionId = body.sessionId?.trim() || `web-session-${randomUUID()}`;
    const sanitizedBody = { ...body, sessionId };
    const admission = this.ledger().admit({
      sessionId,
      trigger: 'manual',
      requestJson: JSON.stringify(sanitizedBody),
      clientMessageId: body.clientMessageId,
    });
    return { ...admission, body: sanitizedBody };
  }

  bindExecutionRunId(cloudRunId: string, executionRunId: string): void {
    this.ledger().bindExecutionRunId(cloudRunId, executionRunId);
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
    let parsed: ReturnType<typeof AgentRunBodySchema.safeParse>;
    try {
      parsed = AgentRunBodySchema.safeParse(JSON.parse(record.requestJson ?? 'null'));
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
    void this.deps.execute(parsed.data, record.runId).catch((error: unknown) => {
      this.deps.logger.error(`[CloudRun] Promoted run ${record.runId} failed`, error);
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

export async function handleCloudRunAdmission(input: {
  body: AgentRunBody;
  res: Response;
  runtime: CloudRunRouteRuntime;
  runInline: (body: AgentRunBody, cloudRunId: string) => Promise<void>;
}): Promise<void> {
  try {
    const admission = input.runtime.admit(input.body);
    if (admission.record.state === 'queued' || admission.duplicate) {
      input.res.status(admission.record.state === 'queued' ? 202 : 200).json(
        queuePayload(admission.record, admission.position),
      );
      return;
    }
    await input.runInline(admission.body, admission.record.runId);
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
      if (record.cancelRequestedAt !== null || !record.executionRunId) {
        ledger.requestCancel(record.runId);
        res.status(202).json({ runId: record.runId, status: 'cancel_requested', code: 'CANCEL_REQUESTED' });
        return;
      }

      const executionRunId = record.executionRunId;
      ledger.requestCancel(record.runId);
      const target = input.runRegistry.get(executionRunId);
      if (target) await target.cancel('user');
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
