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
  private failStreak = 0;
  private nextRetryAt = 0;
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
    // 短路：已有运行中 run 就不必再查配对（配对触发源要查 SQLite）。
    const running = this.hasRunningRun();
    const paired = !running && this.hasPairedCompanion();
    if (!running && !paired) {
      await this.release();
      this.reason = 'no-trigger';
      this.failStreak = 0;
      this.nextRetryAt = 0;
      // 触发源消失后状态必须归位 released，不留 {unavailable, no-trigger} 的矛盾组合。
      this.state = 'released';
      return;
    }
    this.reason = running ? 'running-run' : 'paired-companion';
    if (this.child) return;
    if (this.platform !== 'darwin') {
      this.state = 'unavailable';
      this.reason = 'unsupported-platform';
      this.logger?.warn('Idle sleep inhibition unavailable on this platform', { platform: this.platform });
      return;
    }
    // 持续失败要有退避：配对是持久状态，每秒 spawn 一次 + 一行 warn 没有自然终点。
    const now = Date.now();
    if (this.state === 'unavailable' && now < this.nextRetryAt) return;
    try {
      // -w 让 caffeinate 盯住宿主 pid：宿主被 SIGKILL/崩溃时它随之退出，
      // 不会 reparent 给 launchd 变成永久阻止休眠的孤儿。
      const child = this.spawnProcess('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      this.child = child;
      child.once('exit', (code, signal) => {
        // 只清自己那个 child 的句柄——release 后再 spawn 与旧 exit 事件交错时不能抹掉新句柄。
        if (this.child !== child) return;
        this.child = null;
        if (this.state === 'inhibited') {
          this.state = 'unavailable';
          this.reason = 'start-failed';
          this.logger?.warn('Idle sleep inhibition process exited unexpectedly', { code, signal });
        }
      });
      child.once('error', (error) => {
        if (this.child === child) this.child = null;
        this.state = 'unavailable';
        this.reason = 'start-failed';
        this.failStreak += 1;
        this.nextRetryAt = Date.now() + Math.min(2 ** this.failStreak, 60) * this.pollMs;
        this.logger?.warn('Failed to start idle sleep inhibition', { error: String(error) });
      });
      this.state = 'inhibited';
      this.failStreak = 0;
      this.nextRetryAt = 0;
      this.logger?.info?.('Idle sleep inhibition enabled', { reason: this.reason });
    } catch (error) {
      this.state = 'unavailable';
      this.reason = 'start-failed';
      this.failStreak += 1;
      this.nextRetryAt = Date.now() + Math.min(2 ** this.failStreak, 60) * this.pollMs;
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
