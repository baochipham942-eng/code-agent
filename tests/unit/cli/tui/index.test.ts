// ============================================================================
// TUI index — patchStdout routing + createTUI assembly
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTUI, patchStdout, TUIScreen } from '../../../../src/cli/tui/index';

describe('patchStdout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes console.log/warn and stdout.write through scroll region when active', () => {
    const screen = new TUIScreen();
    // Force active without full enter() (avoids resize listener / alt screen noise)
    (screen as unknown as { active: boolean; rows: number; cols: number }).active = true;
    (screen as unknown as { rows: number }).rows = 24;
    (screen as unknown as { cols: number }).cols = 80;

    // patchStdout overwrites setRawWrite with process.stdout.write at patch time —
    // so capture must happen via spy BEFORE patch.
    const raw: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      raw.push(typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const unpatch = patchStdout(screen);

    try {
      raw.length = 0;
      console.log('hello', { a: 1 });
      const logOut = raw.join('');
      expect(logOut).toContain('hello');
      expect(logOut).toContain('{"a":1}');
      expect(logOut).toContain('\n');

      raw.length = 0;
      console.warn('careful');
      expect(raw.join('')).toContain('careful');

      raw.length = 0;
      process.stdout.write('chunk-out');
      expect(raw.join('')).toContain('chunk-out');

      raw.length = 0;
      process.stdout.write(Buffer.from('buf'));
      expect(raw.join('')).toContain('buf');
    } finally {
      unpatch();
      spy.mockRestore();
    }
  });

  it('falls through to original console/stdout when screen is inactive', () => {
    const screen = new TUIScreen();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };

    const unpatch = patchStdout(screen);
    try {
      expect(screen.isActive).toBe(false);
      console.log('passthrough');
      expect(logs).toContain('passthrough');
    } finally {
      unpatch();
      console.log = origLog;
    }
  });
});

describe('createTUI', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns screen, input manager, and unpatch that swaps stdout.write back', () => {
    const { screen, input, unpatch } = createTUI();

    expect(screen).toBeInstanceOf(TUIScreen);
    expect(typeof input.start).toBe('function');
    expect(typeof input.stop).toBe('function');

    const writeWhilePatched = process.stdout.write;
    unpatch();
    // unpatch restores the bound original captured at patch time — reference must change
    expect(process.stdout.write).not.toBe(writeWhilePatched);
  });
});
