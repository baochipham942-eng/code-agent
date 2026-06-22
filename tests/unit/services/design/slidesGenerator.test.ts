// ============================================================================
// slidesGenerator - 设计 tab 厚版演示稿生成 service（二期 MVP）
// 把现有 PPT 引擎（outlineToSlideData + registerSlideMasters + fillSlide）从 agent
// 工具中抽出，设计 tab IPC 可直调。覆盖：确定性大纲 → 真 pptxgenjs deck（PK 魔数）；
// 页数透传；content（markdown）优先于 topic 大纲；空 topic 抛可读错误。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { generateSlidesDeck, buildSlidesOutline } from '../../../../src/main/services/design/slidesGenerator';

describe('generateSlidesDeck', () => {
  it('从 topic 确定性大纲生成有效 PPTX（ZIP 魔数 PK，非平凡体积）', async () => {
    const { buffer, slidesCount } = await generateSlidesDeck({
      topic: '一份面向投资人的 SaaS 产品介绍',
      slidesCount: 8,
    });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    // PPTX = OOXML = ZIP 容器，前两字节 'PK'。
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');
    // 多页含 master 装饰 → 远超空 zip。
    expect(buffer.length).toBeGreaterThan(2000);
    expect(slidesCount).toBeGreaterThan(0);
  });

  it('页数透传：slidesCount 决定输出页数', async () => {
    const small = await generateSlidesDeck({ topic: '主题 A', slidesCount: 5 });
    const large = await generateSlidesDeck({ topic: '主题 A', slidesCount: 12 });
    expect(large.slidesCount).toBeGreaterThan(small.slidesCount);
  });

  it('content（markdown）优先于 topic 大纲', async () => {
    const md = '# 标题页\n\n## 第一节\n- 要点一\n- 要点二\n\n## 第二节\n- 要点三';
    const { buffer, slidesCount } = await generateSlidesDeck({
      topic: '忽略的主题',
      content: md,
    });
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(slidesCount).toBeGreaterThan(0);
  });

  it('空 topic 抛可读错误', async () => {
    await expect(generateSlidesDeck({ topic: '   ' })).rejects.toThrow(/主题/);
  });

  it('未知 theme 回退默认主题，不抛错', async () => {
    const { buffer } = await generateSlidesDeck({
      topic: '主题',
      slidesCount: 4,
      theme: 'does-not-exist',
    });
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('slides 直传（已编辑大纲）优先于 topic，据此排版', async () => {
    const { buffer, slidesCount } = await generateSlidesDeck({
      topic: '会被忽略',
      slides: [
        { title: '封面页', subtitle: '副标题', points: [], isTitle: true },
        { title: '第一节', points: ['要点一', '要点二'] },
        { title: '谢谢', points: [], isEnd: true },
      ],
    });
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(slidesCount).toBe(3);
  });

  it('slides 直传时 topic 可省（取首页标题为 deck 标题）', async () => {
    const { buffer } = await generateSlidesDeck({
      slides: [{ title: '只有这一页', points: ['内容'] }],
    });
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');
  });
});

describe('buildSlidesOutline', () => {
  it('从 topic 生成确定性大纲（含封面页 + 内容页）', () => {
    const outline = buildSlidesOutline('一份产品介绍', 8);
    expect(outline.length).toBeGreaterThan(0);
    expect(outline[0].isTitle).toBe(true);
    expect(outline[0].title).toBe('一份产品介绍');
    // 内容页含要点
    expect(outline.some((s) => !s.isTitle && s.points.length > 0)).toBe(true);
  });

  it('页数透传', () => {
    expect(buildSlidesOutline('x', 12).length).toBeGreaterThan(buildSlidesOutline('x', 5).length);
  });

  it('空 topic 抛可读错误', () => {
    expect(() => buildSlidesOutline('  ')).toThrow(/主题/);
  });
});
