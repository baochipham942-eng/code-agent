// ComputerSurface 全局互斥锁。
//
// 共享桌面 / 全局键鼠 / frontmost 焦点都是不可池化的独占资源：多 agent 同时
// type/key/click 必然抢焦点，输入串到错误窗口。所有 write 动作（type/key/
// click/scroll/drag/open_application/macOS/AX/CGEvent 三条 surface 路径）
// 必须串行经过这把锁。read 动作（observe/get_state/get_ax_elements/
// get_windows/diagnose_app）不进锁——同 agent 内嵌套 observe→write 也不会死锁。
//
// 实现是一个 max=1 的 FIFO mutex，与 playwrightLaunchSemaphore 的语义同形
// （限并发资源），但用途和实例独立。

export interface ComputerSurfaceLockSlot {
  release: () => void;
}

class ComputerSurfaceMutex {
  private active = false;
  private queue: Array<() => void> = [];
  private released = new WeakSet<ComputerSurfaceLockSlot>();

  async acquire(): Promise<ComputerSurfaceLockSlot> {
    if (!this.active) {
      this.active = true;
      return this.makeSlot();
    }
    return new Promise<ComputerSurfaceLockSlot>((resolve) => {
      this.queue.push(() => {
        this.active = true;
        resolve(this.makeSlot());
      });
    });
  }

  isHeld(): boolean {
    return this.active;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  private makeSlot(): ComputerSurfaceLockSlot {
    const slot: ComputerSurfaceLockSlot = {
      release: () => {
        if (this.released.has(slot)) return;
        this.released.add(slot);
        this.active = false;
        const next = this.queue.shift();
        if (next) next();
      },
    };
    return slot;
  }
}

const mutex = new ComputerSurfaceMutex();

export function acquireComputerSurfaceLock(): Promise<ComputerSurfaceLockSlot> {
  return mutex.acquire();
}

export function getComputerSurfaceLockStats(): { held: boolean; queued: number } {
  return { held: mutex.isHeld(), queued: mutex.getQueueLength() };
}

export { ComputerSurfaceMutex };
