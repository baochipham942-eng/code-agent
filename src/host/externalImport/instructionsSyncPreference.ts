// ============================================================================
// Instructions sync preference - Codex instruction detection + handled ledger
// ============================================================================
//
// Storage: <userConfigDir>/external-instructions-sync.json
// Missing/corrupt files fail closed to off. The handled ledger stores source
// content hashes that were imported, declined, timed out, or kept in Neo so a
// later startup never re-proposes them.

import * as fs from 'fs';
import * as path from 'path';
import { getUserConfigDir } from '../config';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('InstructionsSyncPreference');
const PREFERENCE_FILE = 'external-instructions-sync.json';

export type InstructionsSyncMode = 'off' | 'on' | 'paused';

export interface InstructionsSyncLastRun {
  at: number;
  pending: number;
  keptNeo: number;
}

interface InstructionsSyncPreferenceState {
  mode: InstructionsSyncMode;
  lastRun?: InstructionsSyncLastRun;
}

export interface InstructionsSyncStored extends InstructionsSyncPreferenceState {
  handled: string[];
}

function emptyState(): InstructionsSyncStored {
  return { mode: 'off', handled: [] };
}

function preferenceFilePath(): string {
  return path.join(getUserConfigDir(), PREFERENCE_FILE);
}

function isMode(value: unknown): value is InstructionsSyncMode {
  return value === 'off' || value === 'on' || value === 'paused';
}

function toHashes(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0)))
    : [];
}

export function readInstructionsSyncStored(): InstructionsSyncStored {
  const filePath = preferenceFilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.warn('Failed to read instructions sync preference, treating as off', {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return emptyState();
  }

  try {
    const parsed = JSON.parse(raw) as {
      mode?: unknown;
      lastRun?: { at?: unknown; pending?: unknown; keptNeo?: unknown };
      handled?: unknown;
    };
    if (!parsed || !isMode(parsed.mode)) {
      logger.warn('Instructions sync preference has no valid mode, treating as off', { filePath });
      return emptyState();
    }
    const state: InstructionsSyncStored = {
      mode: parsed.mode,
      handled: toHashes(parsed.handled),
    };
    const lastRun = parsed.lastRun;
    if (lastRun
      && typeof lastRun.at === 'number'
      && typeof lastRun.pending === 'number'
      && typeof lastRun.keptNeo === 'number') {
      state.lastRun = {
        at: lastRun.at,
        pending: lastRun.pending,
        keptNeo: lastRun.keptNeo,
      };
    }
    return state;
  } catch (error) {
    logger.warn('Instructions sync preference is corrupt, treating as off', {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return emptyState();
  }
}

/** Persistence is best effort; callers always read back the effective state. */
export function writeInstructionsSyncStored(state: InstructionsSyncStored): void {
  const filePath = preferenceFilePath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, 'utf-8');
  } catch (error) {
    logger.warn('Failed to persist instructions sync preference', {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
