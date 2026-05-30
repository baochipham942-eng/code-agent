import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createRequire } from 'module';
import { describe, expect, it, vi } from 'vitest';
import { executeDesignMode } from '../../../../../../src/main/tools/media/ppt/designMode';
import { getThemeConfig } from '../../../../../../src/main/tools/media/ppt/themes';

const require = createRequire(import.meta.url);

vi.mock('../../../../../../src/main/tools/media/ppt/designExecutor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../../src/main/tools/media/ppt/designExecutor')>();

  return {
    ...actual,
    executeDesignScript: vi.fn(async (scriptPath: string) => {
      const fs = await import('fs');
      const script = fs.readFileSync(scriptPath, 'utf-8');
      const outputMatch = script.match(/fileName:\s*'([^']+)'/);
      if (outputMatch?.[1]) {
        fs.writeFileSync(outputMatch[1], 'pptx-placeholder\n'.repeat(1024), 'utf-8');
      }
      return { success: true, stdout: '' };
    }),
  };
});

function validSlideCode(): string {
  return `\`\`\`typescript
// --- Slide 1: 封面 ---
{
  const s = pptx.addSlide();
  addBg(s);
  s.addText('AI Agent 架构演进', { x: MX, y: 2.5, w: CW, h: 0.8, fontSize: 36, fontFace: F.title, color: DS.text, bold: true, align: 'center' });
  s.addText('从 ReAct 到多代理工作台', { x: MX, y: 3.4, w: CW, h: 0.4, fontSize: 16, fontFace: F.body, color: DS.textMuted, align: 'center' });
  s.addNotes('介绍主题和演进背景。');
}

// --- Slide 2: 行动 ---
{
  const s = pptx.addSlide();
  addBg(s);
  addTitle(s, '从实验走向平台化');
  addCard(s, MX, 1.7, CW, 3.2);
  s.addText('统一编排、可观测、可复用', { x: MX + 0.4, y: 2.8, w: CW - 0.8, h: 0.5, fontSize: 24, fontFace: F.title, color: DS.accent, bold: true, align: 'center' });
  addPageNum(s, 2, 2);
  s.addNotes('总结平台化投资方向。');
}
\`\`\``;
}

describe('executeDesignMode', () => {
  it('retries with compact code-only prompt when the first response has no slide code', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ppt-design-mode-'));
    const outputPath = path.join(dir, 'retry.pptx');
    const pptxgenRoot = path.dirname(path.dirname(require.resolve('pptxgenjs')));
    let calls = 0;

    const result = await executeDesignMode({
      topic: 'AI Agent 架构演进',
      slideCount: 2,
      theme: getThemeConfig('neon-blue'),
      outputPath,
      projectRoot: pptxgenRoot,
      modelCallback: async () => {
        calls += 1;
        return calls === 1 ? '' : validSlideCode();
      },
      enableReview: false,
    });

    expect(result.success).toBe(true);
    expect(calls).toBe(2);
    expect(result.iterations).toBe(1);
    expect(existsSync(outputPath)).toBe(true);
  }, 60_000);
});
