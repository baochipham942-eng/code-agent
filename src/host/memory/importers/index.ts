import * as os from 'os';
import type {
  MemoryEntry,
  MemoryImportAdapterId,
  MemoryImportApplyResult,
  MemoryImportDirectiveConfirmResult,
  MemoryImportDryRunResult,
} from '../../../shared/contract/memory';
import type { MemoryRecord } from '../../services/core/repositories';
import { requestDirectiveMemoryConfirmation } from '../directiveMemoryConfirmation';
import {
  listUnifiedMemoryEntries,
  rebuildMemoryMirrorFromLightFiles,
  writeEntryToLightMemory,
} from '../memoryEntryRuntime';
import { codexLocalCustomAdapter } from './codexLocalCustom';
import { claudeCodeAdapter } from './claudeCode';
import { geminiCliAdapter } from './geminiCli';
import { grokBuildAdapter } from './grokBuild';
import { contentHash } from './markdown';
import { qwenCodeAdapter } from './qwenCode';
import type { MemoryImporterAdapter, MemoryImporterDiscoveryOptions, RawMemoryImportItem } from './types';

interface MemoryImporterDatabase {
  listMemories(options?: {
    limit?: number;
    orderBy?: string;
    orderDir?: 'ASC' | 'DESC';
    includeArchived?: boolean;
    includeCandidates?: boolean;
  }): MemoryRecord[];
  createMemory(data: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>): MemoryRecord;
  updateMemory(id: string, updates: Partial<MemoryRecord>): MemoryRecord | null;
}

const ADAPTERS: MemoryImporterAdapter[] = [
  codexLocalCustomAdapter,
  claudeCodeAdapter,
  grokBuildAdapter,
  qwenCodeAdapter,
  geminiCliAdapter,
];

const DEFAULT_P0_MEMORY_IMPORT_ADAPTERS: MemoryImportAdapterId[] = ADAPTERS
  .filter((adapter) => adapter.phase === 'p0')
  .map((adapter) => adapter.id);

function selectedAdapters(ids: MemoryImportAdapterId[] | undefined): MemoryImporterAdapter[] {
  const selected = new Set(ids?.length ? ids : DEFAULT_P0_MEMORY_IMPORT_ADAPTERS);
  return ADAPTERS.filter((adapter) => selected.has(adapter.id));
}

function importedContentHashes(entries: MemoryEntry[]): Set<string> {
  const hashes = new Set<string>();
  for (const entry of entries) {
    const provenanceHash = entry.source.importProvenance?.sourceHash;
    if (provenanceHash) hashes.add(provenanceHash);
    for (const evidence of entry.evidence) {
      if (evidence.contentHash) hashes.add(evidence.contentHash);
    }
  }
  return hashes;
}

function memoryEntryFromRaw(item: RawMemoryImportItem, now: number): MemoryEntry {
  const hash = contentHash(item.content);
  return {
    id: `import_${hash}`,
    schemaVersion: 2,
    status: item.archived ? 'archived' : 'candidate',
    deprecatedBy: null,
    kind: item.kind,
    scope: item.scope,
    title: item.title,
    summary: item.summary,
    content: item.content,
    source: {
      kind: 'import',
      sourceOfTruth: 'light_file',
      filePath: `import-${hash}.md`,
      label: `${item.adapterId}: ${item.sourcePath}`,
      importProvenance: {
        sourceVendor: item.sourceVendor,
        sourceHarness: item.adapterId,
        sourceVersion: item.sourceVersion ?? null,
        sourcePath: item.sourcePath,
        sourceScope: item.sourceScope,
        sourceHash: hash,
        sourceMtime: item.sourceMtime,
        sourceFormat: item.sourceFormat,
        sourceMetadata: item.metadata,
        verifiedOnDevice: item.verifiedOnDevice,
      },
    },
    evidence: [{
      filePath: item.sourcePath,
      contentHash: hash,
      source: item.adapterId,
    }],
    projectPath: item.projectPath ?? null,
    sessionId: null,
    confidence: item.metadata.type ? 1 : 0.7,
    createdAt: now,
    updatedAt: now,
  };
}

async function discoverRaw(options: MemoryImporterDiscoveryOptions): Promise<{
  adapterIds: MemoryImportAdapterId[];
  items: RawMemoryImportItem[];
  skipped: MemoryImportDryRunResult['skipped'];
}> {
  const adapters = selectedAdapters(options.adapterIds);
  const items: RawMemoryImportItem[] = [];
  const skipped: MemoryImportDryRunResult['skipped'] = [];
  for (const adapter of adapters) {
    const discovered = await adapter.discover(options);
    items.push(...discovered.items);
    skipped.push(...discovered.skipped.map((item) => ({ adapterId: adapter.id, ...item })));
  }
  return { adapterIds: adapters.map((adapter) => adapter.id), items, skipped };
}

