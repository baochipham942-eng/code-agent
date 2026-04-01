import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';

export interface StoredEvent {
  eventId: string;
  agentId: string;
  domain: string;
  type: string;
  data: unknown;
  timestamp: number;
}

export class InternalEventStore {
  private events: StoredEvent[] = [];
  private seenIds = new Set<string>();

  writeEvent(event: Omit<StoredEvent, 'eventId'>): string {
    const eventId = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (this.seenIds.has(eventId)) return eventId; // dedup
    this.seenIds.add(eventId);
    this.events.push({ ...event, eventId });
    return eventId;
  }

  readEvents(filter?: { domain?: string; type?: string; agentId?: string; since?: number }): StoredEvent[] {
    let result = [...this.events];
    if (filter?.domain) result = result.filter(e => e.domain === filter.domain);
    if (filter?.type) result = result.filter(e => e.type === filter.type);
    if (filter?.agentId) result = result.filter(e => e.agentId === filter.agentId);
    if (filter?.since != null) result = result.filter(e => e.timestamp >= filter.since!);
    return result;
  }

  getEventCount(): number { return this.events.length; }

  async flush(filePath: string): Promise<void> {
    const content = this.events.map(e => JSON.stringify(e)).join('\n') + '\n';
    await writeFile(filePath, content, 'utf-8');
  }

  static async loadFromFile(filePath: string): Promise<InternalEventStore> {
    const store = new InternalEventStore();
    if (!existsSync(filePath)) return store;
    const raw = await readFile(filePath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    for (const line of lines) {
      const event = JSON.parse(line) as StoredEvent;
      store.events.push(event);
      store.seenIds.add(event.eventId);
    }
    return store;
  }

  clear(): void {
    this.events = [];
    this.seenIds.clear();
  }
}

let instance: InternalEventStore | null = null;
export function getInternalEventStore(): InternalEventStore {
  if (!instance) instance = new InternalEventStore();
  return instance;
}
export function resetInternalEventStore(): void { instance = null; }
