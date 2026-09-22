// 前台一轮里「上次有可见进展」的观察器。90s 提示，5min 升级。
// 等审批或等用户回答时不报「等模型回响」。

export type StallPhase = 'tool' | 'model' | 'awaiting-approval' | 'awaiting-user';

export interface StallNotice {
  level: 'hint' | 'escalated';
  phase: 'tool' | 'model';
  detail: string;
}

const streamTicks = new Map<string, number>();

export function noteStreamProgress(sessionId: string): void {
  streamTicks.set(sessionId, (streamTicks.get(sessionId) ?? 0) + 1);
}

export function streamProgressOf(sessionId: string): number {
  return streamTicks.get(sessionId) ?? 0;
}

export function clearStreamProgress(sessionId: string): void {
  streamTicks.delete(sessionId);
}

const HINT_MS = 90_000;
const ESCALATE_MS = 5 * 60_000;

export class StallObserver {
  private lastProgressAt: number;
  private progressKey = '';
  private level: 'none' | 'hint' | 'escalated' = 'none';

  constructor(now: number) {
    this.lastProgressAt = now;
  }

  noteProgress(key: string, now: number): boolean {
    if (key === this.progressKey) return false;
    this.progressKey = key;
    this.lastProgressAt = now;
    this.level = 'none';
    return true;
  }

  tick(now: number, phase: StallPhase, detail: string): StallNotice | null {
    if (phase === 'awaiting-approval' || phase === 'awaiting-user') return null;
    const idle = now - this.lastProgressAt;
    if (idle >= ESCALATE_MS && this.level !== 'escalated') {
      this.level = 'escalated';
      return { level: 'escalated', phase, detail };
    }
    if (idle >= HINT_MS && this.level === 'none') {
      this.level = 'hint';
      return { level: 'hint', phase, detail };
    }
    return null;
  }
}

export function startForegroundStallWatch(input: {
  snapshot: () => { progressKey: string; phase: StallPhase; detail: string };
  emit: (notice: StallNotice) => void;
  clear: () => void;
  now?: () => number;
  intervalMs?: number;
}): () => void {
  const now = () => input.now?.() ?? Date.now();
  const observer = new StallObserver(now());
  const timer = setInterval(() => {
    const snap = input.snapshot();
    const at = now();
    if (observer.noteProgress(snap.progressKey, at)) input.clear();
    const notice = observer.tick(at, snap.phase, snap.detail);
    if (notice) input.emit(notice);
  }, input.intervalMs ?? 15_000);
  return () => clearInterval(timer);
}