export async function dryRunMemoryHarnessImport(
  db: MemoryImporterDatabase,
  options: Partial<MemoryImporterDiscoveryOptions> = {},
): Promise<MemoryImportDryRunResult> {
  const discoveryOptions: MemoryImporterDiscoveryOptions = {
    homeDir: options.homeDir || os.homedir(),
    now: options.now,
    adapterIds: options.adapterIds,
    modelProvider: options.modelProvider,
  };
  const discovered = await discoverRaw(discoveryOptions);
  const existingHashes = importedContentHashes((await listUnifiedMemoryEntries(db)).entries);
  const seenHashes = new Set<string>();
  const candidates: MemoryImportDryRunResult['candidates'] = [];
  const instructions: MemoryImportDryRunResult['instructions'] = [];

  for (const item of discovered.items) {
    const hash = contentHash(item.content);
    if (item.destination === 'instruction' || item.kind === 'directive') {
      if (item.instructionReason === 'directive-confirmation-required' && existingHashes.has(hash)) {
        discovered.skipped.push({
          adapterId: item.adapterId,
          sourcePath: item.sourcePath,
          reason: 'directive-already-imported',
        });
        continue;
      }
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);
      instructions.push({
        id: `instruction:${hash}`,
        adapterId: item.adapterId,
        title: item.title,
        content: item.content,
        sourcePath: item.sourcePath,
        reason: item.instructionReason || 'directive-confirmation-required',
        contentHash: hash,
        sourceMetadata: item.metadata,
      });
      continue;
    }

    const entry = memoryEntryFromRaw(item, discoveryOptions.now ?? Date.now());
    if (discoveryOptions.modelProvider && entry.source.importProvenance) {
      entry.source.importProvenance.modelProvider = discoveryOptions.modelProvider;
    }
    const duplicate = existingHashes.has(hash) || seenHashes.has(hash);
    seenHashes.add(hash);
    candidates.push({
      id: entry.id,
      entry,
      disposition: duplicate ? 'skip' : 'add',
      reason: duplicate ? 'duplicate-content-hash' : 'new-content',
    });
  }

  return {
    scannedAdapters: discovered.adapterIds,
    candidates,
    instructions,
    skipped: discovered.skipped,
    summary: {
      discoveredMemory: candidates.length,
      readyToImport: candidates.filter((candidate) => candidate.disposition === 'add').length,
      duplicates: candidates.filter((candidate) => candidate.disposition === 'skip').length,
      instructionOnly: instructions.length,
      archived: candidates.filter((candidate) => candidate.entry.status === 'archived').length,
    },
  };
}

export async function applyMemoryHarnessImport(
  db: MemoryImporterDatabase,
  options: Partial<MemoryImporterDiscoveryOptions> & { candidateIds?: string[] } = {},
): Promise<MemoryImportApplyResult> {
  const dryRun = await dryRunMemoryHarnessImport(db, options);
  const selected = options.candidateIds?.length ? new Set(options.candidateIds) : null;
  const ready = dryRun.candidates.filter((candidate) =>
    candidate.disposition === 'add' && (!selected || selected.has(candidate.id)),
  );
  const entries: MemoryEntry[] = [];
  const writtenFiles: string[] = [];
  for (const candidate of ready) {
    if (candidate.entry.kind === 'directive') {
      throw new Error('Directive import requires explicit user confirmation and cannot enter the batch importer.');
    }
    const written = await writeEntryToLightMemory(candidate.entry);
    entries.push({
      ...candidate.entry,
      source: { ...candidate.entry.source, filePath: written.filename },
      updatedAt: Date.parse(written.updatedAt) || candidate.entry.updatedAt,
    });
    writtenFiles.push(written.filename);
  }
  const mirrorRebuild = await rebuildMemoryMirrorFromLightFiles(db);
  return {
    imported: entries.length,
    skipped: dryRun.candidates.length - entries.length,
    writtenFiles,
    entries,
    mirrorRebuild,
  };
}

export async function confirmMemoryHarnessDirective(
  db: MemoryImporterDatabase,
  instructionId: string,
  options: Partial<MemoryImporterDiscoveryOptions> & {
    confirmDirective?: (input: { content: string; category: string }) => Promise<{ confirmed: boolean }>;
  } = {},
): Promise<MemoryImportDirectiveConfirmResult> {
  const discoveryOptions: MemoryImporterDiscoveryOptions = {
    homeDir: options.homeDir || os.homedir(),
    now: options.now,
    adapterIds: options.adapterIds,
    modelProvider: options.modelProvider,
  };
  const discovered = await discoverRaw(discoveryOptions);
  const raw = discovered.items.find((item) =>
    item.kind === 'directive'
    && item.instructionReason === 'directive-confirmation-required'
    && `instruction:${contentHash(item.content)}` === instructionId,
  );
  if (!raw) throw new Error('Directive import candidate not found or is an instruction file.');
  const confirmer = options.confirmDirective || requestDirectiveMemoryConfirmation;
  const confirmation = await confirmer({ content: raw.content, category: 'import' });
  if (!confirmation.confirmed) {
    return { instructionId, confirmed: false, imported: false };
  }

  const entry = memoryEntryFromRaw(raw, discoveryOptions.now ?? Date.now());
  entry.status = 'active';
  if (discoveryOptions.modelProvider && entry.source.importProvenance) {
    entry.source.importProvenance.modelProvider = discoveryOptions.modelProvider;
  }
  const existingHashes = importedContentHashes((await listUnifiedMemoryEntries(db)).entries);
  const hash = entry.source.importProvenance?.sourceHash;
  if (hash && existingHashes.has(hash)) {
    return { instructionId, confirmed: true, imported: false };
  }
  const written = await writeEntryToLightMemory(entry, { directiveConfirmedByUser: true });
  const importedEntry = {
    ...entry,
    source: { ...entry.source, filePath: written.filename },
    updatedAt: Date.parse(written.updatedAt) || entry.updatedAt,
  };
  const mirrorRebuild = await rebuildMemoryMirrorFromLightFiles(db);
  return {
    instructionId,
    confirmed: true,
    imported: true,
    entry: importedEntry,
    mirrorRebuild,
  };
}

export { type MemoryImporterDiscoveryOptions } from './types';
