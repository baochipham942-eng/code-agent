// ============================================================================
// Activity 面板 i18n 迁移棘轮
// 已迁文件源码中禁止再出现中文字面量（注释除外）——防回潮硬闸，与
// settingsContentI18nRatchet 同构。另校验 zh/en 词条键结构成对。
// ============================================================================

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { activityPanelEn, activityPanelZh } from '../../../src/renderer/i18n/activity';

const ACTIVITY_DIR = path.resolve(__dirname, '../../../src/renderer/components/features/activity');

/** 已完成 i18n 迁移的文件（相对 activity 目录）。只增不减。 */
const MIGRATED: string[] = [
  'ActivityPanel.tsx',
  'activityPanelModel.ts',
];

const HAN_RE = /[一-鿿]/;
// 反逃逸：一-鿿 区间的 unicode 转义写法同样算中文字面量
const HAN_ESCAPE_RE = /\\u(?:4[e-f]|[5-8][0-9a-f]|9[0-9a-f])[0-9a-f]{2}/i;

/** 去掉行注释、块注释、JSX 注释后再扫描，避免中文注释误报 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"\\])\/\/[^'"\n]*$/gm, '$1');
}

function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    keyPaths(child, prefix ? `${prefix}.${key}` : key));
}

describe('Activity 面板 i18n 棘轮', () => {
  it('MIGRATED 清单内的文件都存在', () => {
    for (const rel of MIGRATED) {
      expect(fs.existsSync(path.join(ACTIVITY_DIR, rel)), `${rel} 不存在（改名/删除需同步清单）`).toBe(true);
    }
  });

  for (const rel of MIGRATED) {
    it(`已迁文件无中文字面量: ${rel}`, () => {
      const source = fs.readFileSync(path.join(ACTIVITY_DIR, rel), 'utf-8');
      const code = stripComments(source);
      const offending = code
        .split('\n')
        .map((line, i) => ({ line: line.trim(), no: i + 1 }))
        .filter(({ line }) => HAN_RE.test(line) || HAN_ESCAPE_RE.test(line));
      expect(
        offending.map(({ no, line }) => `L${no}: ${line.slice(0, 80)}`),
        `${rel} 还有 ${offending.length} 处中文字面量`,
      ).toEqual([]);
    });
  }

  it('zh/en 词条键结构成对', () => {
    expect(keyPaths(activityPanelEn.activityPanel).sort())
      .toEqual(keyPaths(activityPanelZh.activityPanel).sort());
  });
});
