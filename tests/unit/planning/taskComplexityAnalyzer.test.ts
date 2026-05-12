import { describe, expect, it } from 'vitest';
import { TaskComplexityAnalyzer } from '../../../src/main/planning/taskComplexityAnalyzer';

describe('TaskComplexityAnalyzer', () => {
  const analyzer = new TaskComplexityAnalyzer();

  it.each([
    '帮我记录当前腾讯会议的内容',
    '通过 computer use 打开 Notes 记录当前会议',
  ])('keeps desktop meeting capture tasks out of simple fastPath: %s', (message) => {
    const analysis = analyzer.analyze(message);

    expect(analysis.complexity).toBe('moderate');
    expect(analysis.reasons).toContain('桌面会议记录任务需要读取当前会议上下文');
    expect(analysis.suggestedApproach).toBe('分步执行，必要时使用子代理');
  });

  it('still treats short unrelated prompts as simple', () => {
    const analysis = analyzer.analyze('改标题');

    expect(analysis.complexity).toBe('simple');
    expect(analysis.reasons).toContain('简短任务描述');
  });
});
