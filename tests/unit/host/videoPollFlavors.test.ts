import { describe, it, expect } from 'vitest';
import { pickVideoFlavor, extractVideoUrl, buildPollUrl, isVideoTerminal } from '../../../src/host/services/media/videoPollFlavors';

describe('视频 poll flavor', () => {
  it('按 host 选 flavor', () => {
    expect(pickVideoFlavor('https://apihub.agnes-ai.com/v1')).toBe('agnes');
    expect(pickVideoFlavor('https://openrouter.ai/api/v1')).toBe('openrouter');
    expect(pickVideoFlavor('https://x.unknown.com/v1')).toBe('standard');
  });
  it('agnes 完成 URL 取 remixed_from_video_id', () => {
    expect(extractVideoUrl('agnes', { status: 'completed', remixed_from_video_id: 'https://v/u.mp4' })).toBe('https://v/u.mp4');
  });
  it('openrouter 取 unsigned_urls[0]', () => {
    expect(extractVideoUrl('openrouter', { status: 'completed', unsigned_urls: ['https://v/o.mp4'] })).toBe('https://v/o.mp4');
  });
  it('standard 取 url / data[].url', () => {
    expect(extractVideoUrl('standard', { status: 'completed', url: 'https://v/s.mp4' })).toBe('https://v/s.mp4');
    expect(extractVideoUrl('standard', { status: 'completed', data: [{ url: 'https://v/d.mp4' }] })).toBe('https://v/d.mp4');
  });
  it('未完成/无字段返回 undefined', () => {
    expect(extractVideoUrl('agnes', { status: 'queued' })).toBeUndefined();
    expect(extractVideoUrl('standard', {})).toBeUndefined();
  });
  it('buildPollUrl 各 flavor 路径', () => {
    expect(buildPollUrl('agnes', 'https://apihub.agnes-ai.com/v1', 'vid1')).toBe('https://apihub.agnes-ai.com/agnesapi?video_id=vid1');
    expect(buildPollUrl('standard', 'https://x.com/v1', 'id1')).toBe('https://x.com/v1/videos/id1');
    expect(buildPollUrl('openrouter', 'https://openrouter.ai/api/v1', 'id2')).toBe('https://openrouter.ai/api/v1/videos/id2');
  });
  it('isVideoTerminal 判终态', () => {
    expect(isVideoTerminal('completed')).toEqual({ done: true, failed: false });
    expect(isVideoTerminal('succeeded')).toEqual({ done: true, failed: false });
    expect(isVideoTerminal('failed')).toEqual({ done: false, failed: true });
    expect(isVideoTerminal('queued')).toEqual({ done: false, failed: false });
  });
});
