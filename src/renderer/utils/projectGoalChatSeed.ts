import type { GoalRunInput } from '@shared/contract/appService';
import type { ConversationEnvelope } from '@shared/contract/conversationEnvelope';
import type { PendingProjectGoalChatSeed } from '../stores/appStore';
import { buildDefaultGoalReview } from '../components/features/chat/ChatInput/parseGoalCommand';

export interface ProjectGoalChatStart {
  goalText: string;
  envelope: ConversationEnvelope;
  runInit: {
    goal: string;
    maxTurns?: number;
    tokenBudget?: number;
  };
}

export function getProjectGoalSeedText(seed: PendingProjectGoalChatSeed): string {
  return seed.goal.goal?.trim() || seed.content.trim();
}

function normalizeGoal(seed: PendingProjectGoalChatSeed, goalText: string): GoalRunInput {
  const goal = {
    ...seed.goal,
    goal: goalText,
  };
  if (!goal.verify?.trim() && !goal.review?.trim()) {
    return {
      ...goal,
      review: buildDefaultGoalReview(goalText),
    };
  }
  return goal;
}

export function buildProjectGoalChatStart(
  seed: PendingProjectGoalChatSeed,
  baseEnvelope: ConversationEnvelope,
): ProjectGoalChatStart {
  const goalText = getProjectGoalSeedText(seed);
  const goal = normalizeGoal(seed, goalText);
  return {
    goalText,
    envelope: {
      ...baseEnvelope,
      content: seed.content,
      options: {
        ...(baseEnvelope.options ?? {}),
        goal,
      },
    },
    runInit: {
      goal: goalText,
      maxTurns: goal.maxTurns,
      tokenBudget: goal.budget,
    },
  };
}
