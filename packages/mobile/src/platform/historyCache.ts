import { COMPANION_LIMITS as L } from '../../../../src/shared/constants/companion';
import type { CompanionEvent } from '../../../../src/shared/contract/companion';
import type { CompanionHistory } from '../../../../src/shared/contract/companionLibrary';

export interface CachedMessage {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  truncated?: boolean;
}

export interface HistoryCacheStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

interface SessionBucket {
  sessionId: string;
  messages: CachedMessage[];
  cards: CompanionEvent[];
  atime: number;
  size: number;
}

interface DiskShape {
  version: 1;
  lastSyncAt: number | null;
  sessions: Record<string, { messages: CachedMessage[]; cards: CompanionEvent[]; atime: number }>;
}

const CACHEABLE_CARDS = new Set(['approval', 'question', 'plan']);

function measure(bucket: Pick<SessionBucket, 'messages' | 'cards'>): number {
  return new TextEncoder().encode(JSON.stringify({ messages: bucket.messages, cards: bucket.cards })).byteLength;
}

function cardKey(event: CompanionEvent): string {
  const requestId = typeof event.payload.requestId === 'string' ? event.payload.requestId : event.eventId;
  return `${event.kind}:${requestId}`;
}

function isCachedMessage(value: unknown): value is CachedMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as CachedMessage;
  return typeof message.id === 'string' && typeof message.role === 'string'
    && typeof message.content === 'string' && typeof message.timestamp === 'number';
}

function isCardEvent(value: unknown): value is CompanionEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as CompanionEvent;
  return typeof event.eventId === 'string' && typeof event.kind === 'string'
    && typeof event.sessionId === 'string' && CACHEABLE_CARDS.has(event.kind)
    && !!event.payload && typeof event.payload === 'object';
}

function cachedMessageFromEvent(event: CompanionEvent): CachedMessage | null {
  if (event.kind !== 'message' || !event.sessionId) return null;
  const payload = event.payload;
  if (typeof payload.content !== 'string' || !['user', 'assistant'].includes(String(payload.role))) return null;
  return {
    id: String(payload.id ?? payload.messageId ?? event.eventId),
    role: String(payload.role),
    content: payload.content,
    timestamp: event.createdAt,
    ...(payload.truncated === true ? { truncated: true } : {}),
  };
}

/**
 * Session-body cache for offline reread. Quota/eviction copy FileCache (LRU by atime).
 * Persist is optional and app-private; identity/drafts live elsewhere.
 */
