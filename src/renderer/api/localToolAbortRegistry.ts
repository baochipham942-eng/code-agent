interface LocalToolAbortEntry {
  runId: string;
  controller: AbortController;
}

/** Tracks renderer-to-Bridge requests by Native run, never by session. */
export class LocalToolAbortRegistry {
  private readonly entries = new Map<string, LocalToolAbortEntry>();

  register(toolCallId: string, runId: string, controller: AbortController): void {
    this.entries.get(toolCallId)?.controller.abort();
    this.entries.set(toolCallId, { runId, controller });
  }

  abortCall(toolCallId: string): void {
    this.entries.get(toolCallId)?.controller.abort();
  }

  abortRun(runId: string): void {
    for (const [toolCallId, entry] of this.entries) {
      if (entry.runId !== runId) continue;
      entry.controller.abort();
      this.entries.delete(toolCallId);
    }
  }

  delete(toolCallId: string, controller: AbortController): void {
    if (this.entries.get(toolCallId)?.controller === controller) {
      this.entries.delete(toolCallId);
    }
  }
}

export const localToolAbortRegistry = new LocalToolAbortRegistry();
