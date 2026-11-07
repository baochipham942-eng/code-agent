// ============================================================================
// roleWakeCardsTheme — 两张角色醒来卡的主题盲底色守门（N-UI-ROLE-WAKE-CARD-REDO）
// 视觉范本 role-wake-prototype(-v2).html：醒来角色像普通一轮发言，无填充面板，
// 颜色全走主题 token。任何 bg-<palette>-<step> 固定标度底色都是主题盲的（light 下
// zinc/sky 不换档，洗成泥灰块），黑白色 bg-black/bg-white 同理，一经回潮必须红。
// 反向变异锚点：把 bg-sky-950/30 或 bg-zinc-900 塞回任一文件，本用例必须 FAIL。
// ============================================================================
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CARD_FILES = [
  'src/renderer/components/features/chat/RoleFirstWakeCard.tsx',
  'src/renderer/components/features/chat/RoleWakeProposalsCard.tsx',
] as const;

describe('role wake cards theme tokens', () => {
  it.each(CARD_FILES)('%s 不含主题盲的固定标度底色（bg-*-<step> / bg-black / bg-white）', (file) => {
    const source = readFileSync(path.resolve(process.cwd(), file), 'utf-8');
    // bg-void / bg-surface / bg-badge-accent 等主题 token 不带 step 数字，不受此闸
    expect(source).not.toMatch(/bg-(?:[a-z]+-)?\d{2,3}\b/);
    expect(source).not.toMatch(/\bbg-(?:black|white)\b/);
  });
});
