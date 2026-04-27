// Runtime state persistence helpers for session-scoped context recovery.

import type { RuntimeContext } from './runtimeContext';

export interface PersistedRuntimeState {
  compressionStateJson: string | null;
  persistentSystemContext: string[];
}

function getReadyDatabase():
  | Pick<
      import('../../services/core/databaseService').DatabaseService,
      'isReady' | 'saveSessionRuntimeState' | 'getSessionRuntimeState'
    >
  | null {
  try {
    const { getDatabase } = require('../../services/core/databaseService') as typeof import('../../services/core/databaseService');
    const db = getDatabase();
    return db.isReady ? db : null;
  } catch {
    return null;
  }
}

export function loadPersistedRuntimeState(sessionId: string): PersistedRuntimeState | null {
  const db = getReadyDatabase();
  if (!db) return null;
  try {
    return db.getSessionRuntimeState(sessionId);
  } catch {
    return null;
  }
}

export function persistRuntimeState(
  runtime: Pick<RuntimeContext, 'sessionId' | 'compressionState' | 'persistentSystemContext'>,
  include: { compressionState?: boolean; persistentSystemContext?: boolean } = {
    compressionState: true,
    persistentSystemContext: true,
  },
): void {
  const db = getReadyDatabase();
  if (!db) return;

  try {
    db.saveSessionRuntimeState(runtime.sessionId, {
      ...(include.compressionState
        ? { compressionStateJson: runtime.compressionState.serialize() }
        : {}),
      ...(include.persistentSystemContext
        ? { persistentSystemContext: [...runtime.persistentSystemContext] }
        : {}),
    });
  } catch {
    // Recovery state is best-effort; the live run should continue even if DB is unavailable.
  }
}
