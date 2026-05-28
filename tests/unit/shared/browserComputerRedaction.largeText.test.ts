import { describe, expect, it } from 'vitest';
import { sanitizeLargeTextToolArguments } from '../../../src/shared/utils/browserComputerRedaction';

describe('sanitizeLargeTextToolArguments — Write content line preservation', () => {
  it('truncates large Write content but keeps authoritative line count for the UI', () => {
    const lines = Array.from({ length: 115 }, (_, i) => `<p>line ${i}</p>`);
    const content = `<!DOCTYPE html>\n${lines.join('\n')}\n</html>`;
    const fullLineCount = content.split('\n').length; // 117

    const out = sanitizeLargeTextToolArguments('Write', { file_path: '/x/index.html', content })!;

    // content 被压成片段（这是 UI 直接 split 片段会算出 ~12 行的根因）
    expect((out.content as string).length).toBeLessThan(content.length);
    expect(out.content).toContain('chars omitted');
    // 但真实长度 / 行数被保留下来，UI 可据此显示正确的行数
    expect(out.content_length).toBe(content.length);
    expect(out.content_lines).toBe(fullLineCount);
    expect(out.content_lines).toBeGreaterThan(100);
  });

  it('leaves small (untruncated) Write content intact and omits content_lines', () => {
    const content = '<p>a</p>\n<p>b</p>\n<p>c</p>';
    const out = sanitizeLargeTextToolArguments('Write', { file_path: '/x/s.html', content })!;

    expect(out.content).toBe(content); // 未截断
    // 未截断时 UI 能直接从 content 算行数，不需要也不设权威行数（行为不变）
    expect(out.content_lines).toBeUndefined();
  });

  it('does not touch non-large-text tools', () => {
    const args = { command: 'ls -la' };
    expect(sanitizeLargeTextToolArguments('Bash', args)).toBe(args);
  });
});
