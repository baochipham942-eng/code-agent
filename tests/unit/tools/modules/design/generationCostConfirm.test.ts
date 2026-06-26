// ============================================================================
// confirmGenerationCost — 会话内成本确认卡（Slice A）
//
// 复用 promptUserInChat round-trip。fail-closed：无 renderer / 取消 / 超时 → false
// （绝不花钱）；仅用户明确点「确认」→ true。
// ============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

const promptMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../../src/host/tools/utils/userQuestionPrompt', () => ({
  promptUserInChat: promptMock,
}));

import { confirmGenerationCost } from '../../../../../src/host/tools/modules/design/generationCostConfirm';
import { formatCny } from '../../../../../src/shared/media/imageCost';

beforeEach(() => vi.clearAllMocks());

const base = { mediaLabel: '图片', estCny: 0.14, detail: '2 张' };

describe('confirmGenerationCost', () => {
  it('卡片含 ¥ 成本 + 确认/取消两选项', async () => {
    promptMock.mockResolvedValue({ status: 'no-renderer' });
    await confirmGenerationCost(base);
    const [questions] = promptMock.mock.calls[0];
    expect(questions).toHaveLength(1);
    expect(questions[0].question).toContain(formatCny(0.14));
    expect(questions[0].options).toHaveLength(2);
    expect(questions[0].options[0].label).toContain(formatCny(0.14)); // 确认 ¥0.14
    expect(questions[0].options[1].label).toBe('取消');
  });

  it('无 renderer → false（fail-closed 不花钱）', async () => {
    promptMock.mockResolvedValue({ status: 'no-renderer' });
    expect(await confirmGenerationCost(base)).toBe(false);
  });

  it('用户点确认 → true', async () => {
    promptMock.mockResolvedValue({
      status: 'answered',
      response: { requestId: 'x', answers: { 成本确认: `确认 ${formatCny(0.14)}` } },
    });
    expect(await confirmGenerationCost(base)).toBe(true);
  });

  it('用户点取消 → false', async () => {
    promptMock.mockResolvedValue({
      status: 'answered',
      response: { requestId: 'x', answers: { 成本确认: '取消' } },
    });
    expect(await confirmGenerationCost(base)).toBe(false);
  });

  it('超时 → false', async () => {
    promptMock.mockResolvedValue({ status: 'timeout' });
    expect(await confirmGenerationCost(base)).toBe(false);
  });
});
