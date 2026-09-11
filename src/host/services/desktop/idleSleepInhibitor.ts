import { spawn, type ChildProcess } from 'node:child_process';
import process from 'node:process';

export type IdleSleepInhibitorState = 'released' | 'inhibited' | 'unavailable';
export type IdleSleepInhibitorReason = 'no-trigger' | 'running-run' | 'paired-companion' | 'unsupported-platform' | 'start-failed' | 'release-failed';

export interface IdleSleepInhibitorOptions {
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
  pollMs?: number;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void; info?(message: string, meta?: Record<string, unknown>): void };
}

/** Prevents system idle sleep while a run is active or a companion is paired. Lid-close sleep is OS-owned. */
export class IdleSleepInhibitor {
  private child: ChildProcess | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: IdleSleepInhibitorState = 'released';
  private reason: IdleSleepInhibitorReason = 'no-trigger';
  private readonly platform: NodeJS.Platform;
  private readonly spawnProcess: typeof spawn;
  private readonly pollMs: number;
  private readonly logger?: IdleSleepInhibitorOptions['logger'];

  constructor(
    private readonly hasRunningRun: () => boolean,
    private readonly hasPairedCompanion: () => boolean,
    options: IdleSleepInhibitorOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.spawnProcess = options.spawn ?? spawn;
    this.pollMs = options.pollMs ?? 1_000;
    this.logger = options.logger;
  }

  getStatus(): { state: IdleSleepInhibitorState; reason: IdleSleepInhibitorReason } {
    return { state: this.state, reason: this.reason };
  }

  start(): void {
    if (this.timer) return;
    void this.reconcile();
    this.timer = setInterval(() => { void this.reconcile(); }, this.pollMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.release();
  }

  async reconcile(): Promise<void> {
    const running = this.hasRunningRun();
    const paired = this.hasPairedCompanion();
    if (!running && !paired) {
      await this.release();
      this.reason = 'no-trigger';
      if (this.state !== 'unavailable') this.state = 'released';
      return;
    }
    this.reason = running ? 'running-run' : 'paired-companion';
    if (this.child || (this.state === 'unavailable' && this.platform !== 'darwin')) return;
    if (this.platform !== 'darwin') {
      this.state = 'unavailable';
      this.reason = 'unsupported-platform';
      this.logger?.warn('Idle sleep inhibition unavailable on this platform', { platform: this.platform });
      return;
    }
    try {
      const child = this.spawnProcess('/usr/bin/caffeinate', ['-i'], { stdio: 'ignore' });
      this.child = child;
      child.once('exit', (code, signal) => {
        this.child = null;
        if (this.state === 'inhibited') {
          this.state = 'unavailable';
          this.reason = 'start-failed';
          this.logger?.warn('Idle sleep inhibition process exited unexpectedly', { code, signal });
        }
      });
      child.once('error', (error) => {
        this.child = null;
        this.state = 'unavailable';
        this.reason = 'start-failed';
        this.logger?.warn('Failed to start idle sleep inhibition', { error: String(error) });
      });
      this.state = 'inhibited';
      this.logger?.info?.('Idle sleep inhibition enabled', { reason: this.reason });
    } catch (error) {
      this.state = 'unavailable';
      this.reason = 'start-failed';
      this.logger?.warn('Failed to start idle sleep inhibition', { error: String(error) });
    }
  }

  private async release(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    try {
      child.kill('SIGTERM');
      this.state = 'released';
      this.logger?.info?.('Idle sleep inhibition released');
    } catch (error) {
      this.state = 'unavailable';
      this.reason = 'release-failed';
      this.logger?.warn('Failed to release idle sleep inhibition', { error: String(error) });
    }
  }
}
