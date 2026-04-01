import { AgentBus, MailboxMessage, getAgentBus } from './agentBus';

export interface MailboxBridgeConfig {
  agentId: string;
  pollIntervalMs?: number; // default: 1000
  onMessage: (message: MailboxMessage) => void;
}

export class MailboxBridge {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isProcessing = false;
  private bus: AgentBus;

  constructor(private config: MailboxBridgeConfig) {
    this.bus = getAgentBus();
    this.config.pollIntervalMs = this.config.pollIntervalMs ?? 1000;
  }

  start(): void {
    if (this.intervalId) return; // already started
    this.intervalId = setInterval(() => {
      this.pollOnce();
    }, this.config.pollIntervalMs!);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  isActive(): boolean {
    return this.intervalId !== null;
  }

  /**
   * Poll once. Returns number of messages processed.
   * Skips if already processing (reentrance guard).
   */
  pollOnce(): number {
    if (this.isProcessing) return 0;
    this.isProcessing = true;
    try {
      const messages = this.bus.pollMailbox(this.config.agentId);
      for (const msg of messages) {
        this.config.onMessage(msg);
      }
      return messages.length;
    } finally {
      this.isProcessing = false;
    }
  }
}