export class HistoryCache {
  private readonly sessions = new Map<string, SessionBucket>();
  private lastSyncAt: number | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly quota: number = L.historyCacheQuotaBytes,
    private readonly messageLimit: number = L.historyWindowMessages,
    private readonly now: () => number = Date.now,
    private readonly store?: HistoryCacheStore,
  ) {}

  inspect(): { conversationBytes: number } {
    return { conversationBytes: this.total() };
  }

  snapshot(): { history: Record<string, CompanionHistory>; events: CompanionEvent[]; lastSyncAt: number | null } {
    const history: Record<string, CompanionHistory> = {};
    const events: CompanionEvent[] = [];
    for (const bucket of this.sessions.values()) {
      history[bucket.sessionId] = { sessionId: bucket.sessionId, messages: bucket.messages, nextOffset: null };
      events.push(...bucket.cards);
    }
    return { history, events, lastSyncAt: this.lastSyncAt };
  }

  rememberSync(at = this.now()): void {
    this.lastSyncAt = at;
    this.persist();
  }

  putMessages(sessionId: string, messages: readonly CachedMessage[]): void {
    if (!sessionId || messages.length === 0) return;
    const bucket = this.ensure(sessionId);
    const byId = new Map(bucket.messages.map(message => [message.id, message]));
    for (const message of messages) {
      if (!isCachedMessage(message)) continue;
      byId.set(message.id, message);
    }
    bucket.messages = [...byId.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    if (bucket.messages.length > this.messageLimit) bucket.messages = bucket.messages.slice(-this.messageLimit);
    this.touch(bucket);
  }

  putCards(sessionId: string, cards: readonly CompanionEvent[]): void {
    if (!sessionId || cards.length === 0) return;
    const bucket = this.ensure(sessionId);
    const byKey = new Map(bucket.cards.map(card => [cardKey(card), card]));
    for (const card of cards) {
      if (!isCardEvent(card) || card.sessionId !== sessionId) continue;
      // 同一张卡只留最新一版，但 createdAt 留第一次出现的时间：会话里按它把卡挂回原来那一轮（FB-177），
      // 用收尾那版的时间，隔很久才被关掉的卡会挂到后面的轮次里。
      const first = byKey.get(cardKey(card));
      byKey.set(cardKey(card), first && first.createdAt < card.createdAt ? { ...card, createdAt: first.createdAt } : card);
    }
    bucket.cards = [...byKey.values()];
    this.touch(bucket);
  }

  ingestEvents(events: readonly CompanionEvent[]): void {
    const messagesBySession = new Map<string, CachedMessage[]>();
    const cardsBySession = new Map<string, CompanionEvent[]>();
    for (const event of events) {
      if (!event.sessionId) continue;
      const message = cachedMessageFromEvent(event);
      if (message) {
        const list = messagesBySession.get(event.sessionId) ?? [];
        list.push(message);
        messagesBySession.set(event.sessionId, list);
        continue;
      }
      if (!CACHEABLE_CARDS.has(event.kind)) continue;
      const list = cardsBySession.get(event.sessionId) ?? [];
      list.push(event);
      cardsBySession.set(event.sessionId, list);
    }
    for (const [sessionId, messages] of messagesBySession) this.putMessages(sessionId, messages);
    for (const [sessionId, cards] of cardsBySession) this.putCards(sessionId, cards);
    this.rememberSync();
  }

  dropSession(sessionId: string): void {
    if (!this.sessions.delete(sessionId)) return;
    this.persist();
  }

  retainSessions(allowed: Iterable<string>): void {
    const keep = new Set(allowed);
    let changed = false;
    for (const sessionId of [...this.sessions.keys()]) {
      if (keep.has(sessionId)) continue;
      this.sessions.delete(sessionId);
      changed = true;
    }
    if (changed) this.persist();
  }

  clear(): { freedBytes: number } {
    const freedBytes = this.total();
    this.sessions.clear();
    this.lastSyncAt = null;
    this.persist();
    return { freedBytes };
  }

  async hydrate(): Promise<void> {
    if (!this.store) return;
    const raw = await this.store.read();
    if (!raw) return;
    try {
      const value = JSON.parse(raw) as DiskShape;
      if (value.version !== 1 || !value.sessions || typeof value.sessions !== 'object') return;
      this.lastSyncAt = typeof value.lastSyncAt === 'number' ? value.lastSyncAt : null;
      for (const [sessionId, entry] of Object.entries(value.sessions)) {
        if (!sessionId || !entry || !Array.isArray(entry.messages)) continue;
        const messages = entry.messages.filter(isCachedMessage);
        const bucket: SessionBucket = {
          sessionId,
          messages: messages.length > this.messageLimit ? messages.slice(-this.messageLimit) : messages,
          cards: Array.isArray(entry.cards) ? entry.cards.filter(isCardEvent) : [],
          atime: typeof entry.atime === 'number' ? entry.atime : 0,
          size: 0,
        };
        bucket.size = measure(bucket);
        this.sessions.set(sessionId, bucket);
      }
      this.evict(null);
    } catch {
      this.sessions.clear();
      this.lastSyncAt = null;
    }
  }

  flush(): Promise<void> {
    return this.writing;
  }

  private ensure(sessionId: string): SessionBucket {
    let bucket = this.sessions.get(sessionId);
    if (!bucket) {
      bucket = { sessionId, messages: [], cards: [], atime: this.now(), size: 0 };
      this.sessions.set(sessionId, bucket);
    }
    return bucket;
  }

  private touch(bucket: SessionBucket): void {
    bucket.atime = this.now();
    bucket.size = measure(bucket);
    this.evict(bucket.sessionId);
    this.persist();
  }

  private total(): number {
    return [...this.sessions.values()].reduce((sum, bucket) => sum + bucket.size, 0);
  }

  private evict(keep: string | null): void {
    while (this.total() > this.quota) {
      let victim: SessionBucket | null = null;
      for (const entry of this.sessions.values()) {
        if (entry.sessionId === keep) continue;
        if (!victim || entry.atime < victim.atime) victim = entry;
      }
      if (!victim) break;
      this.sessions.delete(victim.sessionId);
    }
    if (!keep || this.total() <= this.quota) return;
    const bucket = this.sessions.get(keep);
    if (!bucket) return;
    while (this.total() > this.quota && bucket.messages.length > 0) {
      bucket.messages.shift();
      bucket.size = measure(bucket);
    }
    if (this.total() > this.quota) {
      bucket.cards = [];
      bucket.size = measure(bucket);
    }
    if (this.total() > this.quota) this.sessions.delete(keep);
  }

  private persist(): void {
    if (!this.store) return;
    const body = JSON.stringify(this.toDisk());
    this.writing = this.writing.then(() => this.store!.write(body)).catch(() => { /* cache is best-effort; identity/drafts are elsewhere */ });
  }

  private toDisk(): DiskShape {
    const sessions: DiskShape['sessions'] = {};
    for (const bucket of this.sessions.values()) {
      sessions[bucket.sessionId] = { messages: bucket.messages, cards: bucket.cards, atime: bucket.atime };
    }
    return { version: 1, lastSyncAt: this.lastSyncAt, sessions };
  }
}
