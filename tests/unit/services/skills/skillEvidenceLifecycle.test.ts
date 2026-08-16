import { beforeEach, describe, expect, it, vi } from 'vitest';

const finalizeDistilledSkillTurnMock = vi.fn();
const markDistilledSkillTurnSignalMock = vi.fn();
const recordDistilledSkillVoteMock = vi.fn();
const initializeMock = vi.fn(async () => {});
const disableSkillMock = vi.fn();
const registerSkillsToToolSearchMock = vi.fn();

vi.mock('../../../../src/host/services/skills/distillSignalStore', () => ({
  finalizeDistilledSkillTurn: (...args: unknown[]) => finalizeDistilledSkillTurnMock(...args),
  markDistilledSkillTurnSignal: (...args: unknown[]) => markDistilledSkillTurnSignalMock(...args),
  recordDistilledSkillVote: (...args: unknown[]) => recordDistilledSkillVoteMock(...args),
}));

vi.mock('../../../../src/host/services/skills/skillRepositoryService', () => ({
  getSkillRepositoryService: () => ({
    initialize: initializeMock,
    disableSkill: disableSkillMock,
  }),
}));

vi.mock('../../../../src/host/services/skills/skillDiscoveryService', () => ({
  getSkillDiscoveryService: () => ({
    registerSkillsToToolSearch: registerSkillsToToolSearchMock,
  }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { finalizeDistilledSkillEvidenceTurn } from '../../../../src/host/services/skills/skillEvidenceLifecycle';

function lifecycleResult(action: 'split' | 'retire') {
  return {
    action,
    changed: true,
    buckets: [],
    record: {
      skillName: 'distilled-demo',
      patternKey: 'pattern-demo',
      status: action === 'split' ? 'split_pending' : 'retired',
      initialPositiveEvidence: 3,
      importanceCount: 0,
      promotedAt: 1,
      updatedAt: 2,
    },
  };
}

describe('skillEvidenceLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('soft-retires a distilled skill when importance reaches zero', async () => {
    finalizeDistilledSkillTurnMock.mockReturnValue([lifecycleResult('retire')]);

    await finalizeDistilledSkillEvidenceTurn({ turnId: 'turn-retire' });

    expect(initializeMock).toHaveBeenCalledOnce();
    expect(disableSkillMock).toHaveBeenCalledWith('distilled-demo');
    expect(registerSkillsToToolSearchMock).toHaveBeenCalledOnce();
  });

  it('keeps the skill discoverable while a task-class split is pending', async () => {
    finalizeDistilledSkillTurnMock.mockReturnValue([lifecycleResult('split')]);

    await finalizeDistilledSkillEvidenceTurn({ turnId: 'turn-split' });

    expect(disableSkillMock).not.toHaveBeenCalled();
    expect(registerSkillsToToolSearchMock).not.toHaveBeenCalled();
  });
});
