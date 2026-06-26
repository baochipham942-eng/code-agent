// 内容保真回归（#5）：结构化 slides 走渲染后，每页落各自真内容、不串页、不漏 markdown，
// 标题页只放短标题（不再像旧 bug 那样把整份大纲塞进标题页溢出炸版）。
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { generateSlidesDeck } from '../../../../src/main/services/design/slidesGenerator';
import type { SlideData } from '../../../../src/main/tools/media/ppt/types';

async function slideTexts(buffer: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer);
  const out: string[] = [];
  for (let n = 1; ; n += 1) {
    const f = zip.file(`ppt/slides/slide${n}.xml`);
    if (!f) break;
    const xml = await f.async('string');
    out.push((xml.match(/<a:t>[^<]*<\/a:t>/g) || []).map((t) => t.replace(/<[^>]*>/g, '')).join(' '));
  }
  return out;
}

describe('slidesGenerator 内容保真 (#5)', () => {
  const slides: SlideData[] = [
    { title: 'Code Agent 行业趋势 2026', subtitle: '从辅助编码到自主代理', points: [], isTitle: true },
    { title: '市场规模', points: ['AI 代码工具市场 93.5 亿美元', 'CAGR 46.3%'] },
    { title: '主流产品五强', points: ['Cursor', 'Claude Code', 'Cline'] },
    { title: '谢谢观看', points: [], isEnd: true },
  ];

  it('每页落各自真内容，不串页、不套模板', async () => {
    const { buffer } = await generateSlidesDeck({ slides, topic: 'Code Agent 行业趋势 2026' });
    const texts = await slideTexts(buffer);
    expect(texts.length).toBe(4);
    expect(texts[1]).toContain('市场规模');
    expect(texts[1]).toContain('93.5 亿美元');
    expect(texts[2]).toContain('主流产品五强');
    expect(texts[2]).toContain('Cursor');
    // 不该出现确定性 SCQA 空模板词
    const all = texts.join(' ');
    expect(all).not.toContain('背景概述');
    expect(all).not.toContain('面临挑战');
  });

  it('标题页只放短标题/副标题，不把后续页内容塞进去（修旧溢出炸版）', async () => {
    const { buffer } = await generateSlidesDeck({ slides, topic: 'Code Agent 行业趋势 2026' });
    const texts = await slideTexts(buffer);
    expect(texts[0]).toContain('Code Agent 行业趋势 2026');
    // 标题页不该含后续页的正文/标题
    expect(texts[0]).not.toContain('市场规模');
    expect(texts[0]).not.toContain('93.5');
  });

  it('渲染产物无 Markdown 标记残留（## / - 列表符当正文）', async () => {
    const { buffer } = await generateSlidesDeck({
      slides: [
        { title: '封面', points: [], isTitle: true },
        { title: '一节', points: ['要点一', '要点二'] },
      ] as SlideData[],
      topic: '主题',
    });
    const all = (await slideTexts(buffer)).join(' ');
    expect(all).not.toMatch(/##/);
  });
});
