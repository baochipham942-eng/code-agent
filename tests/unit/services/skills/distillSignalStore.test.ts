import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const dbState = vi.hoisted(() => ({
  db: null as BetterSqlite3.Database | null,
}));

vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => dbState.db }),
}));

import { applyDistillSignalsMigration } from '../../../../src/host/services/core/database/migrations/distillSignals';
import {
  decideDistilledSkillLifecycle,
  finalizeDistilledSkillTurn,
  getDistilledSkillLifecycle,
  hasDistillSuggestionForSession,
  markDistilledSkillTurnSignal,
  recordDistillSignal,
  recordDistillSuggestion,
  recordDistilledSkillVote,
  registerDistilledSkillPromotion,
  requestDistilledSkillMerge,
} from '../../../../src/host/services/skills/distillSignalStore';

function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('distill signal store', () => {
  beforeEach(() => {
    vi.stubEnv('CODE_AGENT_SKILL_PROMOTION_MIN_EVIDENCE', '3');
    dbState.db = new Database(':memory:');
    applyDistillSignalsMigration(dbState.db, createLogger() as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    dbState.db?.close();
    dbState.db = null;
  });

  it('counts only distinct sessions and records one delivered suggestion per session', () => {
    expect(recordDistillSignal({ patternKey: 'same-pattern', sessionId: 'session-1', createdAt: 1 }))
      .toEqual({ distinctSessionCount: 1, inserted: true });
    expect(recordDistillSignal({ patternKey: 'same-pattern', sessionId: 'session-1', createdAt: 2 }))
      .toEqual({ distinctSessionCount: 1, inserted: false });
    expect(recordDistillSignal({ patternKey: 'same-pattern', sessionId: 'session-2', createdAt: 3 }))
      .toEqual({ distinctSessionCount: 2, inserted: true });

    expect(hasDistillSuggestionForSession('session-1')).toBe(false);
    recordDistillSuggestion({ id: 'suggestion-1', patternKey: 'same-pattern', sessionId: 'session-1', createdAt: 4 });
    expect(hasDistillSuggestionForSession('session-1')).toBe(true);
    expect(hasDistillSuggestionForSession('session-2')).toBe(false);
  });

  function promote(skillName = 'distilled-skill', patternKey = 'pattern-a') {
    for (let i = 1; i <= 3; i++) {
      recordDistillSignal({ patternKey, sessionId: `session-${i}`, createdAt: i });
    }
    return registerDistilledSkillPromotion({ skillName, patternKey, promotedAt: 10 });
  }

  it('retires a promoted skill when same-class negative votes reduce importance to zero', () => {
    expect(promote()?.importanceCount).toBe(3);

    for (let i = 1; i <= 3; i++) {
      recordDistilledSkillVote({
        skillName: 'distilled-skill',
        eventKey: `skip-${i}`,
        outcome: 'skipped',
        taskClass: 'research',
        createdAt: 10 + i,
      });
    }

    expect(getDistilledSkillLifecycle('distilled-skill')).toMatchObject({
      importanceCount: 0,
      status: 'retired',
    });
  });

  it('chooses split before retire when task classes have opposite net evidence', () => {
    promote();
    recordDistilledSkillVote({
      skillName: 'distilled-skill',
      eventKey: 'adopt-code',
      outcome: 'adopted',
      taskClass: 'code_generation',
    });
    let result = null;
    for (let i = 1; i <= 4; i++) {
      result = recordDistilledSkillVote({
        skillName: 'distilled-skill',
        eventKey: `skip-research-${i}`,
        outcome: 'skipped',
        taskClass: 'research',
      });
    }

    expect(result).toMatchObject({
      action: 'split',
      record: { importanceCount: 0, status: 'split_pending' },
    });
    expect(decideDistilledSkillLifecycle({
      importanceCount: 0,
      buckets: result!.buckets,
      mergeCandidate: 'similar-skill',
    })).toBe('split');
    expect(requestDistilledSkillMerge({
      skillName: 'distilled-skill',
      mergeInto: 'similar-skill',
    })?.action).toBe('split');
  });

  it('turn vote is idempotent and selected becomes adopted before finalization', () => {
    promote();
    expect(markDistilledSkillTurnSignal({
      turnId: 'turn-1',
      skillName: 'distilled-skill',
      sessionId: 'session-runtime',
      taskClass: 'testing',
      kind: 'selected',
    })).toBe(true);
    expect(markDistilledSkillTurnSignal({
      turnId: 'turn-1',
      skillName: 'distilled-skill',
      sessionId: 'session-runtime',
      taskClass: 'testing',
      kind: 'adopted',
    })).toBe(true);

    expect(finalizeDistilledSkillTurn({ turnId: 'turn-1' })[0]).toMatchObject({
      action: 'keep',
      changed: true,
      record: { importanceCount: 4 },
    });
    expect(finalizeDistilledSkillTurn({ turnId: 'turn-1' })).toEqual([]);
  });
});
