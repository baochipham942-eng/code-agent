import type {
  MemoryEntryKind,
  MemoryEntryScope,
  MemoryImportAdapterId,
} from '../../../shared/contract/memory';

export interface MemoryImporterDiscoveryOptions {
  homeDir: string;
  now?: number;
  adapterIds?: MemoryImportAdapterId[];
  modelProvider?: 'zai' | 'deepseek' | null;
}

export interface RawMemoryImportItem {
  destination: 'memory' | 'instruction';
  adapterId: MemoryImportAdapterId;
  sourceVendor: string;
  sourceVersion?: string | null;
  sourcePath: string;
  sourceScope: string;
  sourceFormat: string;
  sourceMtime: number;
  verifiedOnDevice: boolean;
  title: string;
  summary: string;
  content: string;
  metadata: Record<string, unknown>;
  kind: MemoryEntryKind;
  scope: MemoryEntryScope;
  projectPath?: string | null;
  archived: boolean;
  instructionReason?: 'instruction-file' | 'directive-confirmation-required';
}

export interface MemoryImporterAdapter {
  id: MemoryImportAdapterId;
  phase: 'p0' | 'p1';
  discover(options: MemoryImporterDiscoveryOptions): Promise<{
    items: RawMemoryImportItem[];
    skipped: Array<{ sourcePath: string; reason: string }>;
  }>;
}
