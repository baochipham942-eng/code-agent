import { describe, expect, it } from 'vitest';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
import type { PendingProjectGoalChatSeed } from '../../../src/renderer/stores/appStore';
import { buildDefaultGoalReview } from '../../../src/renderer/components/features/chat/ChatInput/parseGoalCommand';
import {
  buildProjectGoalChatStart,
  getProjectGoalSeedText,
} from '../../../src/renderer/utils/projectGoalChatSeed';

describe('projectGoalChatSeed', () => {
  it('builds a goal envelope from a project goal seed without losing project gates', () => {
    const seed: PendingProjectGoalChatSeed = {
      sessionId: 'session-goal-1',
      content: '推进项目侧栏回流',
      goal: {
        goal: '推进项目侧栏回流',
        verify: 'npm test -- sidebar',
        review: '项目、会话和产物能从侧栏回到同一工作流',
      },
    };
    const baseEnvelope: ConversationEnvelope = {
      content: 'old content',
      context: {
        workingDirectory: '/repo/code-agent',
        selectedSkillIds: ['research'],
      },
      options: {
        mode: 'normal',
        turnSystemContext: ['project launch'],
      },
    };

    const start = buildProjectGoalChatStart(seed, baseEnvelope);

    expect(start.goalText).toBe('推进项目侧栏回流');
    expect(start.runInit).toEqual({
      goal: '推进项目侧栏回流',
      maxTurns: undefined,
      tokenBudget: undefined,
    });
    expect(start.envelope).toMatchObject({
      content: '推进项目侧栏回流',
      context: {
        workingDirectory: '/repo/code-agent',
        selectedSkillIds: ['research'],
      },
      options: {
        mode: 'normal',
        turnSystemContext: ['project launch'],
        goal: {
          goal: '推进项目侧栏回流',
          verify: 'npm test -- sidebar',
          review: '项目、会话和产物能从侧栏回到同一工作流',
        },
      },
    });
  });

  it('uses content as the visible goal text when the run input omits goal', () => {
    const seed: PendingProjectGoalChatSeed = {
      sessionId: 'session-goal-2',
      content: '继续收口 active goal',
      goal: {
        maxTurns: 4,
        budget: 12000,
      },
    };

    expect(getProjectGoalSeedText(seed)).toBe('继续收口 active goal');
    expect(buildProjectGoalChatStart(seed, { content: '' })).toMatchObject({
      goalText: '继续收口 active goal',
      runInit: {
        goal: '继续收口 active goal',
        maxTurns: 4,
        tokenBudget: 12000,
      },
      envelope: {
        content: '继续收口 active goal',
        options: {
          goal: {
            goal: '继续收口 active goal',
            review: buildDefaultGoalReview('继续收口 active goal'),
            maxTurns: 4,
            budget: 12000,
          },
        },
      },
    });
  });
});
