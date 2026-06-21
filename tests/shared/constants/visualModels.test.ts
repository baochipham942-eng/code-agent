import { describe, it, expect } from 'vitest';
import {
  IMAGE_MODELS, imageModelById, imageEngineForModel, defaultImageModelId,
} from '../../../src/shared/constants/visualModels';

describe('visualModels registry (image)', () => {
  it('含 wanx/cogview/flux 三模型且都带 t2i 能力', () => {
    const ids = IMAGE_MODELS.map((m) => m.id);
    expect(ids).toContain('wanx-t2i');
    expect(ids).toContain('gpt-image-2');
    expect(ids).toContain('cogview-4');
    expect(ids).toContain('flux-2');
    expect(IMAGE_MODELS.every((m) => m.caps.includes('t2i'))).toBe(true);
    expect(imageModelById('gpt-image-2')?.caps).toEqual(['t2i']);
    expect(imageEngineForModel('gpt-image-2')).toBe('gptimage');
  });
  it('只有 wanx 带 maskEdit/expand 能力（D2）', () => {
    expect(imageModelById('wanx-t2i')?.caps).toEqual(expect.arrayContaining(['maskEdit', 'expand']));
    expect(imageModelById('cogview-4')?.caps).not.toContain('maskEdit');
    expect(imageModelById('flux-2')?.caps).not.toContain('expand');
  });
  it('imageEngineForModel 映射到 generateImage 的 engine', () => {
    expect(imageEngineForModel('wanx-t2i')).toBe('wanx');
    expect(imageEngineForModel('cogview-4')).toBe('cogview');
    expect(imageEngineForModel('flux-2')).toBe('flux');
  });
  it('默认模型是 wanx（设计模式钦定底座）', () => {
    expect(defaultImageModelId()).toBe('wanx-t2i');
  });
  it('未知 id 返回 undefined / 抛错', () => {
    expect(imageModelById('nope')).toBeUndefined();
    expect(() => imageEngineForModel('nope')).toThrow();
  });
});
