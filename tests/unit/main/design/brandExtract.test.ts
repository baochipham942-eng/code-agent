import { describe, expect, it } from 'vitest';
import {
  extractBrandFromImage,
  parseBrandDraftJson,
} from '../../../../src/host/services/design/brandExtract';

// 一份模型可能返回的「干净」JSON（5 色 + serif/sans + posture + 三桶）。
const cleanJson = JSON.stringify({
  palette: {
    primary: '#0b3d2e',
    surface: '#f7f5f0',
    accent: '#c8a24a',
    muted: '#7a7a72',
    contrast: '#16140f',
  },
  fonts: {
    serif: 'Tiempos, Georgia, serif',
    sans: 'Inter, system-ui, sans-serif',
  },
  posture: '克制、留白、让产品说话',
  keep: ['圆角克制', '大量留白'],
  change: ['主色可在深浅间浮动'],
  doNotCopy: ['不要渐变按钮', '不要 emoji 图标'],
});

// 同样内容但包在 ```json 围栏 + 前后散文里（模型常见输出）。
const fencedJson = `这是我对参考图的分析：\n\n\`\`\`json\n${cleanJson}\n\`\`\`\n\n希望有帮助。`;

describe('parseBrandDraftJson', () => {
  it('parses clean JSON into a well-formed BrandDraft', () => {
    const draft = parseBrandDraftJson(cleanJson);
    expect(draft.tokens.palette.primary).toBe('#0b3d2e');
    expect(draft.tokens.palette.surface).toBe('#f7f5f0');
    expect(draft.tokens.palette.accent).toBe('#c8a24a');
    expect(draft.tokens.palette.muted).toBe('#7a7a72');
    expect(draft.tokens.palette.contrast).toBe('#16140f');
    expect(draft.tokens.fonts.serif).toContain('Tiempos');
    expect(draft.tokens.fonts.sans).toContain('Inter');
    expect(draft.tokens.posture).toBe('克制、留白、让产品说话');
    expect(draft.keep).toEqual(['圆角克制', '大量留白']);
    expect(draft.change).toEqual(['主色可在深浅间浮动']);
    expect(draft.doNotCopy).toEqual(['不要渐变按钮', '不要 emoji 图标']);
  });

  it('tolerates ```json fences and surrounding prose', () => {
    const draft = parseBrandDraftJson(fencedJson);
    expect(draft.tokens.palette.primary).toBe('#0b3d2e');
    expect(draft.tokens.fonts.sans).toContain('Inter');
    expect(draft.doNotCopy.length).toBe(2);
  });

  it('fills every missing palette slot from defaults (partial palette)', () => {
    const partial = JSON.stringify({
      palette: { primary: '#112233' }, // 只有 1 色
      posture: '只有主色',
    });
    const draft = parseBrandDraftJson(partial);
    // 5 槽都在且非空
    for (const k of ['primary', 'surface', 'accent', 'muted', 'contrast'] as const) {
      expect(typeof draft.tokens.palette[k]).toBe('string');
      expect(draft.tokens.palette[k].length).toBeGreaterThan(0);
    }
    expect(draft.tokens.palette.primary).toBe('#112233'); // 模型给的保留
    expect(draft.tokens.fonts.serif.length).toBeGreaterThan(0); // fonts 兜底
    expect(draft.tokens.fonts.sans.length).toBeGreaterThan(0);
    expect(draft.tokens.posture).toBe('只有主色');
  });

  it('does not throw on malformed/non-JSON, returns a default-filled draft', () => {
    const draft = parseBrandDraftJson('抱歉我无法分析这张图片。');
    for (const k of ['primary', 'surface', 'accent', 'muted', 'contrast'] as const) {
      expect(draft.tokens.palette[k].length).toBeGreaterThan(0);
    }
    expect(draft.tokens.fonts.serif.length).toBeGreaterThan(0);
    expect(draft.tokens.posture.length).toBeGreaterThan(0);
    expect(Array.isArray(draft.keep)).toBe(true);
    expect(Array.isArray(draft.change)).toBe(true);
    expect(Array.isArray(draft.doNotCopy)).toBe(true);
  });

  it('coerces non-array buckets to [] and filters empty/non-string items', () => {
    const messy = JSON.stringify({
      palette: {
        primary: '#1', surface: '#2', accent: '#3', muted: '#4', contrast: '#5',
      },
      fonts: { serif: 'A', sans: 'B' },
      posture: 'p',
      keep: 'not-an-array',
      change: ['ok', '', 123, '  ', 'two'],
      doNotCopy: null,
    });
    const draft = parseBrandDraftJson(messy);
    expect(draft.keep).toEqual([]);
    expect(draft.change).toEqual(['ok', 'two']);
    expect(draft.doNotCopy).toEqual([]);
  });
});

describe('extractBrandFromImage (mocked vision call)', () => {
  const fakePng = Buffer.from('not-a-real-png').toString('base64');
  const dataUrl = `data:image/png;base64,${fakePng}`;

  it('maps a canned vision JSON response into a BrandDraft (no real call)', async () => {
    const draft = await extractBrandFromImage(
      { dataUrl },
      { visionCall: async () => cleanJson },
    );
    expect(draft.tokens.palette.accent).toBe('#c8a24a');
    expect(draft.keep).toContain('圆角克制');
    expect(draft.doNotCopy.length).toBe(2);
  });

  it('survives a fenced vision response', async () => {
    const draft = await extractBrandFromImage(
      { dataUrl },
      { visionCall: async () => fencedJson },
    );
    expect(draft.tokens.palette.primary).toBe('#0b3d2e');
  });

  it('returns a default-filled draft when the model returns prose (does not throw)', async () => {
    const draft = await extractBrandFromImage(
      { dataUrl },
      { visionCall: async () => '我看不清这张图。' },
    );
    expect(draft.tokens.palette.primary.length).toBeGreaterThan(0);
    expect(draft.tokens.posture.length).toBeGreaterThan(0);
  });

  it('throws on empty image input', async () => {
    await expect(
      extractBrandFromImage({}, { visionCall: async () => cleanJson }),
    ).rejects.toThrow();
  });
});
