import { describe, expect, it, afterEach } from 'vitest';
import type { ComputerAction } from '../../../../src/host/tools/vision/computerUse';
import { attachForegroundKeystrokeWarning } from '../../../../src/host/tools/vision/computerUse';
import {
  setMultiAgentMode,
  resetMultiAgentModeForTests,
} from '../../../../src/host/services/multiAgentMode';

const okResult = { success: true, output: 'done' };

function makeAction(overrides: Partial<ComputerAction>): ComputerAction {
  return { action: 'type', text: 'hi', ...overrides } as ComputerAction;
}

describe('attachForegroundKeystrokeWarning', () => {
  it('warns when type runs in foreground without targetApp', () => {
    const out = attachForegroundKeystrokeWarning(okResult, makeAction({ action: 'type' }), null);
    expect(out.metadata?.foregroundFallbackWarning).toMatch(/frontmost/i);
  });

  it('warns when key runs in foreground', () => {
    const out = attachForegroundKeystrokeWarning(
      okResult,
      makeAction({ action: 'key', key: 'n', modifiers: ['cmd'] }),
      null,
    );
    expect(out.metadata?.foregroundFallbackWarning).toBeTruthy();
  });

  it('does NOT warn when type ran via background_ax', () => {
    const out = attachForegroundKeystrokeWarning(okResult, makeAction({ action: 'type' }), 'background_ax');
    expect(out.metadata?.foregroundFallbackWarning).toBeUndefined();
  });

  it('does NOT warn for non-keystroke actions like click', () => {
    const out = attachForegroundKeystrokeWarning(okResult, makeAction({ action: 'click', x: 10, y: 10 }), null);
    expect(out.metadata?.foregroundFallbackWarning).toBeUndefined();
  });

  it('does NOT warn when the action failed (avoid noise on errors)', () => {
    const failed = { success: false, error: 'permission denied' };
    const out = attachForegroundKeystrokeWarning(failed, makeAction({ action: 'type' }), null);
    expect(out.metadata?.foregroundFallbackWarning).toBeUndefined();
  });

  it('preserves existing metadata fields', () => {
    const result = { success: true, output: 'ok', metadata: { traceId: 'abc' } };
    const out = attachForegroundKeystrokeWarning(result, makeAction({ action: 'type' }), null);
    expect(out.metadata?.traceId).toBe('abc');
    expect(out.metadata?.foregroundFallbackWarning).toBeTruthy();
  });

  describe('multi-agent mode escalation', () => {
    afterEach(() => {
      resetMultiAgentModeForTests();
    });

    it('escalates the warning text and tags metadata.multiAgentMode=true when enabled', () => {
      setMultiAgentMode(true);
      const out = attachForegroundKeystrokeWarning(okResult, makeAction({ action: 'type' }), null);
      expect(out.metadata?.foregroundFallbackWarning).toMatch(/MULTI-AGENT MODE/);
      expect(out.metadata?.foregroundFallbackWarning).toMatch(/MUST re-run with targetApp/i);
      expect(out.metadata?.multiAgentMode).toBe(true);
    });

    it('uses the regular warning text and multiAgentMode=false when disabled', () => {
      setMultiAgentMode(false);
      const out = attachForegroundKeystrokeWarning(okResult, makeAction({ action: 'type' }), null);
      expect(out.metadata?.foregroundFallbackWarning).not.toMatch(/MULTI-AGENT MODE/);
      expect(out.metadata?.multiAgentMode).toBe(false);
    });
  });
});
