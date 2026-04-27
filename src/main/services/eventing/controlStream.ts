// ============================================================================
// ControlStream — 轻量级同步事件派发流
// 原 src/main/events/controlStream.ts，P0-5 阶段 A 迁入 protocol 层；
// 2026-04-27 从 protocol/events/ 搬到 services/eventing/（runtime class）
// ============================================================================

export class ControlStream {
  private handlers: Array<(event: unknown) => void> = [];

  push(event: { domain: string; type: string; data: unknown; timestamp?: number }): void {
    const fullEvent = { ...event, timestamp: event.timestamp ?? Date.now() };
    for (const handler of this.handlers) {
      try { handler(fullEvent); } catch { /* best-effort */ }
    }
  }

  subscribe(handler: (event: unknown) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler);
    };
  }

  getSubscriberCount(): number { return this.handlers.length; }
}
