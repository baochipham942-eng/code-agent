// ============================================================================
// InputManager — raw-mode key handling, history, paste-submit
// ============================================================================
// 不改 src 前提下通过 mock screen + 注入 stdin 'data' 覆盖行为边界。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { InputManager } from '../../../../src/cli/tui/inputManager';
import type { TUIScreen } from '../../../../src/cli/tui/screen';

type FakeStdin = EventEmitter & {
  isTTY: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
};

function createMockScreen(): TUIScreen & {
  setInput: ReturnType<typeof vi.fn>;
  clearInput: ReturnType<typeof vi.fn>;
} {
  return {
    setInput: vi.fn(),
    clearInput: vi.fn(),
  } as unknown as TUIScreen & {
    setInput: ReturnType<typeof vi.fn>;
    clearInput: ReturnType<typeof vi.fn>;
  };
}

function installFakeStdin(isTTY = true): FakeStdin {
  const stdin = new EventEmitter() as FakeStdin;
  stdin.isTTY = isTTY;
  stdin.setRawMode = vi.fn();
  stdin.resume = vi.fn();
  Object.defineProperty(process, 'stdin', {
    value: stdin,
    configurable: true,
    writable: true,
  });
  return stdin;
}

function key(stdin: FakeStdin, text: string): void {
  stdin.emit('data', Buffer.from(text, 'utf-8'));
}

