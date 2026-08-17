import { describe, expect, it } from 'vitest';
import { highlightCode } from '../../../src/renderer/components/features/chat/MessageBubble/ShikiCodeBlock';

describe('ShikiCodeBlock highlighter', () => {
  it('按需加载语言并为亮暗主题生成 token', async () => {
    const code = 'const answer: number = 42;';
    const [dark, light] = await Promise.all([
      highlightCode(code, 'ts', 'one-dark-pro'),
      highlightCode(code, 'ts', 'one-light'),
    ]);

    expect(dark?.flat().map((token) => token.content).join('')).toBe(code);
    expect(light?.flat().map((token) => token.content).join('')).toBe(code);
    expect(dark?.flat().some((token) => token.color)).toBe(true);
    expect(light?.flat().some((token) => token.color)).toBe(true);
    expect(dark?.flat().map((token) => token.color)).not.toEqual(
      light?.flat().map((token) => token.color),
    );
  });

  it('未知语言安全退回纯文本', async () => {
    await expect(highlightCode('hello', 'neo-unknown', 'one-dark-pro')).resolves.toBeNull();
  });
});
