import { describe, it, expect } from 'vitest';
import { mergeDiscoveredModelEntry } from '../../../src/renderer/components/features/settings/tabs/ModelSettings.helpers';

describe('mergeDiscoveredModelEntry 重发现合并', () => {
  it('纯生成模型：用新推断覆盖旧 vision 误标', () => {
    const existing = { label: 'img', enabled: true, capabilities: ['general', 'vision', 'fast'] } as any;
    const discovered = { id: 'agnes-image-2.1-flash', label: 'img', capabilities: ['imageGen', 'fast'] } as any;
    const out = mergeDiscoveredModelEntry(existing, discovered, true, 123);
    expect(out.capabilities).toEqual(['imageGen', 'fast']);   // 覆盖
    expect(out.capabilities).not.toContain('vision');
    expect(out.supportsVision).toBe(false);
  });
  it('生视频模型：补 videoGen 覆盖旧 [general]', () => {
    const existing = { capabilities: ['general'], enabled: true } as any;
    const discovered = { id: 'agnes-video-v2.0', label: 'v', capabilities: ['videoGen'] } as any;
    expect(mergeDiscoveredModelEntry(existing, discovered, true, 1).capabilities).toEqual(['videoGen']);
  });
  it('聊天模型：保留已存 vision，不被名字推断覆盖丢失', () => {
    const existing = { capabilities: ['general', 'vision', 'fast'], enabled: true } as any;
    const discovered = { id: 'agnes-2.0-flash', label: 'c', capabilities: ['general', 'fast'] } as any;  // 新推断没 vision
    expect(mergeDiscoveredModelEntry(existing, discovered, true, 1).capabilities).toEqual(['general', 'vision', 'fast']);  // 保留
  });
  it('全新模型（无 existing）：用发现 caps', () => {
    const discovered = { id: 'x', label: 'x', capabilities: ['general'] } as any;
    expect(mergeDiscoveredModelEntry(undefined, discovered, true, 1).capabilities).toEqual(['general']);
  });
});
