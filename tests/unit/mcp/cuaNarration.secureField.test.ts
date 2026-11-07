// N-CUA-SCREEN-GUARDS-SENSITIVE-PROBE-FU2：ADR-088 一期窗口级信号的单测（cuaNarration 公开入口）。
// 判据：secure 标记按「目标窗口最新完整快照」维护——索引行与未索引行都算（0.14.2
// format_node_line 只给带 AX action 的节点编号）；query 过滤 / 截断快照缺字段不构成
// 反证，不得把既有 true 翻成 false；完整快照无 secure 行才能翻回 false；无快照返回 null
// （无信号不升格，规格 §9）。
import { beforeEach, describe, expect, it } from 'vitest';
import {
  readCuaWindowSecureField,
  recordCuaResult,
  resetCuaNarrationCacheForTest,
} from '../../../src/host/mcp/cuaNarration';

const PID = 4321;
const WIN = 7;

function recordWindow(windowId: number, rows: string[], args: Record<string, unknown> = {}): void {
  const output = [`window_id=${windowId} pid=${PID} size=430x222 elements=${rows.length}`, '', ...rows].join('\n');
  recordCuaResult('get_window_state', { pid: PID, window_id: windowId, ...args }, output);
}

describe('cuaNarration window-level secure field signal', () => {
  beforeEach(() => {
    resetCuaNarrationCacheForTest();
  });

  it('no snapshot at all → null (no signal, never escalates)', () => {
    expect(readCuaWindowSecureField({ pid: PID, window_id: WIN })).toBeNull();
    expect(readCuaWindowSecureField({ pid: PID })).toBeNull();
  });

  it('a snapshot with an indexed AXSecureTextField row → secure true with its label', () => {
    recordWindow(WIN, ['- [0] AXWindow "Login"', '  - [3] AXSecureTextField "Password"']);
    expect(readCuaWindowSecureField({ pid: PID, window_id: WIN })).toEqual({ secure: true, label: 'Password' });
  });

  it('an un-indexed AXSecureTextField row (absent from the element cache) is still detected', () => {
    recordWindow(WIN, ['- [0] AXWindow "Login"', '  - AXSecureTextField "密码"', '  - [7] AXButton "Sign in" [actions=[press]]']);
    expect(readCuaWindowSecureField({ pid: PID, window_id: WIN })).toEqual({ secure: true, label: '密码' });
  });

  it('parenthesised labels and label-less secure rows both work', () => {
    recordWindow(WIN, ['  - AXSecureTextField (Password)']);
    expect(readCuaWindowSecureField({ pid: PID, window_id: WIN })).toEqual({ secure: true, label: 'Password' });
    resetCuaNarrationCacheForTest();
    recordWindow(WIN, ['  - [2] AXSecureTextField']);
    expect(readCuaWindowSecureField({ pid: PID, window_id: WIN })).toEqual({ secure: true });
  });

  it('a snapshot without secure fields → secure false; a later complete snapshot flips true back to false', () => {
    recordWindow(WIN, ['  - [2] AXTextField "Query"']);
    expect(readCuaWindowSecureField({ pid: PID, window_id: WIN })).toEqual({ secure: false });
    recordWindow(WIN, ['  - [3] AXSecureTextField "Password"']);
    expect(readCuaWindowSecureField({ pid: PID, window_id: WIN })).toEqual({ secure: true, label: 'Password' });
    // 登录完成：同窗口完整快照不再有 secure 行 → 最新快照说了算
    recordWindow(WIN, ['  - [2] AXTextField "Search"']);
    expect(readCuaWindowSecureField({ pid: PID, window_id: WIN })).toEqual({ secure: false });
  });

  it('a query-filtered snapshot never flips an existing true to false', () => {
    recordWindow(WIN, ['  - [3] AXSecureTextField "Password"']);
    recordWindow(WIN, ['  - [7] AXButton "Sign in" [actions=[press]]'], { query: 'Sign in' });
    expect(readCuaWindowSecureField({ pid: PID, window_id: WIN })).toEqual({ secure: true, label: 'Password' });
  });

  it('a truncated snapshot never flips an existing true to false', () => {
    recordWindow(WIN, ['  - [3] AXSecureTextField "Password"']);
    recordCuaResult(
      'get_window_state',
      { pid: PID, window_id: WIN },
      `window_id=${WIN} pid=${PID}\n- [7] AXButton "Pay now"\n\n[Output truncated: exceeded size limit. Use more specific queries to reduce output.]`,
    );
    expect(readCuaWindowSecureField({ pid: PID, window_id: WIN })).toEqual({ secure: true, label: 'Password' });
  });

  it('pid-only lookup checks every cached window of that pid; window-only lookup scans window ids', () => {
    recordWindow(21, ['  - [3] AXSecureTextField "Password"']);
    recordWindow(22, ['  - [2] AXTextField "Email"']);
    // 只带 pid：任一窗口 secure 即命中（type_text 允许省 window_id）
    expect(readCuaWindowSecureField({ pid: PID })).toEqual({ secure: true, label: 'Password' });
    // 精确窗口优先于 pid 级命中：目标窗口正常就不交回（目标窗口为界）
    expect(readCuaWindowSecureField({ pid: PID, window_id: 22 })).toEqual({ secure: false });
    // 只带 window_id：按窗口号反扫
    expect(readCuaWindowSecureField({ window_id: 21 })).toEqual({ secure: true, label: 'Password' });
    expect(readCuaWindowSecureField({ window_id: 22 })).toEqual({ secure: false });
  });

  it('JSON tree_markdown output is scanned the same as raw text output', () => {
    const output = JSON.stringify({
      window_id: WIN,
      pid: PID,
      tree_markdown: '- [0] AXWindow "Login"\n  - AXSecureTextField "Password"',
    });
    recordCuaResult('get_window_state', { pid: PID, window_id: WIN }, output);
    expect(readCuaWindowSecureField({ pid: PID, window_id: WIN })).toEqual({ secure: true, label: 'Password' });
  });
});
