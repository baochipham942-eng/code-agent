import { describe, expect, it } from 'vitest';
import {
  isLoopCommand,
  parseLoopCommand,
} from '../../../src/renderer/components/features/chat/ChatInput/parseLoopCommand';

describe('/loop command helpers', () => {
  it('detects only the loop slash command', () => {
    expect(isLoopCommand('/loop 查部署状态')).toBe(true);
    expect(isLoopCommand('  /loop 查部署状态')).toBe(true);
    expect(isLoopCommand('/loophole')).toBe(false);
    expect(isLoopCommand('/lo 查')).toBe(false);
  });

  it('parses a fixed-interval loop with prompt', () => {
    expect(parseLoopCommand('/loop 30s 查部署状态，好了告诉我')).toEqual({
      prompt: '查部署状态，好了告诉我',
      intervalMs: 30_000,
    });
  });

  it('parses minutes and hours units', () => {
    expect(parseLoopCommand('/loop 5m 巡检')).toMatchObject({ intervalMs: 300_000 });
    expect(parseLoopCommand('/loop 2h 巡检')).toMatchObject({ intervalMs: 7_200_000 });
  });

  it('parses a composite duration', () => {
    expect(parseLoopCommand('/loop 1h30m 巡检')).toMatchObject({ intervalMs: 5_400_000 });
  });

  it('treats a bare prompt without leading duration as self-paced (no interval)', () => {
    expect(parseLoopCommand('/loop 改到测试全绿')).toEqual({ prompt: '改到测试全绿' });
  });

  it('does not treat a unitless number as an interval', () => {
    expect(parseLoopCommand('/loop 5 个测试要跑')).toEqual({ prompt: '5 个测试要跑' });
  });

  it('parses flags: max-turns / until / budget', () => {
    expect(
      parseLoopCommand('/loop 1m 巡检 CI --max-turns 8 --until "全部通过" --budget 50000'),
    ).toEqual({
      prompt: '巡检 CI',
      intervalMs: 60_000,
      maxTurns: 8,
      until: '全部通过',
      budget: 50_000,
    });
  });

  it('keeps an empty prompt empty so the submit layer can show usage', () => {
    expect(parseLoopCommand('/loop 30s')).toEqual({ prompt: '', intervalMs: 30_000 });
  });

  it('returns null for non-loop input', () => {
    expect(parseLoopCommand('/goal 修好链路')).toBeNull();
  });
});
