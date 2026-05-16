import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/utils/platform', () => ({
  isWebMode: () => false,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: vi.fn(),
  },
}));

import { OpenchronicleToggleSwitch } from '../../../src/renderer/components/features/settings/tabs/OpenchronicleSettings';

describe('OpenchronicleToggleSwitch', () => {
  it('anchors the thumb inside the track when enabled', () => {
    const html = renderToStaticMarkup(
      React.createElement(OpenchronicleToggleSwitch, {
        checked: true,
        onToggle: vi.fn(),
      }),
    );

    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('left-0.5');
    expect(html).toContain('translate-x-6');
    expect(html).not.toContain('translate-x-0.5');
  });

  it('keeps the disabled thumb at the left anchor', () => {
    const html = renderToStaticMarkup(
      React.createElement(OpenchronicleToggleSwitch, {
        checked: false,
        onToggle: vi.fn(),
      }),
    );

    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('left-0.5');
    expect(html).toContain('translate-x-0');
  });
});
