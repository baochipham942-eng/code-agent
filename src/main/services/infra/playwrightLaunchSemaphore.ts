// Playwright launch semaphore — 限制 ephemeral chromium 进程并发数。
//
// 现状：visualSmoke / gameArtifactValidator / interactionProbeRunner 三处都直接
// `chromium.launch()` 起独立 chromium 进程；多 agent 并发触发 artifact 验证时
// N 个 chromium 同时启动会烧 CPU + 抢内存，且 macOS 下 launch 本身慢（cold start ~2s）。
//
// 用一个 FIFO 信号量限并发到 2，超出排队等前一个 release。
// caller 必须在 finally 里调 release，否则会永远占着 slot。

const DEFAULT_MAX_CONCURRENT = 2;

export interface LaunchSlot {
  release: () => void;
}

export class PlaywrightLaunchSemaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  private released = new WeakSet<LaunchSlot>();

  constructor(private maxConcurrent: number = DEFAULT_MAX_CONCURRENT) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  async acquire(): Promise<LaunchSlot> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return this.makeSlot();
    }
    return new Promise<LaunchSlot>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(this.makeSlot());
      });
    });
  }

  getActiveCount(): number {
    return this.active;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  private makeSlot(): LaunchSlot {
    const slot: LaunchSlot = {
      release: () => {
        if (this.released.has(slot)) return;
        this.released.add(slot);
        this.active -= 1;
        const next = this.queue.shift();
        if (next) next();
      },
    };
    return slot;
  }
}

const semaphore = new PlaywrightLaunchSemaphore();

export function acquireLaunchSlot(): Promise<LaunchSlot> {
  return semaphore.acquire();
}

export function getLaunchSemaphoreStats(): { active: number; queued: number } {
  return { active: semaphore.getActiveCount(), queued: semaphore.getQueueLength() };
}
