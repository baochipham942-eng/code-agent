import { describe, expect, it } from 'vitest';

import { detectGameSubtypeFromMessage } from '../../../../../src/host/agent/runtime/game/subtypeDetection';

describe('detectGameSubtypeFromMessage', () => {
  it.each([
    ['build a PLATFORMER game', 'platformer'],
    ['生成一个平台跳跃游戏', 'platformer'],
    ['做一个超级玛丽关卡', 'platformer'],
    ['make a Runner with pickups', 'runner'],
    ['生成一个跑酷小游戏', 'runner'],
    ['build BREAKOUT in one html file', 'breakout'],
    ['做一个打砖块游戏', 'breakout'],
    ['make an Arkanoid clone', 'breakout'],
  ] as const)('detects %s as %s', (message, expected) => {
    expect(detectGameSubtypeFromMessage(message)).toBe(expected);
  });

  it('returns undefined for unmatched game requests', () => {
    expect(detectGameSubtypeFromMessage('生成一个 tower defense game')).toBeUndefined();
    expect(detectGameSubtypeFromMessage('写一个 puzzle game')).toBeUndefined();
    expect(detectGameSubtypeFromMessage('hello')).toBeUndefined();
  });
});
