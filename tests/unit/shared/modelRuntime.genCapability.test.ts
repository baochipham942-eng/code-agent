import { describe, it, expect } from 'vitest';
import { inferModelCapabilities, isPureGenerationModel, mediaTypeForGenCapability } from '../../../src/shared/modelRuntime';

describe('生成能力推断与消歧', () => {
  it('生图模型名 → imageGen，不误判 vision', () => {
    const caps = inferModelCapabilities('agnes-image-2.1-flash');
    expect(caps).toContain('imageGen');
    expect(caps).not.toContain('vision');
  });
  it('omni/4o 仍是 vision 输入，非 imageGen', () => {
    expect(inferModelCapabilities('gpt-4o')).toContain('vision');
    expect(inferModelCapabilities('gpt-4o')).not.toContain('imageGen');
  });
  it('生视频/生音乐模型名', () => {
    expect(inferModelCapabilities('agnes-video-v2.0')).toContain('videoGen');
    expect(inferModelCapabilities('music-2.6')).toContain('musicGen');
  });
  it('纯生成判定：只有 *Gen 无 chat 能力', () => {
    expect(isPureGenerationModel(['imageGen'])).toBe(true);
    expect(isPureGenerationModel(['imageGen', 'general'])).toBe(false);
  });
  it('能力→媒介映射', () => {
    expect(mediaTypeForGenCapability('imageGen')).toBe('image');
    expect(mediaTypeForGenCapability('videoGen')).toBe('video');
    expect(mediaTypeForGenCapability('musicGen')).toBe('music');
  });
});
