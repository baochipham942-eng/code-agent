// ============================================================================
// TUIScreen — alternate screen, status bar, input line, output routing
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TUIScreen } from '../../../../src/cli/tui/screen';

const ESC = '\x1b';
const CSI = `${ESC}[`;
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

describe('TUIScreen', () => {
  let writes: string[];
  let screen: TUIScreen;
  let originalRows: number | undefined;
  let originalCols: number | undefined;

  beforeEach(() => {
    writes = [];
    screen = new TUIScreen();
    screen.setRawWrite((data) => {
      writes.push(data);
    });
    originalRows = process.stdout.rows;
    originalCols = process.stdout.columns;
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });

  afterEach(() => {
    if (screen.isActive) screen.leave();
    Object.defineProperty(process.stdout, 'rows', {
      value: originalRows,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'columns', {
      value: originalCols,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  function joined(): string {
    return writes.join('');
  }

  it('enter enables alt screen, scroll region, and fixed bars; leave tears them down', () => {
    expect(screen.isActive).toBe(false);
    screen.enter();
    expect(screen.isActive).toBe(true);

    const out = joined();
    expect(out).toContain(`${CSI}?1049h`); // alt screen enter
    expect(out).toContain(`${CSI}2J`); // clear
    expect(out).toContain(`${CSI}1;22r`); // scroll region rows-2 = 22
    expect(out).toContain(`${ESC}7`); // DEC save for output cursor

    writes.length = 0;
    screen.leave();
    expect(screen.isActive).toBe(false);
    const leave = joined();
    expect(leave).toContain(`${CSI}r`); // reset scroll
    expect(leave).toContain(`${CSI}?25h`); // show cursor
    expect(leave).toContain(`${CSI}?1049l`); // alt screen leave
  });

  it('enter is idempotent (second call does not re-write alt screen)', () => {
    screen.enter();
    const firstLen = writes.length;
    screen.enter();
    expect(writes.length).toBe(firstLen);
  });

  it('writeOutput uses DEC restore/save when active; passthrough when inactive', () => {
    // inactive passthrough
    screen.writeOutput('plain');
    expect(joined()).toBe('plain');

    writes.length = 0;
    screen.enter();
    writes.length = 0;
    screen.writeOutput('hello');
    const out = joined();
    expect(out.startsWith(`${ESC}8`)).toBe(true); // restore DEC
    expect(out).toContain('hello');
    expect(out.endsWith(`${ESC}7`)).toBe(true); // save DEC
  });

  it('writeLine appends newline in scroll region', () => {
    screen.enter();
    writes.length = 0;
    screen.writeLine('line');
    expect(joined()).toContain('line\n');
  });

  it('updateStatus renders phase, model/provider, duration, tokens, cost, turns, tools, branch', () => {
    screen.enter();
    writes.length = 0;
    screen.updateStatus({
      phase: 'thinking',
      model: 'kimi-k2.5',
      provider: 'moonshot',
      duration: 1500,
      inputTokens: 1200,
      outputTokens: 800,
      contextPercent: 75,
      cost: 0.0123,
      turns: 3,
      toolCount: 2,
      gitBranch: 'main',
    });

    const out = joined();
    // strip ANSI for content checks (chalk colors wrap segments)
    const plain = stripAnsi(out);
    expect(plain).toContain('thinking');
    expect(plain).toContain('moonshot/kimi-k2.5');
    expect(plain).toContain('1.5s');
    expect(plain).toContain('2.0k tokens');
    expect(plain).toContain('ctx');
    expect(plain).toContain('75%');
    expect(plain).toContain('$0.012');
    expect(plain).toContain('3 turns');
    expect(plain).toContain('2 tools');
    expect(plain).toContain('git:(main)');
    // status bar uses SCO save/restore + move to rows-1
    expect(out).toContain(`${CSI}s`);
    expect(out).toContain(`${CSI}23;1H`);
  });

  it('duration formatting covers ms / s / m thresholds', () => {
    screen.enter();

    writes.length = 0;
    screen.updateStatus({ duration: 42 });
    expect(stripAnsi(joined())).toContain('42ms');

    writes.length = 0;
    screen.updateStatus({ duration: 65000 });
    expect(stripAnsi(joined())).toContain('1m5s');
  });

  it('running phase label differs from thinking', () => {
    screen.enter();
    writes.length = 0;
    screen.updateStatus({ phase: 'running' });
    expect(stripAnsi(joined())).toContain('running');
    expect(stripAnsi(joined())).not.toContain('thinking');
  });

  it('setInput/getInput/clearInput manage buffer; active mode re-renders input row', () => {
    expect(screen.getInput()).toBe('');
    screen.setInput('hello', 2);
    expect(screen.getInput()).toBe('hello');
    // inactive: no render
    expect(joined()).toBe('');

    screen.enter();
    writes.length = 0;
    screen.setInput('world', 5);
    const out = joined();
    expect(out).toContain('world');
    expect(out).toContain(`${CSI}24;1H`); // input row
    expect(out).toContain(`${CSI}?25h`); // show cursor via focusInput

    screen.clearInput();
    expect(screen.getInput()).toBe('');
  });

  it('focusInput positions cursor after prefix + input cursor', () => {
    screen.enter();
    writes.length = 0;
    // prefix len = 2 ("❯ "), cursor at 3 → col = 2+3+1 = 6
    screen.setInput('abcdef', 3);
    // setInput already calls focusInput; check last move includes col 6
    expect(joined()).toContain(`${CSI}24;6H`);
  });

  it('long input is truncated with ellipsis in display', () => {
    screen.enter();
    // cols=80, prefix=2, maxInputWidth=77; make much longer
    const long = 'x'.repeat(120);
    writes.length = 0;
    screen.setInput(long, 120);
    const plain = stripAnsi(joined());
    expect(plain).toContain('…');
    expect(plain).not.toContain(long); // full raw string not written as-is
  });
});
