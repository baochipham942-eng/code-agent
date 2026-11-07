// ============================================================================
// Instructions auto sync - startup detection only, never automatic persistence
// ============================================================================
//
// Codex is the only source in scope. A startup round performs a dry-run and
// stores pending/kept counts. Persistence still goes through the existing
// per-item directive confirmation gate.

import type {
  MemoryEntry,
  MemoryImportDirectiveConfirmResult,
  MemoryImportDryRunResult,
} from '../../shared/contract/memory';
import { getHomeDir } from '../config';
import {
  confirmMemoryHarnessDirective,
  dryRunMemoryHarnessImport,
  type MemoryImporterDiscoveryOptions,
} from '../memory/importers';
import { listUnifiedMemoryEntries } from '../memory/memoryEntryRuntime';
import { createLogger } from '../services/infra/logger';
import { recordInstructionImportHistory } from './importHistory';
import {
  readInstructionsSyncStored,
  writeInstructionsSyncStored,
  type InstructionsSyncLastRun,
  type InstructionsSyncMode,
} from './instructionsSyncPreference';

const logger = createLogger('InstructionsAutoSync');
const CODEX_ADAPTER_ID = 'codex-local-custom' as const;

type InstructionsDatabase = Parameters<typeof dryRunMemoryHarnessImport>[0];
type DirectiveConfirmer = (input: { content: string; category: string }) => Promise<{
  confirmed: boolean;
  headlessNoUi?: boolean;
  timedOut?: boolean;
}>;

export interface PendingInstructionRule {
  instructionId: string;
  content: string;
  contentHash: string;
}

export interface InstructionsSyncState {
  mode: InstructionsSyncMode;
  available: boolean;
  pending: PendingInstructionRule[];
  lastRun?: InstructionsSyncLastRun;
}

export interface InstructionsSyncConfirmResult {
  confirmation: MemoryImportDirectiveConfirmResult;
  state: InstructionsSyncState;
}

export interface InstructionsAutoSyncOptions {
  db?: InstructionsDatabase;
  homeDir?: string;
  now?: () => number;
  confirmDirective?: DirectiveConfirmer;
}

interface DetectionResult {
  preview: MemoryImportDryRunResult;
  pending: PendingInstructionRule[];
  keptHashes: string[];
}

let inFlight: Promise<void> | null = null;

async function resolveDatabase(options: InstructionsAutoSyncOptions): Promise<InstructionsDatabase> {
  if (options.db) return options.db;
  const { getDatabase } = await import('../services/core/databaseService');
  return getDatabase();
}

function discoveryOptions(
  options: InstructionsAutoSyncOptions,
): Pick<MemoryImporterDiscoveryOptions, 'adapterIds' | 'homeDir'> {
  return {
    adapterIds: [CODEX_ADAPTER_ID],
    homeDir: options.homeDir ?? getHomeDir(),
  };
}

function hasImportedCodexDirective(entries: MemoryEntry[]): boolean {
  return entries.some((entry) => entry.kind === 'directive'
    && entry.source.importProvenance?.sourceHarness === CODEX_ADAPTER_ID
    && Boolean(entry.source.importProvenance.sourceHash));
}

async function detectRules(
  db: InstructionsDatabase,
  handled: readonly string[],
  options: InstructionsAutoSyncOptions,
): Promise<DetectionResult> {
  const preview = await dryRunMemoryHarnessImport(db, discoveryOptions(options));
  const handledSet = new Set(handled);
  const pending = preview.instructions
    .filter((item) => item.adapterId === CODEX_ADAPTER_ID
      && item.reason === 'directive-confirmation-required'
      && !handledSet.has(item.contentHash))
    .map((item) => ({
      instructionId: item.id,
      content: item.content,
      contentHash: item.contentHash,
    }));
  const keptHashes = preview.skipped
    .filter((item) => item.adapterId === CODEX_ADAPTER_ID
      && item.reason === 'directive-already-imported'
      && typeof item.contentHash === 'string'
      && !handledSet.has(item.contentHash))
    .map((item) => item.contentHash as string);
  return { preview, pending, keptHashes: Array.from(new Set(keptHashes)) };
}

