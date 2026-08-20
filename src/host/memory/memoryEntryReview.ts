import type {
  MemoryEntry,
  MemoryEntryBatchReviewRequest,
  MemoryEntryBatchReviewResult,
} from '../../shared/contract/memory';
import {
  listUnifiedMemoryEntries,
  updateMemoryEntry,
  type MemoryEntryDatabase,
} from './memoryEntryRuntime';

export async function batchReviewMemoryEntries(
  db: MemoryEntryDatabase,
  request: MemoryEntryBatchReviewRequest,
): Promise<MemoryEntryBatchReviewResult> {
  const ids = Array.from(new Set(request.entryIds || [])).filter(Boolean);
  const currentById = new Map((await listUnifiedMemoryEntries(db)).entries.map((entry) => [entry.id, entry]));
  const updated: MemoryEntry[] = [];
  const skipped: MemoryEntryBatchReviewResult['skipped'] = [];
  for (const entryId of ids) {
    const current = currentById.get(entryId);
    if (!current) {
      skipped.push({ entryId, reason: 'not-found' });
      continue;
    }
    if (current.status !== 'candidate') {
      skipped.push({ entryId, reason: 'not-candidate' });
      continue;
    }
    if (request.decision === 'approve' && current.kind === 'directive') {
      skipped.push({ entryId, reason: 'directive-requires-explicit-confirmation' });
      continue;
    }
    if (request.decision === 'approve' && current.scope === 'project' && !current.projectPath) {
      skipped.push({ entryId, reason: 'project-binding-required' });
      continue;
    }
    const result = await updateMemoryEntry(db, {
      entryId,
      status: request.decision === 'approve' ? 'active' : 'rejected',
    });
    updated.push(result.entry);
  }
  return { updated, skipped };
}
