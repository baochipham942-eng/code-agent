import { describe, expect, it } from 'vitest';
import {
  formatAgentErrorContent,
  getAgentErrorMessage,
  isTerminalAgentError,
  normalizeAgentErrorPayload,
} from '../../../src/renderer/hooks/agent/effects/useSessionLifecycleEffects';

describe('agent lifecycle error helpers', () => {
  it('treats nested warning payloads as non-terminal', () => {
    const payload = {
      data: {
        message: '工具连续 2 次失败: Cannot find module docx',
        level: 'warning',
      },
      sessionId: 'session-1',
    };

    expect(normalizeAgentErrorPayload(payload)).toMatchObject({
      message: '工具连续 2 次失败: Cannot find module docx',
      level: 'warning',
      sessionId: 'session-1',
    });
    expect(getAgentErrorMessage(payload)).toBe('工具连续 2 次失败: Cannot find module docx');
    expect(isTerminalAgentError(payload)).toBe(false);
  });

  it('does not invent Unknown error copy for empty payloads', () => {
    expect(getAgentErrorMessage({})).toBeNull();
    expect(formatAgentErrorContent({})).toBeNull();
  });

  it('keeps context length errors as terminal with specific guidance', () => {
    const content = formatAgentErrorContent({
      code: 'CONTEXT_LENGTH_EXCEEDED',
      message: '上下文超限',
      details: { requested: 4481000, max: 4000000 },
      suggestion: '新开会话继续。',
    });

    expect(isTerminalAgentError({ code: 'CONTEXT_LENGTH_EXCEEDED', message: '上下文超限' })).toBe(true);
    expect(content).toContain('上下文超限');
    expect(content).toContain('4481K tokens');
    expect(content).toContain('4000K tokens');
    expect(content).toContain('新开会话继续。');
  });
});
