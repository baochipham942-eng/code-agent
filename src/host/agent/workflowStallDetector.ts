import { ACTIVITY_TYPES, type ScriptRunEvent } from '../../shared/contract/scriptRun';
import { WORKFLOW_STALL_THRESHOLDS } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';

interface WorkflowStallJournal {
  recordStallNotice(runId: string, epoch: number, announcedAt?: number): boolean;
  getMaxStallEpoch(runId: string): number;
}

export interface WorkflowStallDetectorLogger {
  warn(message: string, details?: Record<string, unknown>): void;
}

type StallTimer = ReturnType<typeof setTimeout>;

export interface WorkflowStallDetectorOptions {
  journal: WorkflowStallJournal | null;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => StallTimer;
  clearTimer?: (timer: StallTimer) => void;
  logger?: WorkflowStallDetectorLogger;
}

interface RunState {
  lastProgressAt: number;
  /** Start of the current no-progress window; distinct from lastProgressAt so a notice is not progress. */
  windowStartedAt: number;
  epoch: number;
  inFlightCalls: number;
  parked: boolean;
  parkedAt?: number;
  timer?: StallTimer;
}

const TERMINAL_EVENTS = new Set<ScriptRunEvent['type']>(['run:done', 'run:cancelled', 'run:error']);

/**
 * Host-only detector for background dynamic-workflow runs.
 * It deliberately has no notification or registry dependency: a hard stall only writes a durable
 * (run, epoch) key and one warning, leaving model-facing notice delivery to a later work item.
 */
export class WorkflowStallDetector {
  private readonly runs = new Map<string, RunState>();
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => StallTimer;
  private readonly clearTimer: (timer: StallTimer) => void;
  private readonly logger: WorkflowStallDetectorLogger;

  constructor(private readonly options: WorkflowStallDetectorOptions) {
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.logger = options.logger ?? createLogger('WorkflowStallDetector');
  }

  /** Start one adopted background run, seeding the epoch from the durable journal when available. */
  startRun(runId: string): void {
    if (this.runs.has(runId)) return;
    const now = this.now();
    let epoch = 0;
    if (this.options.journal) {
      try {
        epoch = this.options.journal.getMaxStallEpoch(runId);
      } catch (error) {
        this.warnDowngrade(runId, `journal read failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      this.warnDowngrade(runId, 'workflow journal repository is unavailable');
    }
    const state: RunState = {
      lastProgressAt: now,
      windowStartedAt: now,
      epoch,
      inFlightCalls: 0,
      parked: false,
    };
    this.runs.set(runId, state);
    if (epoch < WORKFLOW_STALL_THRESHOLDS.MAX_EPOCHS) this.schedule(runId, state);
  }

  /** Consume a ScriptRunEvent. Activity refreshes the clock; terminal events stop it. */
  handleEvent(event: ScriptRunEvent): void {
    const state = this.runs.get(event.runId);
    if (!state) return;
    if (TERMINAL_EVENTS.has(event.type)) {
      this.stopRun(event.runId);
      return;
    }
    if (!ACTIVITY_TYPES.has(event.type)) return;
    const now = this.now();
    state.lastProgressAt = now;
    state.windowStartedAt = now;
    if (event.type === 'agent:start') state.inFlightCalls += 1;
    if (event.type === 'agent:done' || event.type === 'agent:error') {
      state.inFlightCalls = Math.max(0, state.inFlightCalls - 1);
    }
    if (!state.parked) this.schedule(event.runId, state);
  }

  /** Pause/resume the active-time clock while a run is waiting for approval or review. */
  setParked(runId: string, parked: boolean): void {
    const state = this.runs.get(runId);
    if (!state || state.parked === parked) return;
    const now = this.now();
    if (parked) {
      state.parked = true;
      state.parkedAt = now;
      this.clearScheduledTimer(state);
      return;
    }
    const pausedFor = Math.max(0, now - (state.parkedAt ?? now));
    state.lastProgressAt += pausedFor;
    state.windowStartedAt += pausedFor;
    state.parkedAt = undefined;
    state.parked = false;
    this.schedule(runId, state);
  }

  /** Stop and forget one run, including its timer. */
  stopRun(runId: string): void {
    const state = this.runs.get(runId);
    if (!state) return;
    this.clearScheduledTimer(state);
    this.runs.delete(runId);
  }

  /** Stop all timers; useful during host shutdown and hermetic tests. */
  stopAll(): void {
    for (const runId of this.runs.keys()) this.stopRun(runId);
  }

  private schedule(runId: string, state: RunState): void {
    this.clearScheduledTimer(state);
    if (state.parked || state.epoch >= WORKFLOW_STALL_THRESHOLDS.MAX_EPOCHS) return;
    const threshold = state.inFlightCalls > 0
      ? WORKFLOW_STALL_THRESHOLDS.SINGLE_CALL_MS
      : WORKFLOW_STALL_THRESHOLDS.N_HARD_MS;
    const elapsed = Math.max(0, this.now() - state.windowStartedAt);
    const delay = Math.max(1, threshold - elapsed + 1);
    state.timer = this.setTimer(() => {
      state.timer = undefined;
      this.check(runId);
    }, delay);
    const timer = state.timer as StallTimer & { unref?: () => void };
    timer.unref?.();
  }

  private check(runId: string): void {
    const state = this.runs.get(runId);
    if (!state || state.parked) return;
    const now = this.now();
    const threshold = state.inFlightCalls > 0
      ? WORKFLOW_STALL_THRESHOLDS.SINGLE_CALL_MS
      : WORKFLOW_STALL_THRESHOLDS.N_HARD_MS;
    if (now - state.windowStartedAt <= threshold) {
      this.schedule(runId, state);
      return;
    }

    const epoch = state.epoch + 1;
    let announce = true;
    if (this.options.journal) {
      try {
        // Durable write is intentionally before the warning that announces the stall.
        announce = this.options.journal.recordStallNotice(runId, epoch, now);
      } catch (error) {
        announce = false;
        this.warnDowngrade(runId, `journal write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    state.epoch = epoch;
    state.windowStartedAt = now;
    if (announce) {
      this.logger.warn('workflow run stalled', {
        runId,
        epoch,
        idleSeconds: Math.floor(Math.max(0, now - state.lastProgressAt) / 1000),
      });
    }
    if (state.epoch < WORKFLOW_STALL_THRESHOLDS.MAX_EPOCHS) this.schedule(runId, state);
  }

  private clearScheduledTimer(state: RunState): void {
    if (state.timer === undefined) return;
    this.clearTimer(state.timer);
    state.timer = undefined;
  }

  private warnDowngrade(runId: string, reason: string): void {
    this.logger.warn('workflow stall detector downgraded to in-process epochs', { runId, reason });
  }
}
