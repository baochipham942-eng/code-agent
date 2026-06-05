import { describe, expect, it } from 'vitest';
import {
  buildTurnPrompt,
  detectDoneMarker,
  parseWaitMs,
} from '../../src/main/loop/loopPrompt';
import { LOOP_DONE_MARKER } from '../../src/shared/contract/loop';

const base = {
  prompt: '查部署状态',
  turn: 1,
} as const;

describe('loop prompt helpers', () => {
  it('builds a turn prompt with self-pace hint when no interval', () => {
    const p = buildTurnPrompt(base);
    expect(p).toContain('查部署状态');
    expect(p).toContain('第 1 轮');
    expect(p).toContain('LOOP_WAIT'); // 自定步调提示
  });

  it('omits self-pace hint when fixed interval is set', () => {
    const p = buildTurnPrompt({ ...base, intervalMs: 30_000 });
    expect(p).not.toContain('LOOP_WAIT');
  });

  it('includes done-marker instruction when until is set', () => {
    const p = buildTurnPrompt({ ...base, until: '部署成功' });
    expect(p).toContain('部署成功');
    expect(p).toContain(LOOP_DONE_MARKER);
  });

  it('detects the done marker in a reply', () => {
    expect(detectDoneMarker(`完成了\n${LOOP_DONE_MARKER}`)).toBe(true);
    expect(detectDoneMarker('还在继续跑')).toBe(false);
  });

  it('parses self-paced wait seconds into milliseconds', () => {
    expect(parseWaitMs('稍等一下\n[[LOOP_WAIT]] 30')).toBe(30_000);
    expect(parseWaitMs('立即继续，没有等待标记')).toBeNull();
    expect(parseWaitMs('[[LOOP_WAIT]] 0')).toBeNull();
  });
});
