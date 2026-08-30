// ============================================================================
// tui-app/terminalNotification.ts — OSC 9/BEL 终端通知 + 焦点门控 单测
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  buildTerminalNotification,
  parseFocusEvent,
  shouldTerminalNotify,
} from '../../../../src/cli/tui-app/terminalNotification';

describe('shouldTerminalNotify（对齐桌面 shouldSuppressOsNotification 失焦语义）', () => {
  it('聚焦抑制，失焦才发', () => {
    expect(shouldTerminalNotify(true)).toBe(false);
    expect(shouldTerminalNotify(false)).toBe(true);
  });
});

describe('buildTerminalNotification', () => {
  it('OSC 9 终端产出通知序列', () => {
    expect(buildTerminalNotification('Turn 完成', { TERM_PROGRAM: 'iTerm.app' }))
      .toBe('\x1b]9;Turn 完成\x07');
  });

  it('不支持 OSC 9 时回退 BEL', () => {
    expect(buildTerminalNotification('Turn 完成', { TERM_PROGRAM: 'Apple_Terminal' })).toBe('\x07');
  });

  it('NEO_DISABLE_TERMINAL_NOTIFY=1 逃生门', () => {
    expect(buildTerminalNotification('x', { TERM_PROGRAM: 'iTerm.app', NEO_DISABLE_TERMINAL_NOTIFY: '1' })).toBe('');
  });

  it('控制字符剥离（防 OSC 注入），空消息不发', () => {
    expect(buildTerminalNotification('a\x07b\x1bc', { TERM_PROGRAM: 'iTerm.app' }))
      .toBe('\x1b]9;a b c\x07');
    expect(buildTerminalNotification('  \n ', { TERM_PROGRAM: 'iTerm.app' })).toBe('');
  });

  it('超长消息截断到 120 字符', () => {
    const seq = buildTerminalNotification('x'.repeat(200), { TERM_PROGRAM: 'iTerm.app' });
    expect(seq).toBe(`\x1b]9;${'x'.repeat(120)}\x07`);
  });
});

describe('parseFocusEvent', () => {
  it('识别 focus in/out 序列', () => {
    expect(parseFocusEvent('\x1b[I')).toBe('in');
    expect(parseFocusEvent('\x1b[O')).toBe('out');
    expect(parseFocusEvent('prefix\x1b[I')).toBe('in');
    expect(parseFocusEvent('a')).toBeNull();
  });
});
