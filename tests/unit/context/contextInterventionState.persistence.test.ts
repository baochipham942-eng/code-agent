import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  db: {
    isReady: true,
    saveContextIntervention: vi.fn(),
    getContextInterventions: vi.fn(),
  },
}));

vi.mock('../../../src/main/services/core/databaseService', () => ({
  getDatabase: () => dbState.db,
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { ContextInterventionState } from '../../../src/main/context/contextInterventionState';

describe('ContextInterventionState persistence', () => {
  beforeEach(() => {
    dbState.db.isReady = true;
    dbState.db.saveContextIntervention.mockReset();
    dbState.db.getContextInterventions.mockReset();
    dbState.db.getContextInterventions.mockReturnValue({
      pinned: [],
      excluded: [],
      retained: [],
    });
  });

  it('persists enabled and disabled intervention changes', () => {
    const state = new ContextInterventionState();

    state.applyIntervention('ctx-session-1', 'agent-1', 'msg-1', 'pin', true);
    expect(dbState.db.saveContextIntervention).toHaveBeenCalledWith(
      'ctx-session-1',
      'agent-1',
      'msg-1',
      'pin',
    );

    state.applyIntervention('ctx-session-1', 'agent-1', 'msg-1', 'pin', false);
    expect(dbState.db.saveContextIntervention).toHaveBeenLastCalledWith(
      'ctx-session-1',
      'agent-1',
      'msg-1',
      null,
    );
  });

  it('hydrates scoped intervention state from SQLite', () => {
    dbState.db.getContextInterventions.mockReturnValue({
      pinned: ['msg-pin'],
      excluded: ['msg-exclude'],
      retained: ['msg-retain'],
    });

    const state = new ContextInterventionState();
    expect(state.getSnapshot('ctx-session-2', 'agent-2')).toEqual({
      pinned: ['msg-pin'],
      excluded: ['msg-exclude'],
      retained: ['msg-retain'],
    });
    expect(dbState.db.getContextInterventions).toHaveBeenCalledWith('ctx-session-2', 'agent-2');
  });
});
