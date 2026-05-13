import { describe, expect, it } from 'vitest';
import type { ActivityContext } from '../../../src/shared/contract/activityContext';
import { buildActivityPanelModel } from '../../../src/renderer/components/features/activity/activityPanelModel';
import type { ActivityContextPreview } from '../../../src/renderer/services/activityContext';

const preview: ActivityContextPreview = {
  capturedAtMs: 1_713_456_000_000,
  status: 'ready',
  recentContextSummary: '09:00-09:30 在 Cursor 处理 Activity provider。',
  agentInjectionPreview: 'OpenChronicle + desktop activity prompt preview',
  sources: [],
  evidence: [],
};

const context: ActivityContext = {
  generatedAtMs: 1_713_456_000_000,
  maxChars: 12_000,
  tokenBudgetHint: {
    maxChars: 12_000,
    targetTokens: 3_000,
  },
  sources: [
    {
      source: 'openchronicle',
      status: 'available',
      confidence: 0.72,
      privacy: 'redacted',
      generatedAtMs: 1_713_456_000_000,
      maxChars: 3_000,
      text: 'screen memory summary',
      evidenceRefs: [
        {
          source: 'openchronicle',
          kind: 'openchronicle-context',
          id: 'screen-1',
          label: 'OpenChronicle current_context',
        },
      ],
    },
    {
      source: 'tauri-native-desktop',
      status: 'available',
      confidence: 0.82,
      privacy: 'local-only',
      generatedAtMs: 1_713_456_000_000,
      maxChars: 4_000,
      text: 'Cursor | ActivityPanel.tsx',
      items: [{ id: 'desktop-1', title: 'ActivityPanel.tsx' }],
      evidenceRefs: [
        {
          source: 'tauri-native-desktop',
          kind: 'desktop-event',
          id: 'desktop-1',
          label: 'ActivityPanel.tsx',
        },
      ],
    },
    {
      source: 'audio',
      status: 'unavailable',
      confidence: 0,
      privacy: 'local-only',
      generatedAtMs: 1_713_456_000_000,
      maxChars: 3_000,
      text: null,
      items: [],
      evidenceRefs: [],
      unavailableReason: 'No audio segments found in the last hour',
    },
    {
      source: 'screenshot-analysis',
      status: 'available',
      confidence: 0.74,
      privacy: 'local-only',
      generatedAtMs: 1_713_456_000_000,
      maxChars: 2_000,
      text: 'Screenshot showed Activity controls',
      evidenceRefs: [
        {
          source: 'screenshot-analysis',
          kind: 'screenshot-analysis',
          id: 'shot-1',
          label: 'Activity controls',
          path: '/Users/linchen/private/native_screenshot_123.png',
        },
      ],
    },
  ],
  evidenceRefs: [
    {
      source: 'openchronicle',
      kind: 'openchronicle-context',
      id: 'screen-1',
      label: 'OpenChronicle current_context',
    },
    {
      source: 'screenshot-analysis',
      kind: 'screenshot-analysis',
      id: 'shot-1',
      label: 'Activity controls',
      path: '/Users/linchen/private/native_screenshot_123.png',
    },
  ],
};

describe('activity panel model', () => {
  it('separates prompt injection sources from local evidence', () => {
    const model = buildActivityPanelModel({
      mode: 'tauri',
      shellLabel: 'Tauri 桌面版',
      providers: [],
      context,
      preview,
      native: {
        collectorStatus: null,
        recentEvents: [
          {
            id: 'event-1',
            capturedAtMs: 1_713_456_100_000,
            appName: 'Cursor',
            windowTitle: 'ActivityPanel.tsx',
            screenshotPath: '/Users/linchen/private/native_screenshot_123.png',
            analyzeText: 'Activity page is open',
            fingerprint: 'fp',
          },
        ],
        audioStatus: null,
        audioSegments: [],
      },
    });

    expect(model.injectionItems.map((item) => item.label)).toEqual([
      '自动屏幕记忆',
      '桌面活动',
      '截图分析',
    ]);
    expect(model.injectionItems[0]?.detail).toContain('<screen-memory>');
    expect(model.injectionItems[1]?.detail).toContain('<desktop-activity-context>');
    expect(model.localEvidenceItems.map((item) => item.detail).join('\n')).toContain('截图文件只作本地证据');
    expect(model.localEvidenceItems.map((item) => item.detail).join('\n')).not.toContain('/Users/linchen');
  });

  it('keeps a readable web-mode empty state without providers', () => {
    const model = buildActivityPanelModel({
      mode: 'web',
      shellLabel: 'Web',
      providers: [],
      context: null,
      preview: {
        capturedAtMs: null,
        status: 'empty',
        recentContextSummary: '暂无可用屏幕上下文。',
        agentInjectionPreview: '暂无内容会注入 agent。',
        sources: [],
        evidence: [],
      },
      native: {
        collectorStatus: null,
        recentEvents: [],
        audioStatus: null,
        audioSegments: [],
      },
    });

    expect(model.modeLabel).toBe('Web 降级');
    expect(model.recentHeadline).toContain('还没有可展示');
    expect(model.capabilityRows).toHaveLength(5);
    expect(model.injectionItems[0]?.label).toBe('暂无可注入内容');
    expect(model.localEvidenceItems[0]?.label).toBe('暂无本地证据');
  });
});
