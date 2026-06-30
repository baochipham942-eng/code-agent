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
  it('纯生成模型经推断路径也判定为纯生成（不只 override）', () => {
    expect(isPureGenerationModel(inferModelCapabilities('agnes-image-2.1-flash'))).toBe(true);
    expect(isPureGenerationModel(inferModelCapabilities('sora-2'))).toBe(true);
    expect(isPureGenerationModel(inferModelCapabilities('music-2.6'))).toBe(true);
  });
  it('聊天模型经推断路径不被判纯生成', () => {
    expect(isPureGenerationModel(inferModelCapabilities('gpt-4o'))).toBe(false);
    expect(isPureGenerationModel(inferModelCapabilities('deepseek-chat'))).toBe(false);
    expect(isPureGenerationModel(inferModelCapabilities('claude-opus-4-8'))).toBe(false);
  });
  it('fast 是速度档非聊天能力：纯生成+fast 仍是纯生成', () => {
    expect(isPureGenerationModel(['imageGen', 'fast'])).toBe(true);
  });
  it('wan2 图像变体不应误标 videoGen', () => {
    const caps = inferModelCapabilities('wan2.2-t2i-flash');
    expect(caps).toContain('imageGen');
    expect(caps).not.toContain('videoGen');
  });
});
