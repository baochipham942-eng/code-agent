import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error —— 纯 JS 静态门脚本，无类型声明
import { scan } from '../../scripts/check-design-system.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(
  readFileSync(join(here, '../../scripts/design-system-baseline.json'), 'utf8'),
);

// 设计系统棘轮门（W2）——契约见 docs/designs/design-system.md
// 守约：禁止引入超出基线的新违规；收口（current < baseline）后须 `--update` 降棘轮。
describe('design-system gate', () => {
  const violations = scan() as Record<string, string[]>;

  for (const rule of Object.keys(baseline)) {
    it(`[${rule}] 不超基线（${baseline[rule]}）`, () => {
      const current = violations[rule]?.length ?? 0;
      expect(
        current,
        current > baseline[rule]
          ? `新增 ${current - baseline[rule]} 处违规：走 token/primitive，或加 // ds-allow:<kind> 理由。\n` +
              violations[rule].slice(0, 10).join('\n')
          : undefined,
      ).toBeLessThanOrEqual(baseline[rule]);
    });
  }
});
