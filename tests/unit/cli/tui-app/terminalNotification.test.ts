// ============================================================================
// tui-app/terminalNotification.ts — OSC 9/BEL 终端通知 + 焦点门控 单测
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  buildTerminalNotification,
  buildTerminalTitleSequence,
  classifyStrippedCsi,
  formatTerminalTitle,
  isFocusEventInput,
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

describe('formatTerminalTitle', () => {
  it('运行中用活动标签，空闲 neo，有队列才带 queued', () => {
    expect(formatTerminalTitle({ running: true, activity: 'Thinking…', queued: 0 })).toBe('Thinking… · neo');
    expect(formatTerminalTitle({ running: false, activity: null, queued: 0 })).toBe('neo');
    expect(formatTerminalTitle({ running: false, activity: null, queued: 2 })).toBe('neo · 2 queued');
  });

  it('OSC 0 标题序列', () => {
    expect(buildTerminalTitleSequence('Thinking… · neo')).toBe('\x1b]0;Thinking… · neo\x07');
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

describe('isFocusEventInput（Ink 剥 ESC 后的焦点事件残片过滤）', () => {
  it("整段 '[I'/'[O' 判定为焦点事件残片", () => {
    expect(isFocusEventInput('[I')).toBe(true);
    expect(isFocusEventInput('[O')).toBe(true);
  });

  it('普通输入不误伤：单字符、含残片前缀的正常文本、带 ESC 原文', () => {
    expect(isFocusEventInput('[')).toBe(false);
    expect(isFocusEventInput('I')).toBe(false);
    expect(isFocusEventInput('[Info] 日志')).toBe(false);
    expect(isFocusEventInput('\x1b[I')).toBe(false); // 带 ESC 原文不在这里拦（stdin 监听侧处理）
    expect(isFocusEventInput('')).toBe(false);
  });
});

describe('classifyStrippedCsi（Ink 剥 ESC 后的 Shift+Enter / CSI 残片）', () => {
  it('modifyOtherKeys / CSI-u 的 Shift+Enter 识别为换行', () => {
    expect(classifyStrippedCsi('[27;2;13~')).toBe('shift-enter');
    expect(classifyStrippedCsi('[27;2;10~')).toBe('shift-enter');
    expect(classifyStrippedCsi('\x1b[27;2;13~')).toBe('shift-enter');
    expect(classifyStrippedCsi('[13;2u')).toBe('shift-enter');
    expect(classifyStrippedCsi('[10;2u')).toBe('shift-enter');
    expect(classifyStrippedCsi('[27;4;13~')).toBe('shift-enter');
  });

  it('其它 CSI 残片丢弃，不进草稿', () => {
    expect(classifyStrippedCsi('[27;5;13~')).toBe('drop');
    expect(classifyStrippedCsi('[15~')).toBe('drop');
    expect(classifyStrippedCsi('[<32;1;1M')).toBe('drop');
    expect(classifyStrippedCsi('[13;5u')).toBe('drop');
  });

  it('普通输入和粘贴标记不误伤', () => {
    expect(classifyStrippedCsi('hello')).toBeNull();
    expect(classifyStrippedCsi('[')).toBeNull();
    expect(classifyStrippedCsi('1111')).toBeNull();
    expect(classifyStrippedCsi('[200~')).toBeNull();
    expect(classifyStrippedCsi('[201~')).toBeNull();
    expect(classifyStrippedCsi('[I')).toBeNull();
    expect(classifyStrippedCsi('[Info] 日志')).toBeNull();
  });
});
