// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReasoningSegment } from '../../../src/renderer/components/StatusBar/ReasoningSegment';
import {
  buildThinkingSegmentOptions,
  formatNativeModelSwitcherTooltip,
  getReasoningSegmentMode,
  type EffortOption,
} from '../../../src/renderer/components/StatusBar/modelSwitcherHelpers';
import type { EffortLevel } from '../../../src/shared/contract/agent';
import { en, zh } from '../../../src/renderer/i18n';

afterEach(() => {
  cleanup();
});

const effortOptions: EffortOption[] = (['low', 'medium', 'high'] as const).map((value) => ({
  value,
  label: value,
  shortLabel: value,
  color: 'text-zinc-300',
  tint: 'bg-zinc-700',
}));

function segmentOptions(args: {
  setEffortLevel: (level: EffortLevel) => void;
  setThinkingEnabled: (enabled: boolean) => void;
  effortLevel?: EffortLevel;
  effortLevelExplicit?: boolean;
  thinkingEnabled?: boolean;
}) {
  return buildThinkingSegmentOptions({
    labels: zh.settings.model.models,
    effortOptions,
    thinkingEnabled: args.thinkingEnabled ?? true,
    effortLevelExplicit: args.effortLevelExplicit ?? true,
    effortLevel: args.effortLevel ?? 'high',
    setThinkingEnabled: args.setThinkingEnabled,
    setEffortLevel: args.setEffortLevel,
    setAutomaticEffortLevel: () => {
      args.setThinkingEnabled(true);
    },
  });
}

describe('external reasoning segment', () => {
  it('greys every button, shows the dictionary note, and ignores clicks for external engines', () => {
    expect(zh.settings.model.models.thinkingExternalHint).toBe('此引擎自行决定推理档位');
    expect(en.settings.model.models.thinkingExternalHint).toBe('This engine decides its own reasoning level');

    for (const engineKind of ['codex_cli', 'claude_code', 'kimi_code'] as const) {
      const mode = getReasoningSegmentMode({
        engineKind,
        showModelSettingsPrompt: false,
        effortOptionCount: 3,
      });
      expect(mode).toBe('disabled_external');
      const setEffortLevel = vi.fn();
      const setThinkingEnabled = vi.fn();
      const view = render(
        <ReasoningSegment
          mode={mode}
          sectionLabel={zh.settings.model.models.thinkingSectionLabel}
          note={zh.settings.model.models.thinkingExternalHint}
          options={segmentOptions({ setEffortLevel, setThinkingEnabled })}
        />,
      );
      const buttons = view.getAllByRole('button');
      expect(buttons).toHaveLength(5);
      for (const button of buttons) {
        expect((button as HTMLButtonElement).disabled).toBe(true);
        expect(button.getAttribute('aria-disabled')).toBe('true');
        expect(button.className).toContain('opacity-50');
        expect(button.className).toContain('cursor-not-allowed');
        expect(button.className).not.toContain('font-medium');
        expect(button.className).not.toContain('ring-zinc-600/70');
        fireEvent.click(button);
      }
      expect(view.getByText(zh.settings.model.models.thinkingExternalHint)).toBeTruthy();
      const grid = view.container.querySelector('[data-native-reasoning-segment]');
      expect(grid?.parentElement?.getAttribute('title')).toBe(zh.settings.model.models.thinkingExternalHint);
      expect(setEffortLevel).not.toHaveBeenCalled();
      expect(setThinkingEnabled).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  it('keeps non-native kinds disabled even when the native show-rule would hide them', () => {
    for (const engineKind of ['codex_cli', 'claude_code', 'kimi_code'] as const) {
      expect(getReasoningSegmentMode({
        engineKind,
        showModelSettingsPrompt: true,
        effortOptionCount: 1,
      })).toBe('disabled_external');
    }
  });
});

describe('native reasoning segment', () => {
  it('renders enabled buttons, marks the selected option, and forwards clicks', () => {
    const mode = getReasoningSegmentMode({
      engineKind: 'native',
      showModelSettingsPrompt: false,
      effortOptionCount: 3,
    });
    expect(mode).toBe('active');
    const setEffortLevel = vi.fn();
    const setThinkingEnabled = vi.fn();
    const view = render(
      <ReasoningSegment
        mode={mode}
        sectionLabel={zh.settings.model.models.thinkingSectionLabel}
        note={zh.settings.model.models.thinkingExternalHint}
        options={segmentOptions({ setEffortLevel, setThinkingEnabled, effortLevel: 'high' })}
      />,
    );
    const buttons = view.getAllByRole('button');
    expect(buttons).toHaveLength(5);
    for (const button of buttons) {
      expect((button as HTMLButtonElement).disabled).toBe(false);
      expect(button.hasAttribute('disabled')).toBe(false);
    }
    const selected = view.getByRole('button', { name: zh.settings.model.models.thinkingOptionHigh });
    expect(selected.className).toContain('font-medium');
    expect(selected.className).toContain('ring-zinc-600/70');
    expect(selected.getAttribute('title')).toBe(`${zh.settings.model.models.thinkingSectionLabel}: ${zh.settings.model.models.thinkingOptionHigh}`);
    expect(view.container.querySelector('[data-native-reasoning-segment]')).toBeTruthy();
    expect(view.queryByText(zh.settings.model.models.thinkingExternalHint)).toBeNull();

    fireEvent.click(view.getByRole('button', { name: zh.settings.model.models.thinkingOptionLow }));
    expect(setThinkingEnabled).toHaveBeenCalledWith(true);
    expect(setEffortLevel).toHaveBeenCalledWith('low');

    fireEvent.click(view.getByRole('button', { name: zh.settings.model.models.thinkingOptionOff }));
    expect(setThinkingEnabled).toHaveBeenCalledWith(false);
  });

  it('hides the native segment when the settings prompt is up or only one effort option exists', () => {
    expect(getReasoningSegmentMode({
      engineKind: 'native',
      showModelSettingsPrompt: true,
      effortOptionCount: 3,
    })).toBe('hidden');
    expect(getReasoningSegmentMode({
      engineKind: 'native',
      showModelSettingsPrompt: false,
      effortOptionCount: 1,
    })).toBe('hidden');
    const view = render(
      <ReasoningSegment
        mode="hidden"
        sectionLabel={zh.settings.model.models.thinkingSectionLabel}
        note={zh.settings.model.models.thinkingExternalHint}
        options={[]}
      />,
    );
    expect(view.container.querySelector('[data-native-reasoning-segment]')).toBeNull();
    expect(view.queryAllByRole('button')).toHaveLength(0);
  });

  it('keeps Effort in the native trigger tooltip', () => {
    expect(formatNativeModelSwitcherTooltip({
      engineLabel: 'Neo',
      currentModel: 'mimo-v2.5-pro',
      displayProvider: 'xiaomi',
      displayModel: 'mimo-v2.5-pro',
      adaptive: false,
      overridden: false,
      effort: { label: 'High' },
    })).toContain('Effort:');
  });
});
