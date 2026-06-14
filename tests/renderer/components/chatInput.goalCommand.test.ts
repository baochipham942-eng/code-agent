import { describe, expect, it } from 'vitest';
import {
  buildGoalContractReview,
  buildDefaultGoalReview,
  goalComposerDraftToParsed,
  isGoalCommand,
  normalizeGoalCommand,
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

  it('parses a bare goal and supplies a default soft review criterion', () => {
    const parsed = parseGoalCommand('/goal 开发一个 html 弹砖块游戏，要求技能和关卡丰富，可玩性强');

    expect(parsed).toEqual({
      goal: '开发一个 html 弹砖块游戏，要求技能和关卡丰富，可玩性强',
    });
    expect(normalizeGoalCommand(parsed!)).toEqual({
      goal: '开发一个 html 弹砖块游戏，要求技能和关卡丰富，可玩性强',
      review: buildDefaultGoalReview('开发一个 html 弹砖块游戏，要求技能和关卡丰富，可玩性强'),
    });
  });

  it('keeps an empty goal empty so the submit layer can show usage', () => {
    expect(parseGoalCommand('/goal --review "需要一个目标"')).toEqual({
      goal: '',
      review: '需要一个目标',
    });
  });

  it('turns a composer draft into a goal contract review', () => {
    const review = buildGoalContractReview({
      goal: '把设置页按分类整理',
      acceptance: '左侧分类清晰，右侧每次只展示一个设置域',
      boundaries: '只改设置页，不碰模型配置',
      pauseConditions: '需要重做整体导航时暂停',
    });

    expect(review).toContain('目标合同：');
    expect(review).toContain('目标：把设置页按分类整理');
    expect(review).toContain('验收：左侧分类清晰，右侧每次只展示一个设置域');
    expect(review).toContain('边界：只改设置页，不碰模型配置');
    expect(review).toContain('证据：完成前说明运行过的命令、检查过的文件、截图或日志证据');
    expect(review).toContain('暂停条件：需要重做整体导航时暂停');
  });

  it('normalizes a composer draft into /goal run input', () => {
    expect(goalComposerDraftToParsed({
      goal: ' 修好 goal composer ',
      verify: ' npm run typecheck ',
      acceptance: '空 /goal 会打开合同卡片',
      maxTurns: 8.8,
      budget: 12000.4,
    })).toEqual({
      goal: '修好 goal composer',
      verify: 'npm run typecheck',
      review: [
        '目标合同：',
        '目标：修好 goal composer',
        '验收：空 /goal 会打开合同卡片',
        '边界：只修改与目标直接相关的文件和配置，避免无关重构、无关功能和破坏性操作。',
        '证据：完成前说明运行过的命令、检查过的文件、截图或日志证据；没有证据的要求按未完成处理。',
        '暂停条件：需要凭证、付费、生产数据、破坏性操作、范围扩大，或连续 2 轮验证失败且没有新证据时暂停。',
      ].join('\n'),
      maxTurns: 8,
      budget: 12000,
    });
  });
});
