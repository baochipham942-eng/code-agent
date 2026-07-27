// askUserQuestionRecord（G2 消息流 Q&A 记录解析）行为门：
// host 固定输出格式（askUserQuestion.ts）→ 结构化记录；
// 多行自由文本答案并入上一题；未知前缀不解析（回退默认渲染）。
import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import { buildAskUserQuestionRecord } from '../../../src/renderer/utils/askUserQuestionRecord';

function toolCall(output: string | undefined, questions?: unknown): ToolCall {
  return {
    id: 'tc-1',
    name: 'AskUserQuestion',
    arguments: {
      questions: questions ?? [
        { header: '方案', question: '选哪个方案？', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] },
        { header: '范围', question: '改动范围？', options: [{ label: '前端', description: '' }, { label: '全栈', description: '' }], multiSelect: true },
      ],
    },
    ...(output !== undefined
      ? { result: { toolCallId: 'tc-1', success: true, output } }
      : {}),
  } as ToolCall;
}

describe('buildAskUserQuestionRecord', () => {
  it('非 AskUserQuestion 工具 → null', () => {
    const tc = { ...toolCall('User responses:\n[方案]: A'), name: 'Bash' } as ToolCall;
    expect(buildAskUserQuestionRecord(tc)).toBeNull();
  });

  it('无 result → null（问题还在等待回答，不构成记录）', () => {
    expect(buildAskUserQuestionRecord(toolCall(undefined))).toBeNull();
  });

  it('已回答：逐题解析所选答案', () => {
    const record = buildAskUserQuestionRecord(
      toolCall('User responses:\n[方案]: A\n[范围]: 前端, 全栈'),
    );
    expect(record).not.toBeNull();
    expect(record!.kind).toBe('answered');
    expect(record!.items).toEqual([
      { header: '方案', question: '选哪个方案？', answer: 'A' },
      { header: '范围', question: '改动范围？', answer: '前端, 全栈' },
    ]);
  });

  it('「其他」多行自由文本答案并入所属题，不被下一行切开', () => {
    const record = buildAskUserQuestionRecord(
      toolCall('User responses:\n[方案]: 都不选\n改成 C 方案，理由是成本\n[范围]: 前端'),
    );
    expect(record!.items[0].answer).toBe('都不选\n改成 C 方案，理由是成本');
    expect(record!.items[1].answer).toBe('前端');
  });

  it('含方括号的非 header 行不冒充新答案', () => {
    const record = buildAskUserQuestionRecord(
      toolCall('User responses:\n[方案]: A\n[备注]: 这不是题目'),
    );
    expect(record!.items[0].answer).toBe('A\n[备注]: 这不是题目');
    expect(record!.items[1].answer).toBeNull();
  });

  it('跳过无原因 → declined，无 declineReason', () => {
    const record = buildAskUserQuestionRecord(toolCall('User declined to answer.'));
    expect(record!.kind).toBe('declined');
    expect(record!.declineReason).toBeUndefined();
    expect(record!.items.every((item) => item.answer === null)).toBe(true);
  });

  it('跳过带原因 → declined + declineReason', () => {
    const record = buildAskUserQuestionRecord(
      toolCall('User declined to answer. Reason: 先去处理别的事'),
    );
    expect(record!.kind).toBe('declined');
    expect(record!.declineReason).toBe('先去处理别的事');
  });

  it('未知输出前缀 → null（如 CLI no-renderer 兜底文案，回退默认渲染）', () => {
    expect(buildAskUserQuestionRecord(toolCall('[用户未响应 - CLI 模式无法交互]\n\n...'))).toBeNull();
  });

  it('args.questions 缺失/ malformed → null', () => {
    expect(buildAskUserQuestionRecord(toolCall('User responses:\n[方案]: A', []))).toBeNull();
    expect(buildAskUserQuestionRecord(toolCall('User responses:\n[方案]: A', 'nope'))).toBeNull();
  });
});
