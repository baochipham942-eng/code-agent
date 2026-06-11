import type { Message } from '../../shared/contract';
import { createLogger } from '../services/infra/logger';
import {
  runCheckpointWriterAgent,
  type CheckpointWriterJob,
  type CheckpointWriterResult,
} from './checkpointWriterAgent';

const logger = createLogger('CheckpointWriterService');

export interface CheckpointWriterTrigger {
  sessionId: string;
  workingDirectory: string;
  messages: Message[];
  reason: CheckpointWriterJob['reason'];
  rootDir?: string;
  now?: number;
}

export interface CheckpointWriterTriggerResult {
  started: boolean;
  queued: boolean;
  skipped: boolean;
  reason: string;
}

export type CheckpointWriterRunner = (job: CheckpointWriterJob) => Promise<CheckpointWriterResult>;

interface WriterState {
  running: boolean;
  pending?: CheckpointWriterJob;
  inFlight?: Promise<void>;
  lastStartedAt?: number;
  lastFinishedAt?: number;
  lastMessageId?: string;
  lastResult?: CheckpointWriterResult;
}

export class CheckpointWriterService {
  private readonly states = new Map<string, WriterState>();
  private readonly runner: CheckpointWriterRunner;
  private readonly minMessagesBetweenPeriodicWrites: number;

  constructor(options: {
    runner?: CheckpointWriterRunner;
    minMessagesBetweenPeriodicWrites?: number;
  } = {}) {
    this.runner = options.runner ?? runCheckpointWriterAgent;
    this.minMessagesBetweenPeriodicWrites = options.minMessagesBetweenPeriodicWrites ?? 8;
  }

  trigger(input: CheckpointWriterTrigger): CheckpointWriterTriggerResult {
    if (!input.sessionId || input.messages.length === 0) {
      return { started: false, queued: false, skipped: true, reason: 'missing-session-or-messages' };
    }

    const job: CheckpointWriterJob = {
      sessionId: input.sessionId,
      workingDirectory: input.workingDirectory,
      messages: [...input.messages],
      reason: input.reason,
      rootDir: input.rootDir,
      now: input.now,
    };
    const state = this.states.get(input.sessionId) ?? { running: false };
    this.states.set(input.sessionId, state);

    if (state.running) {
      state.pending = job;
      return { started: false, queued: true, skipped: false, reason: 'writer-running-pending-replaced' };
    }

    this.start(input.sessionId, job, state);
    return { started: true, queued: false, skipped: false, reason: 'started' };
  }

  maybeTriggerPeriodic(input: Omit<CheckpointWriterTrigger, 'reason'>): CheckpointWriterTriggerResult {
    const lastMessageId = input.messages.at(-1)?.id;
    const state = this.states.get(input.sessionId);
    if (!lastMessageId) {
      return { started: false, queued: false, skipped: true, reason: 'no-last-message' };
    }
    if (state?.lastMessageId === lastMessageId) {
      return { started: false, queued: false, skipped: true, reason: 'same-watermark' };
    }
    const lastIndex = state?.lastMessageId
      ? input.messages.findIndex((message) => message.id === state.lastMessageId)
      : -1;
    const messagesSinceLast = lastIndex >= 0 ? input.messages.length - lastIndex - 1 : input.messages.length;
    if (messagesSinceLast < this.minMessagesBetweenPeriodicWrites) {
      return { started: false, queued: false, skipped: true, reason: 'periodic-watermark-not-reached' };
    }
    return this.trigger({ ...input, reason: 'periodic' });
  }

  getLastResult(sessionId: string): CheckpointWriterResult | undefined {
    return this.states.get(sessionId)?.lastResult;
  }

  async waitForIdle(sessionId: string, timeoutMs = 1_000): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const state = this.states.get(sessionId);
      if (!state?.running) return true;
      await state.inFlight;
    }
    return !this.states.get(sessionId)?.running;
  }

  private start(sessionId: string, job: CheckpointWriterJob, state: WriterState): void {
    state.running = true;
    state.lastStartedAt = Date.now();
    state.lastMessageId = job.messages.at(-1)?.id;
    state.inFlight = this.runner(job)
      .then((result) => {
        state.lastResult = result;
      })
      .catch((error) => {
        logger.warn('[CheckpointWriterService] background writer failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        state.running = false;
        state.lastFinishedAt = Date.now();
        const pending = state.pending;
        state.pending = undefined;
        if (pending) {
          this.start(sessionId, pending, state);
        }
      });
  }
}

const defaultCheckpointWriterService = new CheckpointWriterService();

export function getCheckpointWriterService(): CheckpointWriterService {
  return defaultCheckpointWriterService;
}

