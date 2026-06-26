import { describe, expect, it } from 'vitest';
import { extractHandoffProposalTail } from '../../../src/host/handoff/handoffTail';

describe('handoff tail parser', () => {
  it('strips a false handoff block from the final assistant content', () => {
    const result = extractHandoffProposalTail([
      '我会先把范围压在当前会话。',
      '',
      '<handoff-proposal>{"worthHandoff":false}</handoff-proposal>',
    ].join('\n'));

    expect(result.found).toBe(true);
    expect(result.cleanedContent).toBe('我会先把范围压在当前会话。');
    expect(result.draft).toBeNull();
  });

  it('extracts a pending handoff draft from the structured tail block', () => {
    const result = extractHandoffProposalTail([
      '改完了。',
      '',
      '<handoff-proposal>',
      JSON.stringify({
        worthHandoff: true,
        title: '继续验证安装包',
        prompt: '继续验证刚才生成的安装包，并回读安装结果。',
        reason: '安装验证还没有跑。',
      }),
      '</handoff-proposal>',
    ].join('\n'));

    expect(result.cleanedContent).toBe('改完了。');
    expect(result.draft).toEqual({
      title: '继续验证安装包',
      prompt: '继续验证刚才生成的安装包，并回读安装结果。',
      reason: '安装验证还没有跑。',
    });
  });

  it('ignores non-tail blocks so normal XML in the answer survives', () => {
    const content = [
      '<handoff-proposal>{"worthHandoff":true}</handoff-proposal>',
      '',
      '这段是正文。',
    ].join('\n');

    expect(extractHandoffProposalTail(content)).toEqual({
      found: false,
      cleanedContent: content,
      draft: null,
    });
  });
});
