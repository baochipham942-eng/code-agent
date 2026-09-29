import {
  getRunInterruptCause,
  MAX_AUTO_RESUME_COUNT,
  type RunEngineRef,
  type RunEnvelope,
  type RunInterruptCause,
  type RunStatus,
} from '../../shared/contract/durableRun';
import type { DurableResumeState, SessionStatus } from '../../shared/contract/session';
import { isDurableResumeQueued } from '../runtime/durableRecoveryQueueState';
import {
  readWithDurablePreference,
  type DurableRunFactReader,
  type DurableRunRolloutPolicy,
} from './durableRunRollout';

export type DurableRunConsumer =
  | 'native_status'
  | 'native_control'
  | 'agent_team_auto_agent'
  | 'dynamic_workflow'
  | 'external_engine'
  | 'session_replay';

export interface DurableRunView {
  source: 'durable' | 'legacy';
  consumer: DurableRunConsumer;
  runId: string | null;
  sessionId: string;
  status: RunStatus | 'idle' | 'unknown';
  engine: RunEngineRef | null;
  terminal: boolean;
  attempt?: number;
  updatedAt?: number;
  interruptCause?: RunInterruptCause;
  autoResumeCount?: number;
  /** 本进程能否接手这条停靠 run（重启后未被认领的旧 run 为 false，「继续」会找不到它）。 */
  continuable?: boolean;
}

export interface LegacyRunViewInput {
  runId?: string | null;
  status?: RunStatus | 'idle' | 'unknown';
  engine?: RunEngineRef | null;
  terminal?: boolean;
  updatedAt?: number;
}

export class DurableRunReadService {
  constructor(
    readonly policy: DurableRunRolloutPolicy,
    private readonly reader: DurableRunFactReader | null,
    private readonly canContinueRun?: (runId: string) => boolean,
  ) {}

  async read(
    consumer: DurableRunConsumer,
    sessionId: string,
    readLegacy: () => LegacyRunViewInput | Promise<LegacyRunViewInput>,
  ): Promise<DurableRunView> {
    const selected = await readWithDurablePreference({
      policy: this.policy,
      reader: this.reader,
      sessionId,
      readLegacy,
    });
    if (selected.source !== 'durable') return mapLegacyRunView(consumer, sessionId, selected.value);
    const view = mapDurableRunView(consumer, selected.value);
    return this.canContinueRun && view.runId ? { ...view, continuable: this.canContinueRun(view.runId) } : view;
  }

  readNativeStatus(sessionId: string, legacy: () => LegacyRunViewInput | Promise<LegacyRunViewInput>) {
    return this.read('native_status', sessionId, legacy);
  }

  readNativeControl(sessionId: string, legacy: () => LegacyRunViewInput | Promise<LegacyRunViewInput>) {
    return this.read('native_control', sessionId, legacy);
  }

  readAgentTeamOrAutoAgent(sessionId: string, legacy: () => LegacyRunViewInput | Promise<LegacyRunViewInput>) {
    return this.read('agent_team_auto_agent', sessionId, legacy);
  }

  readDynamicWorkflow(sessionId: string, legacy: () => LegacyRunViewInput | Promise<LegacyRunViewInput>) {
    return this.read('dynamic_workflow', sessionId, legacy);
  }

  readExternalEngine(sessionId: string, legacy: () => LegacyRunViewInput | Promise<LegacyRunViewInput>) {
    return this.read('external_engine', sessionId, legacy);
  }

  readSessionReplay(sessionId: string, legacy: () => LegacyRunViewInput | Promise<LegacyRunViewInput>) {
    return this.read('session_replay', sessionId, legacy);
  }
}

export function mapDurableRunView(consumer: DurableRunConsumer, envelope: RunEnvelope): DurableRunView {
  return {
    source: 'durable',
    consumer,
    runId: envelope.runId,
    sessionId: envelope.sessionId,
    status: envelope.status,
    engine: envelope.engine,
    terminal: Boolean(envelope.terminal),
    attempt: envelope.attempt,
    updatedAt: envelope.updatedAt,
    ...(getRunInterruptCause(envelope) ? { interruptCause: getRunInterruptCause(envelope) } : {}),
    autoResumeCount: envelope.autoResumeCount ?? 0,
  };
}

export function mapLegacyRunView(
  consumer: DurableRunConsumer,
  sessionId: string,
  legacy: LegacyRunViewInput,
): DurableRunView {
  return {
    source: 'legacy',
    consumer,
    runId: legacy.runId ?? null,
    sessionId,
    status: legacy.status ?? 'unknown',
    engine: legacy.engine ?? null,
    terminal: legacy.terminal ?? false,
    ...(legacy.updatedAt === undefined ? {} : { updatedAt: legacy.updatedAt }),
  };
}

export function mapDurableRunToSessionStatus(status: DurableRunView['status']): SessionStatus {
  if (status === 'paused') return 'paused';
  if (status === 'created' || status === 'running' || status === 'waiting' || status === 'recovering') return 'running';
  if (status === 'failed') return 'error';
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'interrupted';
  return 'idle';
}

export function hasDurableWaitingApprovalRun(view: DurableRunView): boolean {
  return view.source === 'durable' && view.status === 'waiting';
}

export function projectDurableRunToSessionPayload(view: DurableRunView): {
  status: SessionStatus;
  durableWaitingInput?: true;
  durableResume?: DurableResumeState;
} {
  const durableResume = projectDurableResumeState(view);
  return {
    status: mapDurableRunToSessionStatus(view.status),
    ...(hasDurableWaitingApprovalRun(view) && durableResume?.mode !== 'continue'
      ? { durableWaitingInput: true as const }
      : {}),
    ...(durableResume ? { durableResume } : {}),
  };
}

function projectDurableResumeState(view: DurableRunView): DurableResumeState | undefined {
  if (view.source !== 'durable' || view.terminal || !view.runId || !view.interruptCause
    || view.engine?.kind === 'external_cli') return undefined;
  const autoResumeCount = view.autoResumeCount ?? 0;
  // A recovery attempt becomes `running` as soon as the engine loop starts.
  // Keep the single resume signal for that whole turn, using durable facts
  // rather than the short-lived `recovering` status. Fresh runs have neither
  // a crash cause nor a recovery attempt, so they remain unmarked.
  const isRecoveryAttempt = autoResumeCount > 0 || (view.attempt ?? 1) > 1;
  if ((view.status === 'recovering' || view.status === 'running')
    && view.interruptCause === 'crash_or_quit'
    && isRecoveryAttempt) {
    return {
      runId: view.runId,
      mode: isDurableResumeQueued(view.runId) ? 'queued' : 'auto-resuming',
      interruptCause: view.interruptCause,
      autoResumeCount,
      maxAutoResumeCount: MAX_AUTO_RESUME_COUNT,
      canContinue: false,
    };
  }
  // 按停靠标记（ADR-075 修订二）：crash_or_quit 的 waiting 是等审批，不出「继续」。
  const canContinue = view.status === 'waiting' && view.continuable !== false && view.interruptCause !== 'crash_or_quit';
  if (!canContinue) return undefined;
  return {
    runId: view.runId,
    mode: 'continue',
    interruptCause: view.interruptCause,
    autoResumeCount,
    maxAutoResumeCount: MAX_AUTO_RESUME_COUNT,
    canContinue: true,
  };
}
