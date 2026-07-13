// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelThinkingControl } from '../../../src/renderer/components/features/settings/tabs/ModelThinkingControl';
import type {
  ModelEntrySettings,
  ModelThinkingCapability,
} from '../../../src/shared/contract';
import { useAppStore } from '../../../src/renderer/stores/appStore';

beforeEach(() => {
  useAppStore.setState({ language: 'en' });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ModelThinkingControl', () => {
  it('renders a bounded numeric input for budget models', () => {
    const onChange = vi.fn();
    const view = render(
      <ModelThinkingControl
        capability={{ kind: 'budget', minBudgetTokens: 1024, maxBudgetTokens: 32768, defaultBudgetTokens: 8192 }}
        onChange={onChange}
      />,
    );

    const input = view.getByRole('spinbutton', { name: 'Thinking budget tokens' });
    expect(input.getAttribute('min')).toBe('1024');
    expect(input.getAttribute('max')).toBe('32768');
    expect((input as HTMLInputElement).value).toBe('8192');
    fireEvent.change(input, { target: { value: '99999' } });
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true, budgetTokens: 32768 });
  });

  it('renders only the declared effort levels', () => {
    const view = render(
      <ModelThinkingControl
        capability={{ kind: 'effort', levels: ['low', 'high'], defaultEffort: 'high' }}
        onChange={vi.fn()}
      />,
    );

    const select = view.getByRole('combobox', { name: 'Reasoning depth' });
    expect((select as HTMLSelectElement).value).toBe('high');
    expect(Array.from(select.querySelectorAll('option')).map((option) => option.value)).toEqual(['low', 'high']);
  });

  it('renders a switch for toggle models', () => {
    const onChange = vi.fn();
    const view = render(
      <ModelThinkingControl
        capability={{ kind: 'toggle', defaultEnabled: true }}
        onChange={onChange}
      />,
    );

    const toggle = view.getByRole('switch', { name: 'Enable thinking for this model' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ enabled: false });
  });

  it.each<ModelThinkingCapability>([
    { kind: 'none' },
    { kind: 'unknown' },
  ])('renders no control for $kind models', (capability) => {
    const { container } = render(
      <ModelThinkingControl capability={capability} onChange={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('writes the effort preference into ModelEntrySettings.thinking and reads it back', () => {
    let persisted: ModelEntrySettings | undefined;
    function Harness() {
      const [settings, setSettings] = useState<ModelEntrySettings>({});
      persisted = settings;
      return (
        <ModelThinkingControl
          capability={{ kind: 'effort', levels: ['low', 'medium', 'high'] }}
          preference={settings.thinking}
          onChange={(thinking) => setSettings((current) => ({ ...current, thinking }))}
        />
      );
    }

    const view = render(<Harness />);
    fireEvent.change(view.getByRole('combobox', { name: 'Reasoning depth' }), {
      target: { value: 'high' },
    });

    expect(persisted?.thinking).toEqual({ enabled: true, effort: 'high' });
    expect((view.getByRole('combobox', { name: 'Reasoning depth' }) as HTMLSelectElement).value).toBe('high');
  });
});