async function syncRound(options: InstructionsAutoSyncOptions): Promise<void> {
  const before = readInstructionsSyncStored();
  if (before.mode !== 'on') return;
  const db = await resolveDatabase(options);
  const detected = await detectRules(db, before.handled, options);
  const current = readInstructionsSyncStored();
  const handled = Array.from(new Set([...current.handled, ...detected.keptHashes]));
  writeInstructionsSyncStored({
    mode: current.mode,
    handled,
    lastRun: {
      at: (options.now ?? Date.now)(),
      pending: detected.pending.length,
      keptNeo: detected.keptHashes.length,
    },
  });
}

/** Runs one startup detection round. It never throws and never writes memory. */
export function runInstructionsAutoSync(options: InstructionsAutoSyncOptions = {}): Promise<void> {
  if (!inFlight) {
    inFlight = syncRound(options)
      .catch((error) => {
        logger.warn('Instructions auto sync failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

export function startInstructionsAutoSync(): Promise<void> {
  return runInstructionsAutoSync();
}

/** Returns a fresh pending list; this read path never changes the handled ledger. */
export async function getInstructionsSyncState(
  options: InstructionsAutoSyncOptions = {},
): Promise<InstructionsSyncState> {
  const stored = readInstructionsSyncStored();
  const db = await resolveDatabase(options);
  const entries = (await listUnifiedMemoryEntries(db)).entries;
  const available = hasImportedCodexDirective(entries);
  const pending = available
    ? (await detectRules(db, stored.handled, options)).pending
    : [];
  return {
    mode: available ? stored.mode : 'off',
    available,
    pending,
    ...(stored.lastRun ? { lastRun: stored.lastRun } : {}),
  };
}

/** Enabling is fail-closed until a Codex instruction has been manually imported once. */
export async function setInstructionsSyncMode(
  mode: InstructionsSyncMode,
  options: InstructionsAutoSyncOptions = {},
): Promise<InstructionsSyncState> {
  const currentState = await getInstructionsSyncState(options);
  if (!currentState.available) return currentState;
  const previous = readInstructionsSyncStored();
  writeInstructionsSyncStored({ ...previous, mode });
  if (mode === 'on' && previous.mode !== 'on') await runInstructionsAutoSync(options);
  return getInstructionsSyncState(options);
}

/** The only write path: existing per-item confirmation, then history + handled ledger. */
export async function confirmInstructionsSyncItem(
  instructionId: string,
  options: InstructionsAutoSyncOptions = {},
): Promise<InstructionsSyncConfirmResult> {
  const stored = readInstructionsSyncStored();
  if (stored.mode !== 'on') throw new Error('Instructions sync is not on.');
  const db = await resolveDatabase(options);
  const detected = await detectRules(db, stored.handled, options);
  const pending = detected.pending.find((item) => item.instructionId === instructionId);
  if (!pending) throw new Error('Instruction is no longer pending.');

  const confirmation = await confirmMemoryHarnessDirective(db, instructionId, {
    ...discoveryOptions(options),
    confirmDirective: options.confirmDirective,
  });
  const shouldHandle = confirmation.imported
    || confirmation.confirmed
    || confirmation.notConfirmedReason === 'declined'
    || confirmation.notConfirmedReason === 'timeout';
  if (confirmation.imported && confirmation.entry) {
    await recordInstructionImportHistory(confirmation.entry, { trigger: 'confirm', now: options.now });
  }
  if (shouldHandle) {
    const current = readInstructionsSyncStored();
    writeInstructionsSyncStored({
      ...current,
      handled: Array.from(new Set([...current.handled, pending.contentHash])),
    });
  }
  return {
    confirmation,
    state: await getInstructionsSyncState(options),
  };
}
