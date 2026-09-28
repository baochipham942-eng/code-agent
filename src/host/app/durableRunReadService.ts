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
    return selected.source === 'durable'
      ? mapDurableRunView(consumer, selected.value)
      : mapLegacyRunView(consumer, sessionId, selected.value);
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
  if (view.status === 'recovering' && view.interruptCause === 'crash_or_quit') {
    return {
      runId: view.runId,
      mode: isDurableResumeQueued(view.runId) ? 'queued' : 'auto-resuming',
      interruptCause: view.interruptCause,
      autoResumeCount,
      maxAutoResumeCount: MAX_AUTO_RESUME_COUNT,
      canContinue: false,
    };
  }
  const canContinue = view.status === 'waiting' && (
    view.interruptCause !== 'crash_or_quit' || autoResumeCount >= MAX_AUTO_RESUME_COUNT
  );
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
