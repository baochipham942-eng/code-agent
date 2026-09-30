import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import { sanitizeToolResultForObservation } from '../../../src/host/agent/runtime/toolObservationSanitizers';
import { register, unregister } from '../../../src/host/plugins/pluginToolOrigin';

const state = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const [{ zh }, { en }] = await Promise.all([
    import('../../../src/renderer/i18n/zh'),
    import('../../../src/renderer/i18n/en'),
  ]);
  return { useI18n: () => ({ t: state.language === 'en' ? en : zh, language: state.language }) };
});

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (value: { openPreview: () => void }) => unknown) => selector({ openPreview: () => {} }),
}));

vi.mock('../../../src/renderer/utils/featureFlags', () => ({
  isSemanticToolUIEnabled: () => false,
}));

const { ToolHeader } = await import('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolHeader');

function renderWithOrigin(
  language: 'zh' | 'en',
  pluginOrigin?: unknown,
): string {
  return renderToolCall(language, pluginOrigin === undefined
    ? { toolCallId: 'plugin-call', success: true }
    : {
      toolCallId: 'plugin-call',
      success: true,
      metadata: { pluginOrigin },
    });
}

function renderToolCall(language: 'zh' | 'en', result?: ToolCall['result']): string {
  state.language = language;
  const toolCall: ToolCall = {
    id: 'plugin-call',
    name: 'plugin.test:tool',
    arguments: {},
    result,
  };
  return renderToStaticMarkup(<ToolHeader toolCall={toolCall} status="success" />);
}

describe('ToolHeader plugin origin', () => {
  it('shows the host-derived plugin name with zh and en source wording', () => {
    register('plugin.test:tool', 'plugin.test', 'Human Plugin');
    const result = sanitizeToolResultForObservation(
      { name: 'plugin.test:tool', arguments: {} },
      { toolCallId: 'plugin-call', success: true },
    );
    unregister('plugin.test:tool');
    const zh = renderToolCall('zh', result);
    const en = renderToolCall('en', result);

    expect(zh).toContain('来自插件《Human Plugin》');
    expect(zh).not.toContain('plugin.test');
    expect(en).toContain('From plugin Human Plugin');
    expect(en).not.toContain('plugin.test');
    expect(zh).toContain('data-testid="tool-plugin-origin"');
  });

  it('does not show source wording without a plugin id or with malformed metadata', () => {
    const cases = [
      undefined,
      {},
      { pluginName: 'Name only' },
      null,
      [],
      { pluginId: 42, pluginName: 'Name' },
      { pluginId: 'plugin.test', pluginName: 42 },
    ];

    for (const language of ['zh', 'en'] as const) {
      for (const metadata of cases) {
        const html = renderWithOrigin(language, metadata);
        expect(html).not.toContain('tool-plugin-origin');
        expect(html).not.toContain(language === 'zh' ? '来自插件' : 'From plugin');
      }
      expect(renderToolCall(language)).not.toContain('tool-plugin-origin');
    }
  });

  it('falls back to the plugin id when the display name is missing', () => {
    expect(renderWithOrigin('zh', { pluginId: 'plugin.test' })).toContain('来自插件《plugin.test》');
    expect(renderWithOrigin('en', { pluginId: 'plugin.test' })).toContain('From plugin plugin.test');
  });
});
