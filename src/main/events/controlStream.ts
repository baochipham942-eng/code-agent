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
