import type {
  MemoryEntry,
  MemoryEntrySourceKind,
  MemoryEntrySourceOfTruth,
} from '../../shared/contract/memory';
import type { LightMemoryFile } from '../lightMemory/lightMemoryIpc';
import type { MemoryRecord } from '../services/core/repositories';

export function memoryEntryMetadata(memory: MemoryRecord): Record<string, unknown> | null {
  const value = memory.metadata?.memoryEntry;
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

export function sourceKindForLightFile(file: LightMemoryFile): MemoryEntrySourceKind {
  return file.source === 'import' ? 'import' : 'light_file';
}

export function metadataForImportedEntry(
  entry: MemoryEntry,
  sourceOfTruth: MemoryEntrySourceOfTruth = entry.source.sourceOfTruth,
): Record<string, unknown> {
  return {
    memoryEntry: {
      schemaVersion: entry.schemaVersion,
      id: entry.id,
      status: entry.status,
      deprecatedBy: entry.deprecatedBy ?? null,
      kind: entry.kind,
      scope: entry.scope,
      sourceOfTruth,
      sourceKind: entry.source.kind,
      filePath: entry.source.filePath ?? null,
      evidence: entry.evidence,
      importProvenance: entry.source.importProvenance ?? null,
    },
  };
}
