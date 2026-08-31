import { createRequire } from 'node:module';
import {
  appendRubricToPrompt,
  createPixelDiff,
  parseRepeatedArgs,
  validateReviewDraft,
} from '../../scripts/visual-review/visual-review-core.mjs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { PNG } = require('playwright-core/lib/utilsBundle');

function makePng(pixels: Array<[number, number, number, number]>): Buffer {
  const png = new PNG({ width: pixels.length, height: 1 });
  pixels.forEach((pixel, index) => {
    const offset = index * 4;
    png.data[offset] = pixel[0];
    png.data[offset + 1] = pixel[1];
    png.data[offset + 2] = pixel[2];
    png.data[offset + 3] = pixel[3];
  });
  return PNG.sync.write(png);
}

const tinyRubric = {
  items: [
    { id: 'VR-01', name: '审批卡', criterion: '风险可读' },
    { id: 'VR-02', name: '输入区', criterion: '输入框可见' },
  ],
};

describe('visual review tooling', () => {
  it('parses repeated image arguments without losing their order', () => {
    expect(parseRepeatedArgs([
      '--mode', 'triptych',
      '--image', 'before.png',
      '--image', 'after.png',
      '--image', 'diff.png',
      '--allow-non-linux-probe',
    ])).toMatchObject({
      mode: 'triptych',
      image: ['before.png', 'after.png', 'diff.png'],
      'allow-non-linux-probe': true,
    });
  });

  it('excludes the union of Playwright mask pixels from pixel scoring', () => {
    const before = makePng([
      [255, 0, 255, 255],
      [10, 20, 30, 255],
      [40, 50, 60, 255],
    ]);
    const after = makePng([
      [1, 2, 3, 255],
      [10, 20, 30, 255],
      [41, 50, 60, 255],
    ]);

    const result = createPixelDiff(before, after);

    expect(result).toMatchObject({
      width: 3,
      height: 1,
      maskedPixels: 1,
      scoredPixels: 2,
      changedPixels: 1,
      changedRatio: 0.5,
    });
  });

  it('builds a mode-specific prompt and preserves the fixed rubric order', () => {
    const prompt = appendRubricToPrompt('只看图。', tinyRubric, 'single');

    expect(prompt).toContain('本次只有一张图');
    expect(prompt.indexOf('VR-01')).toBeLessThan(prompt.indexOf('VR-02'));
  });

  it('requires the candidate draft to cover every rubric item in order', () => {
    const draft = {
      draftOnly: true,
      mode: 'single',
      recommendHumanOpen: true,
      summary: '发现一项可见问题。',
      items: [
        { rubricId: 'VR-01', status: 'RED', reason: '风险原因缺失。', region: '中栏' },
        { rubricId: 'VR-02', status: 'NA', reason: '没有提问卡。', region: '全页' },
      ],
    };

    expect(validateReviewDraft(draft, tinyRubric, 'single')).toBe(draft);
    expect(() => validateReviewDraft({ ...draft, recommendHumanOpen: false }, tinyRubric, 'single'))
      .toThrow('recommendHumanOpen');
    expect(() => validateReviewDraft({ ...draft, items: [...draft.items].reverse() }, tinyRubric, 'single'))
      .toThrow('Rubric IDs/order mismatch');
  });
});
