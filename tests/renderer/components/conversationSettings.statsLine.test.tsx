// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { enSettingsCore } from '../../../src/renderer/i18n/enSettingsCore';
import { zhSettingsCore } from '../../../src/renderer/i18n/zhSettingsCore';

const state = vi.hoisted(() => ({
  runtime: { compressionCount: 0, totalSavedTokens: 0 as number | undefined },
  model: 'kimi-k2.5',
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn(async () => ({
      config: {
        enabled: true,
        warningThreshold: 0.75,
        preserveRecentCount: 10,
        compactProvider: 'moonshot',
        compactModel: state.model,
        auditEnabled: true,
      },
      runtime: { ...state.runtime, recentStrategies: [] },
      compactModel: { provider: 'moonshot', model: state.model, configured: !!state.model },
      features: { audit: 'enabled', manifest: 'enabled', hooks: 'available' },
    })),
  },
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { error: vi.fn() },
}));

import { ConversationSettings } from '../../../src/renderer/components/features/settings/tabs/ConversationSettings';

const copies = {
  zh: zhSettingsCore.conversation,
  en: enSettingsCore.conversation,
} as const;

describe('ConversationSettings compression stats line', () => {
  beforeEach(() => {
    state.model = 'kimi-k2.5';
  });
  afterEach(() => {
    cleanup();
  });

  for (const lang of ['zh', 'en'] as const) {
    const c = copies[lang];
    const f = c.features;
    const marker = f.manifestPrefix.trim();

    const cases: Array<[string, number, number | undefined, string]> = [
      ['count 0 / saved 0', 0, 0, f.runtimeEmpty],
      ['count 0 / saved undefined', 0, undefined, f.runtimeEmpty],
      ['count 3 / saved 0', 3, 0, `${f.runtimePrefix}3${f.runtimeMiddle}0${f.runtimeSuffix}`],
      ['count 3 / saved 500', 3, 500, `${f.runtimePrefix}3${f.runtimeMiddle}500${f.runtimeSuffix}`],
      ['count 5 / saved 3200', 5, 3200, `${f.runtimePrefix}5${f.runtimeMiddle}3K${f.runtimeSuffix}`],
    ];

    for (const [name, count, saved, expected] of cases) {
      it(`${lang}: ${name} renders "${expected}" without the notSet word`, async () => {
        useAppStore.setState({ language: lang });
        state.runtime = { compressionCount: count, totalSavedTokens: saved };
        render(React.createElement(ConversationSettings));
        await waitFor(() => {
          expect(document.body.textContent).toContain(expected);
        });
        const line = Array.from(document.querySelectorAll('span')).find(
          (s) => s.children.length === 0 && s.textContent === expected,
        );
        console.log(`[stats-line ${lang} ${name}]`, line?.textContent);
        expect(line).toBeTruthy();
        expect(line?.textContent).not.toContain(c.notSet);
      });
    }

    it(`${lang}: summary model row still shows notSet when no model configured`, async () => {
      useAppStore.setState({ language: lang });
      state.runtime = { compressionCount: 0, totalSavedTokens: 0 };
      state.model = '';
      render(React.createElement(ConversationSettings));
      await waitFor(() => {
        expect(document.body.textContent).toContain(marker);
      });
      expect(document.body.textContent).toContain(c.notSet);
    });
  }
});
