// ============================================================================
// roleWakeCardsTheme — 两张角色醒来卡的主题盲底色守门（N-UI-ROLE-WAKE-CARD-REDO）
// 视觉范本 role-wake-prototype.html：醒来角色像普通一轮发言，无填充面板，颜色全走
// 主题 token。bg-<palette>-950 这类固定标度底色不随主题翻转（light 下 zinc/sky 不换
// 档，洗成泥灰块），一经回潮必须红。反向变异锚点：把 bg-sky-950/30 塞回任一文件，
// 本用例必须 FAIL。
// ============================================================================
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CARD_FILES = [
  'src/renderer/components/features/chat/RoleFirstWakeCard.tsx',
  'src/renderer/components/features/chat/RoleWakeProposalsCard.tsx',
] as const;

describe('role wake cards theme tokens', () => {
  it.each(CARD_FILES)('%s 不含主题盲的 bg-*-950 底色', (file) => {
    const source = readFileSync(path.resolve(process.cwd(), file), 'utf-8');
    expect(source).not.toMatch(/bg-[a-z0-9]+-950\b/);
  });
});
