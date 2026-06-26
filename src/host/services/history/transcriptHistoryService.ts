import type { Message } from '../../../shared/contract';
import type { TranscriptKind } from '../../../shared/transcriptFts.sql';

export interface TranscriptSearchHit {
  messageId: string;
  sessionId: string;
  kind: TranscriptKind;
  toolName: string | null;
  snippet: string;
  timestamp: number;
}

export interface TranscriptAroundResult {
  sessionId: string;
  messages: Array<{ message: Message; matched: boolean }>;
}

export interface TranscriptSearchOptions {
  limit?: number;
  sessionId?: string;
  kinds?: TranscriptKind[];
  toolName?: string;
  timeAfter?: number;
  timeBefore?: number;
}

export interface TranscriptHistoryDatabase {
  searchTranscriptFts(query: string, options: TranscriptSearchOptions): TranscriptSearchHit[];
  getTranscriptAround(messageId: string, options: { before?: number; after?: number }): TranscriptAroundResult | null;
}

export class TranscriptHistoryService {
  constructor(private readonly db: TranscriptHistoryDatabase) {}

  async search(query: string, options: TranscriptSearchOptions = {}): Promise<TranscriptSearchHit[]> {
    const trimmed = query.trim();
    if (trimmed.length < 3) return [];
    return this.db.searchTranscriptFts(trimmed, options);
  }

  async around(messageId: string, options: { before?: number; after?: number } = {}): Promise<TranscriptAroundResult | null> {
    const trimmed = messageId.trim();
    if (!trimmed) return null;
    return this.db.getTranscriptAround(trimmed, options);
  }
}
