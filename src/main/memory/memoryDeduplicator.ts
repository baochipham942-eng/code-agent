/**
 * Deduplicates memory entries and entity relations before write.
 * Uses exact match + Jaccard token similarity to avoid redundant DB inserts.
 */

import type { DatabaseService, EntityRelation } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('MemoryDedup');

export interface DeduplicateResult<T> {
  toInsert: T[];
  toMerge: Array<{ existingId: string; candidate: T; similarity: number }>;
  duplicates: T[];
}

export interface RelationCandidate {
  sourceId: string;
  targetId: string;
  relationType: 'calls' | 'imports' | 'similar_to' | 'solves' | 'depends_on' | 'modifies' | 'references';
  confidence: number;
  evidence: string;
  sessionId: string;
}

/** Jaccard similarity threshold — above this, two entries are considered near-duplicates */
const SIMILARITY_THRESHOLD = 0.85;

export class MemoryDeduplicator {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Check candidate relations against existing ones.
   * Exact match on (sourceId, targetId, relationType) → duplicate.
   * Same source+target but different type with high token overlap → merge candidate.
   */
  deduplicateRelations(candidates: RelationCandidate[]): DeduplicateResult<RelationCandidate> {
    const toInsert: RelationCandidate[] = [];
    const toMerge: Array<{ existingId: string; candidate: RelationCandidate; similarity: number }> = [];
    const duplicates: RelationCandidate[] = [];

    // Also track within-batch duplicates to avoid inserting the same pair twice
    const seenInBatch = new Set<string>();

    for (const candidate of candidates) {
      const batchKey = `${candidate.sourceId}|${candidate.targetId}|${candidate.relationType}`;
      if (seenInBatch.has(batchKey)) {
        duplicates.push(candidate);
        continue;
      }
      seenInBatch.add(batchKey);

      // Query existing relations for this source entity
      const existing = this.db.getRelationsFor(candidate.sourceId, 'source');

      // Exact match check
      const exactMatch = existing.find(
        (e: EntityRelation) =>
          e.targetId === candidate.targetId && e.relationType === candidate.relationType
      );

      if (exactMatch) {
        duplicates.push(candidate);
        continue;
      }

      // Fuzzy match: same source+target, different relation type or evidence overlap
      const sameTarget = existing.find(
        (e: EntityRelation) => e.targetId === candidate.targetId
      );

      if (sameTarget) {
        const similarity = jaccardSimilarity(
          tokenize(sameTarget.evidence || ''),
          tokenize(candidate.evidence || '')
        );
        if (similarity > SIMILARITY_THRESHOLD) {
          toMerge.push({ existingId: sameTarget.id, candidate, similarity });
          continue;
        }
      }

      toInsert.push(candidate);
    }

    logger.debug(
      `[MemoryDedup] ${toInsert.length} new, ${toMerge.length} merge, ${duplicates.length} skip`
    );
    return { toInsert, toMerge, duplicates };
  }
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\W+/).filter(t => t.length > 1));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

let deduplicatorInstance: MemoryDeduplicator | null = null;

export function getMemoryDeduplicator(db: DatabaseService): MemoryDeduplicator {
  if (!deduplicatorInstance) {
    deduplicatorInstance = new MemoryDeduplicator(db);
  }
  return deduplicatorInstance;
}
