export type GameSubtype = 'platformer' | 'runner' | 'breakout';

const GAME_SUBTYPE_PATTERNS: Array<{ subtype: GameSubtype; pattern: RegExp }> = [
  { subtype: 'platformer', pattern: /platformer|平台跳跃|跳跃|mario|超级玛丽/i },
  { subtype: 'runner', pattern: /runner|跑酷/i },
  { subtype: 'breakout', pattern: /breakout|打砖块|弹砖块|arkanoid/i },
];

export function detectGameSubtypeFromMessage(message: string): GameSubtype | undefined {
  for (const { subtype, pattern } of GAME_SUBTYPE_PATTERNS) {
    if (pattern.test(message)) {
      return subtype;
    }
  }
  return undefined;
}
