import { describe, expect, it } from 'vitest';
import {
  formatDesignContextLines,
  buildPrototypePrompt,
  buildImagePrompt,
  DESIGN_TONE_OPTIONS,
} from '../../../src/renderer/components/design/designTypes';

describe('formatDesignContextLines', () => {
  it('空上下文返回空数组', () => {
    expect(formatDesignContextLines(undefined)).toEqual([]);
    expect(formatDesignContextLines({})).toEqual([]);
  });

  it('含品牌色时给出锚点并禁 AI 默认渐变', () => {
    const out = formatDesignContextLines({ brandColor: '#0066ff' }).join('\n');
    expect(out).toContain('#0066ff');
    expect(out).toContain('紫→蓝');
  });

  it('含 surface 与语气', () => {
    const out = formatDesignContextLines({ surface: 'brand', tone: ['极简', '科技感'] }).join('\n');
    expect(out).toContain('Brand-led');
    expect(out).toContain('极简、科技感');
  });
});

describe('buildPrototypePrompt', () => {
  const base = { requirement: '一个登录页', reservedPath: '.neo-design/proto-1.html' };

  it('包含预留路径与单次 Write/单文件硬约束', () => {
    const p = buildPrototypePrompt(base);
    expect(p).toContain('.neo-design/proto-1.html');
    expect(p).toContain('一次 Write');
    expect(p).toContain('</html>');
    expect(p).toContain('一个登录页');
  });

  it('注入设计上下文', () => {
    const p = buildPrototypePrompt({ ...base, designContext: { brandColor: '#0066ff' } });
    expect(p).toContain('#0066ff');
  });
});

describe('buildImagePrompt', () => {
  it('设计稿走 image_generate', () => {
    const p = buildImagePrompt({ requirement: '电商首页', outputType: 'mockup' });
    expect(p).toContain('image_generate');
    expect(p).toContain('UI 设计稿');
    expect(p).toContain('电商首页');
  });

  it('信息图标签正确', () => {
    expect(buildImagePrompt({ requirement: 'x', outputType: 'infographic' })).toContain('信息图');
  });
});

describe('DESIGN_TONE_OPTIONS', () => {
  it('提供语气候选', () => {
    expect(DESIGN_TONE_OPTIONS).toContain('极简');
    expect(DESIGN_TONE_OPTIONS.length).toBeGreaterThan(4);
  });
});
