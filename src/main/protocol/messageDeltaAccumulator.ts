import type { AgentEvent, MessageSnapshotData } from '../../shared/contract';

interface AccumulatorEntry {
  sessionId: string;
  turnId?: string;
  messageId?: string;
  content: string;
  reasoning: string;
  lastDeltaSeq?: number;
  updatedAt: number;
}

function entryKey(sessionId: string): string {
  return sessionId;
}

function hasSnapshotContent(entry: AccumulatorEntry): boolean {
  return entry.content.length > 0 || entry.reasoning.length > 0;
}

export class MessageDeltaAccumulator {
  private entries = new Map<string, AccumulatorEntry>();

  apply(sessionId: string, event: AgentEvent, now: number = Date.now()): MessageSnapshotData | null {
    if (event.type === 'turn_start') {
      this.entries.set(entryKey(sessionId), {
        sessionId,
        turnId: event.data.turnId,
        messageId: event.data.turnId,
        content: '',
        reasoning: '',
        lastDeltaSeq: undefined,
        updatedAt: now,
      });
      return null;
    }

    if (event.type === 'message_delta') {
      const entry = this.getOrCreateEntry(sessionId, event.data.turnId, event.data.messageId, now);
      if (!this.acceptDelta(entry, event.data.deltaSeq)) return null;
      if (event.data.path === 'reasoning') {
        entry.reasoning = event.data.op === 'replace'
          ? event.data.text
          : entry.reasoning + event.data.text;
      } else {
        entry.content = event.data.op === 'replace'
          ? event.data.text
          : entry.content + event.data.text;
      }
      entry.updatedAt = now;
      return this.toSnapshot(entry, false);
    }

    if (event.type === 'stream_chunk' && event.data.content) {
      const entry = this.getOrCreateEntry(sessionId, event.data.turnId, event.data.turnId, now);
      entry.content += event.data.content;
      entry.updatedAt = now;
      return this.toSnapshot(entry, false);
    }

    if (event.type === 'stream_reasoning' && event.data.content) {
      const entry = this.getOrCreateEntry(sessionId, event.data.turnId, event.data.turnId, now);
      entry.reasoning += event.data.content;
      entry.updatedAt = now;
      return this.toSnapshot(entry, false);
    }

    if (event.type === 'message' && event.data.role === 'assistant') {
      const entry = this.getOrCreateEntry(sessionId, undefined, event.data.id, now);
      entry.messageId = event.data.id || entry.messageId;
      if (event.data.content) entry.content = event.data.content;
      if (event.data.reasoning) entry.reasoning = event.data.reasoning;
      entry.updatedAt = now;
      return this.toSnapshot(entry, false);
    }

    return null;
  }

  getSnapshot(sessionId: string, isFinal = false): MessageSnapshotData | null {
    const entry = this.entries.get(entryKey(sessionId));
    if (!entry || !hasSnapshotContent(entry)) return null;
    return this.toSnapshot(entry, isFinal);
  }

  clear(sessionId: string): void {
    this.entries.delete(entryKey(sessionId));
  }

  private getOrCreateEntry(
    sessionId: string,
    turnId: string | undefined,
    messageId: string | undefined,
    now: number,
  ): AccumulatorEntry {
    const key = entryKey(sessionId);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        sessionId,
        turnId,
        messageId,
        content: '',
        reasoning: '',
        lastDeltaSeq: undefined,
        updatedAt: now,
      };
      this.entries.set(key, entry);
    }
    if (turnId && !entry.turnId) entry.turnId = turnId;
    if (messageId && !entry.messageId) entry.messageId = messageId;
    return entry;
  }

  private acceptDelta(entry: AccumulatorEntry, deltaSeq: number | undefined): boolean {
    if (typeof deltaSeq !== 'number') return true;
    if (entry.lastDeltaSeq !== undefined && deltaSeq <= entry.lastDeltaSeq) return false;
    entry.lastDeltaSeq = deltaSeq;
    return true;
  }

  private toSnapshot(entry: AccumulatorEntry, isFinal: boolean): MessageSnapshotData {
    return {
      role: 'assistant',
      turnId: entry.turnId,
      messageId: entry.messageId,
      content: entry.content,
      ...(entry.reasoning ? { reasoning: entry.reasoning } : {}),
      isFinal,
      source: 'main_accumulator',
    };
  }
}