describe('InputManager', () => {
  let originalStdin: NodeJS.ReadStream;
  let stdin: FakeStdin;
  let screen: ReturnType<typeof createMockScreen>;
  let input: InputManager;
  let onSubmit: ReturnType<typeof vi.fn>;
  let onCancel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalStdin = process.stdin;
    stdin = installFakeStdin(true);
    screen = createMockScreen();
    input = new InputManager(screen);
    onSubmit = vi.fn();
    onCancel = vi.fn();
  });

  afterEach(() => {
    try {
      input.stop();
    } catch {
      /* already stopped */
    }
    Object.defineProperty(process, 'stdin', {
      value: originalStdin,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it('start enables raw mode on TTY and resets input line', () => {
    input.start(onSubmit, onCancel);
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(stdin.resume).toHaveBeenCalled();
    expect(screen.setInput).toHaveBeenCalledWith('', 0);
  });

  it('start skips setRawMode when stdin is not a TTY', () => {
    stdin = installFakeStdin(false);
    input = new InputManager(screen);
    input.start(onSubmit, onCancel);
    expect(stdin.setRawMode).not.toHaveBeenCalled();
    expect(stdin.resume).toHaveBeenCalled();
  });

  it('inserts printable characters and submits trimmed buffer on Enter', () => {
    input.start(onSubmit, onCancel);
    key(stdin, 'h');
    key(stdin, 'i');
    expect(screen.setInput).toHaveBeenLastCalledWith('hi', 2);

    key(stdin, '\r');
    expect(onSubmit).toHaveBeenCalledWith('hi');
    expect(screen.clearInput).toHaveBeenCalled();
  });

  it('does not submit blank or whitespace-only lines', () => {
    input.start(onSubmit, onCancel);
    key(stdin, '   ');
    key(stdin, '\r');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('paste with newlines submits each non-empty line (multi-line paste fix)', () => {
    input.start(onSubmit, onCancel);
    key(stdin, 'first\nsecond\n');
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenNthCalledWith(1, 'first');
    expect(onSubmit).toHaveBeenNthCalledWith(2, 'second');
  });

  it('paste with CRLF also splits into per-line submits', () => {
    input.start(onSubmit, onCancel);
    key(stdin, 'a\r\nb');
    expect(onSubmit).toHaveBeenCalledWith('a');
    // trailing fragment without newline stays in buffer (via setInput)
    expect(screen.setInput).toHaveBeenCalledWith('b', 1);
  });

  it('backspace deletes character before cursor', () => {
    input.start(onSubmit, onCancel);
    key(stdin, 'ab');
    key(stdin, '\x7f'); // backspace
    expect(screen.setInput).toHaveBeenLastCalledWith('a', 1);
  });

  it('left/right arrows move cursor without changing text', () => {
    input.start(onSubmit, onCancel);
    key(stdin, 'xy');
    key(stdin, '\x1b[D'); // left
    expect(screen.setInput).toHaveBeenLastCalledWith('xy', 1);
    key(stdin, '\x1b[C'); // right
    expect(screen.setInput).toHaveBeenLastCalledWith('xy', 2);
  });

  it('Home/Ctrl+A and End/Ctrl+E jump to ends', () => {
    input.start(onSubmit, onCancel);
    key(stdin, 'abc');
    key(stdin, '\x01'); // Ctrl+A
    expect(screen.setInput).toHaveBeenLastCalledWith('abc', 0);
    key(stdin, '\x05'); // Ctrl+E
    expect(screen.setInput).toHaveBeenLastCalledWith('abc', 3);
  });

  it('Delete key removes character under cursor', () => {
    input.start(onSubmit, onCancel);
    key(stdin, 'abc');
    key(stdin, '\x01'); // home
    key(stdin, '\x1b[3~'); // delete
    expect(screen.setInput).toHaveBeenLastCalledWith('bc', 0);
  });

  it('Ctrl+U clears the line; Ctrl+W deletes previous word', () => {
    input.start(onSubmit, onCancel);
    key(stdin, 'hello world');
    key(stdin, '\x17'); // Ctrl+W
    expect(screen.setInput).toHaveBeenLastCalledWith('hello ', 6);
    key(stdin, '\x15'); // Ctrl+U
    expect(screen.setInput).toHaveBeenLastCalledWith('', 0);
  });

  it('history Up/Down recalls submitted lines and restores draft', () => {
    input.start(onSubmit, onCancel);
    key(stdin, 'one');
    key(stdin, '\r');
    key(stdin, 'two');
    key(stdin, '\r');

    // draft then browse history
    key(stdin, 'draft');
    key(stdin, '\x1b[A'); // up → two
    expect(screen.setInput).toHaveBeenLastCalledWith('two', 3);
    key(stdin, '\x1b[A'); // up → one
    expect(screen.setInput).toHaveBeenLastCalledWith('one', 3);
    key(stdin, '\x1b[B'); // down → two
    expect(screen.setInput).toHaveBeenLastCalledWith('two', 3);
    key(stdin, '\x1b[B'); // down → restore draft
    expect(screen.setInput).toHaveBeenLastCalledWith('draft', 5);
  });

  it('Ctrl+C always cancels; ESC cancels only while paused (agent running)', () => {
    input.start(onSubmit, onCancel);

    // ESC while active is ignored (not a cancel)
    key(stdin, '\x1b');
    expect(onCancel).not.toHaveBeenCalled();

    // Ctrl+C always cancels
    key(stdin, '\x03');
    expect(onCancel).toHaveBeenCalledTimes(1);

    // ESC while paused (agent running) cancels
    input.pause();
    key(stdin, '\x1b');
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('Ctrl+D on empty active buffer cancels; non-empty ignores it', () => {
    input.start(onSubmit, onCancel);
    key(stdin, 'x');
    key(stdin, '\x04');
    expect(onCancel).not.toHaveBeenCalled();

    key(stdin, '\x15'); // clear
    key(stdin, '\x04');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('pause drops regular input; resume clears buffer for next turn', () => {
    input.start(onSubmit, onCancel);
    input.pause();
    key(stdin, 'z');
    // setInput after start only — no insert while paused
    const callsAfterPause = screen.setInput.mock.calls.length;
    key(stdin, 'more');
    expect(screen.setInput.mock.calls.length).toBe(callsAfterPause);

    input.resume();
    expect(screen.setInput).toHaveBeenLastCalledWith('', 0);
    key(stdin, 'a');
    expect(screen.setInput).toHaveBeenLastCalledWith('a', 1);
  });

  it('stop removes data listener and disables raw mode', () => {
    input.start(onSubmit, onCancel);
    input.stop();
    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
    key(stdin, 'x');
    // after stop, no further setInput from typing
    const afterStop = screen.setInput.mock.calls.length;
    key(stdin, 'y');
    expect(screen.setInput.mock.calls.length).toBe(afterStop);
  });

  it('filters non-printable ASCII on insert (control chars stripped)', () => {
    input.start(onSubmit, onCancel);
    // multi-byte paste without ESC prefix goes through insertText path for each part
    key(stdin, 'a\x00b\x01c');
    // \x00 and \x01 have code <= 31 → stripped; only abc printable parts remain
    // actually: multi-byte without \x1b is paste path; whole string is one paste without newlines
    expect(screen.setInput).toHaveBeenLastCalledWith('abc', 3);
  });
});
