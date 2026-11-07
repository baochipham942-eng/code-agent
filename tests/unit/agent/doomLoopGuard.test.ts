import { describe, it, expect } from 'vitest';
import {
  DoomLoopGuard,
  stableStringify,
  collectGuardStepResults,
  DOOM_LOOP_THRESHOLD,
  REPEATED_STEP_THRESHOLD,
  EMPTY_OUTPUT_CONTINUATION_LIMIT,
} from '../../../src/host/agent/runtime/doomLoopGuard';

const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });

describe('stableStringify', () => {
  it('sorts object keys so key order does not change the signature', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it('handles nested objects and arrays', () => {
    expect(stableStringify({ x: [{ b: 1, a: 2 }] })).toBe(stableStringify({ x: [{ a: 2, b: 1 }] }));
  });

  it('distinguishes different values', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });

  it('handles null and primitives', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify('s')).toBe('"s"');
  });
});

describe('DoomLoopGuard L1 — 同名同参连续重复', () => {
  it('stays silent below the threshold', () => {
    const guard = new DoomLoopGuard();
    expect(guard.recordStep([call('Read', { path: 'a.ts' })]).level).toBe('none');
    expect(guard.recordStep([call('Read', { path: 'a.ts' })]).level).toBe('none');
  });

  it('flags doom-loop at 3 consecutive identical calls', () => {
    const guard = new DoomLoopGuard();
    guard.recordStep([call('Read', { path: 'a.ts' })]);
    guard.recordStep([call('Read', { path: 'a.ts' })]);
    const check = guard.recordStep([call('Read', { path: 'a.ts' })]);
    expect(check.level).toBe('doom-loop');
    expect(check.nudge).toContain('<doom-loop-guard>');
  });

  it('ignores key order differences in arguments (stableStringify)', () => {
    const guard = new DoomLoopGuard();
    guard.recordStep([call('Grep', { pattern: 'x', path: 'src' })]);
    guard.recordStep([call('Grep', { path: 'src', pattern: 'x' })]);
    const check = guard.recordStep([call('Grep', { pattern: 'x', path: 'src' })]);
    expect(check.level).toBe('doom-loop');
  });

  it('escalates to abort when the loop continues after the doom-loop nudge', () => {
    const guard = new DoomLoopGuard();
    guard.recordStep([call('Read', { path: 'a.ts' })]);
    guard.recordStep([call('Read', { path: 'a.ts' })]);
    guard.recordStep([call('Read', { path: 'a.ts' })]); // doom-loop nudge
    const check = guard.recordStep([call('Read', { path: 'a.ts' })]);
    expect(check.level).toBe('doom-loop-abort');
  });

  it('换方法后连击从 1 重数，下一次相同调用不会立刻再中止', () => {
    const guard = new DoomLoopGuard();
    const again = () => guard.recordStep([call('Read', { path: 'a.ts' })]);
    again();
    again();
    again();
    expect(again().level).toBe('doom-loop-abort');
    guard.resetAfterHandback();
    expect(again().level).toBe('none');
    expect(again().level).toBe('none');
    expect(again().level).toBe('doom-loop');
  });

  it('resets the streak when a different call appears', () => {
    const guard = new DoomLoopGuard();
    guard.recordStep([call('Read', { path: 'a.ts' })]);
    guard.recordStep([call('Read', { path: 'a.ts' })]);
    guard.recordStep([call('Read', { path: 'b.ts' })]);
    const check = guard.recordStep([call('Read', { path: 'a.ts' })]);
    expect(check.level).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// N-FIX-BROWSER-DOOMLOOP-REAPPROVE r1 — 观察类 Browser 调用的 L1 结果确认
// ---------------------------------------------------------------------------
const browserResult = (action: string, summary: string, success = true) => ({
  name: 'Browser',
  arguments: { action },
  success,
  summary,
});

describe('DoomLoopGuard L1 — 观察类 Browser 重复要由结果确认 (N-FIX-BROWSER-DOOMLOOP-REAPPROVE r1)', () => {
  it('(a) 轮询演进页面不再误报：get_content ×4，结果 loading,loading,loading,ready → 全程无 doom-loop', () => {
    const guard = new DoomLoopGuard();
    const read = call('Browser', { action: 'get_content' });
    const levels: string[] = [];
    for (const summary of ['loading', 'loading', 'loading', 'ready']) {
      levels.push(guard.recordStep([read]).level);
      guard.recordResults([browserResult('get_content', summary)]);
    }
    expect(levels).toEqual(['none', 'none', 'none', 'none']);
  });

  it('(b) 真重复仍升级：同参同结果连续读，先 nudge 再 abort（比非观察类多一拍结果确认）', () => {
    const guard = new DoomLoopGuard();
    const read = call('Browser', { action: 'get_content' });
    const page = 'URL: http://127.0.0.1:1/ Title: Fixture --- Page Text --- static page, nothing changes';
    const levels: string[] = [];
    const checks: ReturnType<DoomLoopGuard['recordStep']>[] = [];
    for (let i = 0; i < 6; i++) {
      checks.push(guard.recordStep([read]));
      levels.push(checks[checks.length - 1].level);
      guard.recordResults([browserResult('get_content', page)]);
    }
    expect(levels).toEqual(['none', 'none', 'none', 'none', 'doom-loop', 'doom-loop-abort']);
    expect(checks[4].nudge).toContain('<doom-loop-guard>');
  });

  it('(c) 同坐标 Browser click 重复不受结果折扣：第 3 次 nudge、第 4 次 abort（与改动前一致）', () => {
    const guard = new DoomLoopGuard();
    const clickAt = call('Browser', { action: 'click', selector: '#go' });
    const levels: string[] = [];
    for (let i = 0; i < 4; i++) {
      levels.push(guard.recordStep([clickAt]).level);
      guard.recordResults([browserResult('click', 'Clicked element: #go')]);
    }
    expect(levels).toEqual(['none', 'none', 'doom-loop', 'doom-loop-abort']);
  });

  it('(d) 结果每次都在变（页面持续推进）的同参重复读永不升级', () => {
    const guard = new DoomLoopGuard();
    const read = call('Browser', { action: 'get_content' });
    const levels: string[] = [];
    for (let i = 0; i < 8; i++) {
      levels.push(guard.recordStep([read]).level);
      guard.recordResults([browserResult('get_content', `progress ${i}%`)]);
    }
    expect(levels.every((level) => level === 'none')).toBe(true);
  });

  it('(e) nudge 之后页面演进（结果变化）→ 不 abort，从新观察重数', () => {
    const guard = new DoomLoopGuard();
    const read = call('Browser', { action: 'get_content' });
    const summaries = ['page A', 'page A', 'page A', 'page A', 'page B', 'page B', 'page B', 'page B', 'page B'];
    const levels: string[] = [];
    for (const summary of summaries) {
      levels.push(guard.recordStep([read]).level);
      guard.recordResults([browserResult('get_content', summary)]);
    }
    expect(levels).toEqual(['none', 'none', 'none', 'none', 'doom-loop', 'none', 'none', 'none', 'doom-loop']);
  });

  it('(f) resetAfterHandback 清掉观察确认链：换方法后要重新数满才再 nudge', () => {
    const guard = new DoomLoopGuard();
    const read = call('Browser', { action: 'get_content' });
    const page = 'same page text';
    for (let i = 0; i < 5; i++) {
      guard.recordStep([read]);
      guard.recordResults([browserResult('get_content', page)]);
    }
    guard.resetAfterHandback();
    const levels: string[] = [];
    for (let i = 0; i < 5; i++) {
      levels.push(guard.recordStep([read]).level);
      guard.recordResults([browserResult('get_content', page)]);
    }
    expect(levels).toEqual(['none', 'none', 'none', 'none', 'doom-loop']);
  });
});

// ---------------------------------------------------------------------------
// N-FIX-BROWSER-DOOMLOOP-REAPPROVE r2 — 观察确认链的三种真实写入点形状
// ---------------------------------------------------------------------------
describe('DoomLoopGuard L1 — 观察确认链真实写入点形状 (N-FIX-BROWSER-DOOMLOOP-REAPPROVE r2)', () => {
  it('(g) 真实 screenshot 输出（内嵌 screenshot_<Date.now()>.png 文件名）：反复截屏等一个不会来的变化仍升级', () => {
    const guard = new DoomLoopGuard();
    const shot = call('Browser', { action: 'screenshot' });
    const levels: string[] = [];
    let clock = 1762300000000;
    for (let i = 0; i < 6; i++) {
      clock += 137;
      levels.push(guard.recordStep([shot]).level);
      guard.recordResults([browserResult(
        'screenshot',
        `Screenshot saved: /Users/x/.code-agent-dev/appshots/screenshot_${clock}.png`,
      )]);
    }
    expect(levels).toEqual(['none', 'none', 'none', 'none', 'doom-loop', 'doom-loop-abort']);
  });

  it('(h) 真实 get_dom_snapshot 输出（snapshotId uuid + capturedAtMs 每调用全新，页面内容不变）：仍升级', () => {
    const guard = new DoomLoopGuard();
    const snap = call('Browser', { action: 'get_dom_snapshot' });
    const uuids = [
      '3a84ea57-d086-4157-bf8c-cab73a38bc0b',
      'e9341420-6804-4bb4-c0ee-1c897ed92b2a',
      'f71c0d92-12ab-4c3e-9f56-02d9a8c3b1e7',
      'a55b3f18-77c2-4d1a-8e90-6b2f4c9d3a21',
      'c09d4e77-31f8-4b5c-a7d2-90e3f1b6c8d4',
      'b28e6a35-94d7-4e6f-b0a1-7c8d2e5f9a3b',
    ];
    const levels: string[] = [];
    uuids.forEach((uuid, i) => {
      levels.push(guard.recordStep([snap]).level);
      guard.recordResults([browserResult('get_dom_snapshot', [
        '{',
        `  "snapshotId": "snapshot_${uuid}",`,
        '  "tabId": "tab_739bdeb5-cb76-4508-bfa7-e4ef0468a9c1",',
        `  "capturedAtMs": ${1762300000000 + i * 977},`,
        '  "url": "http://127.0.0.1:57216/delayed",',
        '  "title": "Fixture Delayed",',
        `  "documentRevision": "document_snapshot_${uuid}_5.1",`,
        '  "headings": ["Delayed"]',
        '}',
      ].join('\n'))]);
    });
    expect(levels).toEqual(['none', 'none', 'none', 'none', 'doom-loop', 'doom-loop-abort']);
  });

  it('(i) 交错观察互不清零：B,B,A,B,B,B,B 的 B 确认链跨 A 存活（单槽会被清零拖到第 8 步之后）', () => {
    const guard = new DoomLoopGuard();
    const readMain = call('Browser', { action: 'get_content', tabId: 'tab-1' });
    const readSide = call('Browser', { action: 'get_content', tabId: 'tab-9' });
    const main = 'URL: http://127.0.0.1:1/ Title: T --- Page Text --- static';
    const levels: string[] = [];
    const run = (toolCall: typeof readMain, summary: string) => {
      levels.push(guard.recordStep([toolCall]).level);
      guard.recordResults([{ name: 'Browser', arguments: toolCall.arguments, success: true, summary }]);
    };
    run(readMain, main);
    run(readMain, main);
    run(readSide, 'URL: http://127.0.0.1:9/ Title: O --- other tab');
    for (let i = 0; i < 4; i++) run(readMain, main);
    expect(levels).toEqual(['none', 'none', 'none', 'none', 'none', 'doom-loop', 'doom-loop-abort']);
  });

  it('(j) tab 崩溃后反复失败的观察调用也是空转：同参同错误仍 nudge→abort（r1 里失败不算证据）', () => {
    const guard = new DoomLoopGuard();
    const read = call('Browser', { action: 'get_content' });
    const levels: string[] = [];
    for (let i = 0; i < 6; i++) {
      levels.push(guard.recordStep([read]).level);
      guard.recordResults([browserResult('get_content', 'Target page, context or browser has been closed', false)]);
    }
    expect(levels).toEqual(['none', 'none', 'none', 'none', 'doom-loop', 'doom-loop-abort']);
  });
});

describe('DoomLoopGuard L2 — 行动签名重复', () => {
  it('nudges when the same multi-call step repeats 3 times', () => {
    const guard = new DoomLoopGuard();
    const step = [call('Grep', { pattern: 'a' }), call('Read', { path: 'x.ts' })];
    guard.recordStep(step);
    guard.recordStep(step);
    const check = guard.recordStep(step);
    expect(check.level).not.toBe('none');
    expect(check.nudge).toBeTruthy();
    expect(check.nudge).toContain('repeating');
  });

  it('treats swapped-order parallel calls as the same step (multiset signature, codex audit R1)', () => {
    const guard = new DoomLoopGuard();
    guard.recordStep([call('Grep', { pattern: 'a' }), call('Read', { path: 'x.ts' })]);
    guard.recordStep([call('Read', { path: 'x.ts' }), call('Grep', { pattern: 'a' })]);
    const check = guard.recordStep([call('Grep', { pattern: 'a' }), call('Read', { path: 'x.ts' })]);
    expect(check.level).toBe('repeated-step');
  });

  it('does not nudge for different steps', () => {
    const guard = new DoomLoopGuard();
    guard.recordStep([call('Grep', { pattern: 'a' })]);
    guard.recordStep([call('Grep', { pattern: 'b' })]);
    const check = guard.recordStep([call('Grep', { pattern: 'c' })]);
    expect(check.level).toBe('none');
  });
});

describe('DoomLoopGuard L3 — 空输出自动续接', () => {
  it('continues with a nudge below the limit', () => {
    const guard = new DoomLoopGuard();
    for (let i = 0; i < EMPTY_OUTPUT_CONTINUATION_LIMIT; i++) {
      const r = guard.recordEmptyOutput();
      expect(r.action).toBe('continue');
      expect(r.nudge).toContain('no usable answer');
    }
  });

  it('stops at the limit', () => {
    const guard = new DoomLoopGuard();
    for (let i = 0; i < EMPTY_OUTPUT_CONTINUATION_LIMIT; i++) guard.recordEmptyOutput();
    expect(guard.recordEmptyOutput().action).toBe('stop');
  });
});

describe('thresholds', () => {
  it('match MiMoCode reference values', () => {
    expect(DOOM_LOOP_THRESHOLD).toBe(3);
    expect(REPEATED_STEP_THRESHOLD).toBe(3);
    expect(EMPTY_OUTPUT_CONTINUATION_LIMIT).toBeGreaterThanOrEqual(1);
  });
});

// 等形构造：仓内 "Checkpoint fenced by stale cursor" 是检查点围栏文案，
// 不是后台任务轮询样本。这里把它放进 task_output 的 Status 正文，序号和耗时只改数字。
function staleCursorPoll(seq: number, taskId = 'bg-1', status = 'running', extra = '') {
  return {
    name: 'task_output',
    arguments: { task_id: taskId, timeout: seq },
    success: true,
    summary: [
      `=== Task ${taskId} ===`,
      `Status: ${status}`,
      `Duration: ${seq}s`,
      '--- Output ---',
      'Checkpoint fenced by stale cursor',
      `seq=${seq}`,
      extra,
    ].filter(Boolean).join('\n'),
  };
}

describe('DoomLoopGuard result signals', () => {
  it('polling_repeat hits three identical stale-cursor polls and does not nudge again', () => {
    const guard = new DoomLoopGuard();
    expect(guard.recordResults([staleCursorPoll(1)]).signals).toEqual([]);
    expect(guard.recordResults([staleCursorPoll(2)]).signals).toEqual([]);
    const hit = guard.recordResults([{
      ...staleCursorPoll(3),
      name: 'Process',
      arguments: { action: 'output', session_id: 'bg-1', timeout: 9 },
    }]);
    expect(hit.signals).toEqual(['polling_repeat']);
    expect(hit.nudge).toContain('polling_repeat');
    expect(hit.nudge).toContain('change strategy');
    expect(hit).not.toHaveProperty('level');
    const again = guard.recordResults([staleCursorPoll(4)]);
    expect(again.signals).toEqual([]);
    expect(again.nudge).toBeUndefined();
    guard.resetAfterHandback();
    guard.recordResults([staleCursorPoll(5)]);
    guard.recordResults([staleCursorPoll(6)]);
    expect(guard.recordResults([staleCursorPoll(7)]).nudge).toBeUndefined();
  });

  it('polling_repeat stays quiet when the task id or the status changes, or the body grows', () => {
    const differentTask = new DoomLoopGuard();
    differentTask.recordResults([staleCursorPoll(1)]);
    differentTask.recordResults([staleCursorPoll(2)]);
    expect(differentTask.recordResults([staleCursorPoll(3, 'bg-2')]).signals).toEqual([]);

    const statusChanged = new DoomLoopGuard();
    statusChanged.recordResults([staleCursorPoll(1)]);
    statusChanged.recordResults([staleCursorPoll(2)]);
    expect(statusChanged.recordResults([staleCursorPoll(3, 'bg-1', 'completed')]).signals).toEqual([]);

    const grew = new DoomLoopGuard();
    grew.recordResults([staleCursorPoll(1)]);
    grew.recordResults([staleCursorPoll(2)]);
    expect(grew.recordResults([staleCursorPoll(3, 'bg-1', 'running', 'compiled main module')]).signals).toEqual([]);
  });

  it('same_error_family hits three normalized path errors and ignores a different family', () => {
    const guard = new DoomLoopGuard();
    const failure = (file: string) => ({
      name: 'Read',
      arguments: { path: file },
      success: false,
      summary: `ENOENT: no such file '${file}'`,
    });
    expect(guard.recordResults([failure('/tmp/a.ts')]).signals).toEqual([]);
    expect(guard.recordResults([failure('/var/b.ts')]).signals).toEqual([]);
    const hit = guard.recordResults([failure('/opt/c.ts')]);
    expect(hit.signals).toEqual(['same_error_family']);
    expect(hit.nudge).toContain('same_error_family');
    expect(hit.nudge).toContain('change strategy');
    expect(guard.recordResults([failure('/opt/d.ts')]).nudge).toBeUndefined();

    const other = new DoomLoopGuard();
    other.recordResults([failure('/tmp/a.ts')]);
    other.recordResults([failure('/var/b.ts')]);
    expect(other.recordResults([{
      name: 'Read',
      arguments: { path: '/tmp/a.ts' },
      success: false,
      summary: 'permission denied',
    }]).signals).toEqual([]);

    const reset = new DoomLoopGuard();
    reset.recordResults([failure('/tmp/a.ts')]);
    reset.recordResults([failure('/var/b.ts')]);
    reset.recordResults([{ name: 'Read', arguments: { path: '/tmp/a.ts' }, success: true, summary: 'ok' }]);
    reset.recordResults([failure('/opt/c.ts')]);
    expect(reset.recordResults([failure('/opt/d.ts')]).signals).toEqual([]);
  });

  it('abab_action_cycle hits A,B,A,B and ignores a non-alternating window', () => {
    const guard = new DoomLoopGuard();
    const stepA = [call('Read', { path: 'a.ts' })];
    const stepB = [call('Grep', { pattern: 'x' })];
    guard.recordStep(stepA);
    guard.recordStep(stepB);
    guard.recordStep(stepA);
    expect(guard.recordResults([]).signals).toEqual([]);
    expect(guard.recordStep(stepB).level).toBe('none');
    const hit = guard.recordResults([]);
    expect(hit.signals).toEqual(['abab_action_cycle']);
    expect(hit.nudge).toContain('abab_action_cycle');
    expect(hit.nudge).toContain('change strategy');
    guard.recordStep(stepA);
    expect(guard.recordResults([]).nudge).toBeUndefined();

    const broken = new DoomLoopGuard();
    broken.recordStep(stepA);
    broken.recordStep(stepB);
    broken.recordStep([call('Write', { path: 'c.ts' })]);
    broken.recordStep(stepA);
    expect(broken.recordResults([]).signals).toEqual([]);

    const same = new DoomLoopGuard();
    same.recordStep(stepA);
    same.recordStep(stepA);
    same.recordStep(stepA);
    same.recordStep(stepA);
    expect(same.recordResults([]).signals).toEqual([]);
  });

  it('collectGuardStepResults only pairs tool results added after the snapshot', () => {
    const messages = [
      { role: 'assistant', toolCalls: [{ id: 'old', name: 'Read', arguments: { path: 'old.ts' } }] },
      { role: 'tool', toolResults: [{ toolCallId: 'old', success: true, output: 'old' }] },
      { role: 'assistant', toolCalls: [{ id: 'new', name: 'task_output', arguments: { task_id: 'bg-1' } }] },
      {
        role: 'tool',
        toolResults: [{
          toolCallId: 'new',
          success: false,
          error: 'still running',
          metadata: { status: 'running' },
        }],
      },
    ];
    expect(collectGuardStepResults(messages, 2)).toEqual([{
      name: 'task_output',
      arguments: { task_id: 'bg-1' },
      success: false,
      summary: 'status=running\nstill running',
    }]);
  });
});

// ---------------------------------------------------------------------------
// N-CUA-SCREEN-GUARDS-LOOP — cua 近似点击 + 屏幕未变连击
// ---------------------------------------------------------------------------
const CUA = 'mcp__cua-driver__';

/** 计算器样例 AX 树：display 是屏上数字，指纹必须保留数字（7 ≠ 12）。 */
function calcTree(display: string): string {
  return [
    '- [1] AXWindow "Calculator"',
    `- [3] AXStaticText (${display}) [id=display]`,
    '- [5] AXButton (+1) [actions=[press]]',
  ].join('\n');
}

function cuaClick(bare: string, x: number, y: number, windowId: number = 7) {
  return {
    name: `${CUA}${bare}`,
    arguments: { pid: 4321, window_id: windowId, x, y },
    success: true,
    summary: `clicked (${x},${y})`,
  };
}

const click = (x: number, y: number, windowId = 7) => cuaClick('click', x, y, windowId);

/** 快照输出带采集时间戳：指纹剥掉时间戳后内容相同才算"屏幕没变"。 */
function cuaSnapshot(tree: string, windowId = 7, at = '2026-11-03T10:00:00') {
  return {
    name: `${CUA}get_window_state`,
    arguments: { pid: 4321, window_id: windowId },
    success: true,
    summary: `captured ${at}\n${tree}`,
  };
}

describe('DoomLoopGuard cua screen-click signals — N-CUA-SCREEN-GUARDS-LOOP', () => {
  it('(a) fires on the 3rd near-identical click with unchanged snapshots (±24 px boundary included)', () => {
    const guard = new DoomLoopGuard();
    const tree = calcTree('7');
    guard.recordResults([cuaSnapshot(tree)]);
    guard.recordResults([click(400, 300)]);
    guard.recordResults([cuaSnapshot(tree, 7, '2026-11-03T10:00:05')]); // 时间戳变了，内容没变
    expect(guard.recordResults([click(402, 298)]).signals).toEqual([]); // streak 2
    guard.recordResults([cuaSnapshot(tree, 7, '2026-11-03T10:00:11')]);
    const hit = guard.recordResults([click(399, 303)]);
    expect(hit.signals).toEqual(['screen_click_no_effect']);
    expect(hit.nudge).toContain('screen did not change after repeated near-identical clicks');
    expect(hit.nudge).toContain('another element');
    expect(hit.nudge).toContain('keyboard route');

    // 点击类三兄弟（click/double_click/right_click）同一桶；|dx|=|dy|=24 恰好在界内
    const bare = new DoomLoopGuard();
    bare.recordResults([cuaSnapshot(tree)]);
    bare.recordResults([cuaClick('double_click', 400, 300)]);
    bare.recordResults([cuaSnapshot(tree)]);
    expect(bare.recordResults([cuaClick('right_click', 424, 324)]).signals).toEqual([]); // streak 2
    bare.recordResults([cuaSnapshot(tree)]);
    expect(bare.recordResults([click(400, 300)]).signals).toEqual(['screen_click_no_effect']);
  });

  it('(b) stays quiet when consecutive clicks are 25 px apart, even with unchanged snapshots', () => {
    const guard = new DoomLoopGuard();
    const tree = calcTree('7');
    const xs = [400, 425, 450, 475]; // 每对相邻点击 |dx|=25（y 相同）
    for (const x of xs) {
      guard.recordResults([cuaSnapshot(tree)]);
      expect(guard.recordResults([click(x, 300)]).signals).toEqual([]);
    }
    const ys = [300, 325, 350, 375]; // 每对相邻点击 |dy|=25（x 相同）
    for (const y of ys) {
      guard.recordResults([cuaSnapshot(tree)]);
      expect(guard.recordResults([click(400, y)]).signals).toEqual([]);
    }
  });

  it('(c) stays quiet when the snapshot changes between clicks, including digit-only changes', () => {
    const guard = new DoomLoopGuard();
    guard.recordResults([cuaSnapshot(calcTree('7'))]);
    guard.recordResults([click(400, 300)]);
    guard.recordResults([cuaSnapshot(calcTree('8'))]); // 屏上数字 7→8：点击生效了
    expect(guard.recordResults([click(402, 298)]).signals).toEqual([]);
    guard.recordResults([cuaSnapshot(calcTree('12'))]); // 8→12 同样是数字级变化
    expect(guard.recordResults([click(399, 303)]).signals).toEqual([]);
  });

  it('(d) stays quiet when near-identical clicks target different windows', () => {
    const guard = new DoomLoopGuard();
    const tree = calcTree('7');
    guard.recordResults([cuaSnapshot(tree, 7)]);
    guard.recordResults([cuaSnapshot(tree, 8)]);
    guard.recordResults([click(400, 300, 7)]);
    guard.recordResults([cuaSnapshot(tree, 7)]);
    expect(guard.recordResults([click(402, 298, 8)]).signals).toEqual([]);
    guard.recordResults([cuaSnapshot(tree, 8)]);
    expect(guard.recordResults([click(399, 303, 7)]).signals).toEqual([]);
    guard.recordResults([cuaSnapshot(tree, 7)]);
    // 两个窗口各点两次；若 key 不分窗口，第 3 次点击就会命中
    expect(guard.recordResults([click(401, 301, 8)]).signals).toEqual([]);
  });

  it('(e) stays quiet without snapshot evidence between clicks', () => {
    const none = new DoomLoopGuard();
    none.recordResults([click(400, 300)]);
    none.recordResults([click(402, 298)]);
    expect(none.recordResults([click(399, 303)]).signals).toEqual([]);

    const stale = new DoomLoopGuard();
    const tree = calcTree('7');
    stale.recordResults([cuaSnapshot(tree)]);
    stale.recordResults([click(400, 300)]);
    stale.recordResults([cuaSnapshot(tree)]);
    expect(stale.recordResults([click(402, 298)]).signals).toEqual([]); // streak 2
    // 点击 2 与点击 3 之间没有新快照：无证据不得判"屏幕没变"
    expect(stale.recordResults([click(399, 303)]).signals).toEqual([]);
  });

  it('(f) fires at most once per run', () => {
    const guard = new DoomLoopGuard();
    const tree = calcTree('7');
    guard.recordResults([cuaSnapshot(tree)]);
    guard.recordResults([click(400, 300)]);
    guard.recordResults([cuaSnapshot(tree)]);
    guard.recordResults([click(402, 298)]);
    guard.recordResults([cuaSnapshot(tree)]);
    expect(guard.recordResults([click(399, 303)]).signals).toEqual(['screen_click_no_effect']);
    guard.recordResults([cuaSnapshot(tree)]);
    const again = guard.recordResults([click(401, 301)]);
    expect(again.signals).toEqual([]);
    expect(again.nudge).toBeUndefined();
  });

  it('(g) resetAfterHandback clears the cua click tracker and the fingerprints', () => {
    const guard = new DoomLoopGuard();
    const tree = calcTree('7');
    guard.recordResults([cuaSnapshot(tree)]);
    guard.recordResults([click(400, 300)]);
    guard.recordResults([cuaSnapshot(tree)]);
    expect(guard.recordResults([click(402, 298)]).signals).toEqual([]); // streak 2
    guard.resetAfterHandback();
    // 未清空的话，下一次计数点击就是第 3 连击；清空后要重新数满 3 次
    guard.recordResults([cuaSnapshot(tree)]);
    expect(guard.recordResults([click(399, 303)]).signals).toEqual([]); // streak 1
    guard.recordResults([cuaSnapshot(tree)]);
    expect(guard.recordResults([click(401, 301)]).signals).toEqual([]); // streak 2
    guard.recordResults([cuaSnapshot(tree)]);
    expect(guard.recordResults([click(400, 300)]).signals).toEqual(['screen_click_no_effect']);
  });

  it('counts only successful finite x/y cua-driver clicks (element_index / failures / foreign tools excluded)', () => {
    const tree = calcTree('7');
    const byIndex = {
      name: `${CUA}click`,
      arguments: { pid: 4321, window_id: 7, element_index: 5 },
      success: true,
      summary: 'clicked element 5',
    };
    const byIndexGuard = new DoomLoopGuard();
    for (let i = 0; i < 4; i++) {
      byIndexGuard.recordResults([cuaSnapshot(tree)]);
      expect(byIndexGuard.recordResults([byIndex]).signals).toEqual([]);
    }

    const failedGuard = new DoomLoopGuard();
    for (let i = 0; i < 4; i++) {
      failedGuard.recordResults([cuaSnapshot(tree)]);
      expect(failedGuard.recordResults([{ ...click(400, 300), success: false }]).signals).toEqual([]);
    }

    const foreignGuard = new DoomLoopGuard();
    for (let i = 0; i < 4; i++) {
      foreignGuard.recordResults([{ ...cuaSnapshot(tree), name: 'get_window_state' }]);
      expect(foreignGuard.recordResults([{
        name: 'click',
        arguments: { pid: 4321, window_id: 7, x: 400, y: 300 },
        success: true,
        summary: 'clicked',
      }]).signals).toEqual([]);
    }

    const nonFiniteGuard = new DoomLoopGuard();
    for (const args of [{ x: '400', y: 300 }, { x: 400, y: Number.NaN }, { x: Number.POSITIVE_INFINITY, y: 300 }]) {
      nonFiniteGuard.recordResults([cuaSnapshot(tree)]);
      expect(nonFiniteGuard.recordResults([{
        name: `${CUA}click`,
        arguments: { pid: 4321, window_id: 7, ...args },
        success: true,
        summary: 'clicked',
      }]).signals).toEqual([]);
    }
  });
});
