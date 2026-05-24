import { describe, expect, it } from 'vitest';
import {
  isGoalCommand,
  parseGoalCommand,
} from '../../../src/renderer/components/features/chat/ChatInput/parseGoalCommand';

describe('/goal command helpers', () => {
  it('detects only the goal slash command', () => {
    expect(isGoalCommand('/goal 修好发布链路')).toBe(true);
    expect(isGoalCommand(' /goal 修好发布链路')).toBe(true);
    expect(isGoalCommand('/goalkeeper')).toBe(false);
  });

  it('parses a hard goal with verify command and limits', () => {
    expect(parseGoalCommand('/goal 修掉 warning --verify "npm test" --max-turns 5 --budget 12000')).toEqual({
      goal: '修掉 warning',
      verify: 'npm test',
      maxTurns: 5,
      budget: 12000,
    });
  });

  it('parses a review-only soft goal', () => {
    expect(parseGoalCommand("/goal 优化交互 --review '输入框聚焦时不要出现绿色描边'")).toEqual({
      goal: '优化交互',
      review: '输入框聚焦时不要出现绿色描边',
    });
  });

  it('keeps an empty goal empty so the submit layer can show usage', () => {
    expect(parseGoalCommand('/goal --review "需要一个目标"')).toEqual({
      goal: '',
      review: '需要一个目标',
    });
  });
});
