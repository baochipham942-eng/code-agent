import { describe, expect, it } from 'vitest';
import {
  normalizeActivityContextResponse,
  redactActivityEvidence,
} from '../../../src/renderer/services/activityContext';

describe('activityContext renderer service', () => {
  it('normalizes mixed ActivityContext sources for the screen memory preview', () => {
    const preview = normalizeActivityContextResponse({
      capturedAtMs: 1_713_456_000_000,
      recentContextSummary: '09:00-09:30 主要在 Cursor 处理 ScreenMemorySettings。',
      agentInjectionPreview: '<desktop-activity-context>继续处理屏幕记忆预览</desktop-activity-context>',
      sources: [
        { kind: 'background', summary: '桌面活动时间片' },
        { kind: 'manual_capture', summary: '用户手动刷新' },
        { kind: 'meeting_audio', summary: '会议转录摘要' },
        { kind: 'screenshot_analysis', summary: '截图语义摘要' },
      ],
      evidence: [
        '截图: /Users/linchen/.code-agent/native-desktop/screenshots/2026-04-26/collector_1713456000000.jpg',
        '窗口: Cursor',
      ],
    });

    expect(preview.status).toBe('ready');
    expect(preview.sources.map((source) => source.label)).toEqual([
      '自动后台',
      '手动采集',
      '会议音频',
      '截图分析',
    ]);
    expect(preview.recentContextSummary).toContain('ScreenMemorySettings');
    expect(preview.agentInjectionPreview).toContain('继续处理屏幕记忆预览');
    expect(preview.evidence.join('\n')).not.toContain('/Users/linchen');
    expect(preview.evidence.join('\n')).not.toContain('collector_1713456000000.jpg');
  });

  it('returns a stable empty preview for missing backend payloads', () => {
    const preview = normalizeActivityContextResponse(null);

    expect(preview.status).toBe('empty');
    expect(preview.recentContextSummary).toContain('暂无可用屏幕上下文');
    expect(preview.agentInjectionPreview).toContain('暂无内容会注入 agent');
    expect(preview.sources).toEqual([]);
  });

  it('redacts local paths and screenshot filenames from evidence summaries', () => {
    expect(redactActivityEvidence('file /Users/linchen/a/b/native_screenshot_123.jpg ready'))
      .toBe('file [local path hidden] ready');
    expect(redactActivityEvidence('collector_123456.png analyzed'))
      .toBe('[screenshot hidden] analyzed');
  });
});
