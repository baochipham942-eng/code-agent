// ============================================================================
// 常驻工具表 schema 预算棘轮 —— 只许降不许涨
// ----------------------------------------------------------------------------
// 背景（L8 注意力预算线，2026-08-14）：CORE_TOOLS 里的每个工具，schema 每一轮都随请求
// 全额下发。ATT6 实测这一桶曾占每轮固定开销的近一半，其中约七成体积在 inputSchema 的
// property description 里——典型形态是每个参数写 2~4 句、带三个示例、还把 `type` 字段
// 已经声明过的类型再用 "MUST be a string" 复述一遍。
//
// 光写「参数描述要精简」的规范挡不住反弹：规范是文字，没人跑；本门是数字，CI 每次跑。
//
// ## 参数描述写法（违反了本门会涨，涨了就会红）
//   1. 不复述 `type` 已经声明的东西（"MUST be a string" 是纯浪费）
//   2. 不写示例——除非那个格式光靠散文说不清（如 glob 的 ** 语义）
//   3. 别名不双写：`limit` 是 `head_limit` 的别名就不要两个都进 schema，
//      handler 继续接受别名做向后兼容即可（Grep 就是这么处理的）
//   4. 默认值写一次，写成 "Default 2000." 而不是 "Default: 2000. Example: limit=50 ..."
//
// ## 调基线的正当理由
//   - **降**：瘦身完了把基线跟着降下来，锁住成果。
//   - **涨**：只有「新工具进 CORE」这一种。那本身是个需要显式决策的动作
//     （判据见 CORE_TOOLS 的注释块），顺手改个数字比悄悄多花每轮 token 好得多。
//   - 把工具挪出 CORE 会让总量下降，此时**必须**同步下调基线，否则门就松了。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolSchema } from '../../../src/host/protocol/tools';
import { estimateTokens } from '../../../src/host/context/tokenEstimator';
import { CORE_TOOLS } from '../../../src/host/services/toolSearch/deferredTools';

/**
 * 2026-08-14 实测值。口径：对每个 CORE 工具取 `{name, description, parameters}` 的 JSON，
 * 过 Neo 自己的 tokenizer（gpt-tokenizer BPE）求和。
 *
 * ⚠️ 别用「字符数 ÷ 3」那套估算——实测它按语言系统性偏斜（纯中文真 token 是它的 2.16 倍、
 * 纯英文是 0.44 倍），工具 schema 几乎全英文会被高估约一倍，桶间比例直接失真。
 */
const CORE_SCHEMA_TOKEN_BASELINE = 4155;

const MODULES_DIR = join(__dirname, '../../../src/host/tools/modules');

function walkSchemaFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkSchemaFiles(p));
    else if (name.endsWith('.schema.ts')) out.push(p);
  }
  return out;
}

async function collectCoreSchemas(): Promise<{ name: string; token: number }[]> {
  const core = new Set(CORE_TOOLS);
  const found: { name: string; token: number }[] = [];
  for (const file of walkSchemaFiles(MODULES_DIR)) {
    let mod: Record<string, unknown>;
    try { mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>; } catch { continue; }
    for (const value of Object.values(mod)) {
      const schema = value as Partial<ToolSchema>;
      if (!schema || typeof schema !== 'object') continue;
      if (typeof schema.name !== 'string' || !schema.inputSchema) continue;
      if (!core.has(schema.name)) continue;
      found.push({
        name: schema.name,
        token: estimateTokens(JSON.stringify({
          name: schema.name,
          description: schema.description ?? '',
          parameters: schema.inputSchema,
        })),
      });
    }
  }
  return found;
}

describe('常驻工具表 schema 预算', () => {
  it('CORE 工具 schema 总量不超基线（只许降不许涨）', async () => {
    const schemas = await collectCoreSchemas();

    // 防零目标假绿：扫不到工具时下面的求和是 0，会天然低于基线而"通过"
    expect(schemas.length).toBeGreaterThan(10);
    // 也防漏扫：CORE 里的名字必须都在 modules 下找得到 schema
    const missing = CORE_TOOLS.filter((name) => !schemas.some((s) => s.name === name));
    expect(missing).toEqual([]);

    const total = schemas.reduce((sum, s) => sum + s.token, 0);
    const detail = [...schemas].sort((a, b) => b.token - a.token)
      .map((s) => `${s.name}=${s.token}`).join(' ');

    expect(
      total,
      `CORE schema 总量 ${total} 超过基线 ${CORE_SCHEMA_TOKEN_BASELINE}。`
      + `每涨 1 token 就是每一轮请求都多花 1 token。逐项：${detail}`,
    ).toBeLessThanOrEqual(CORE_SCHEMA_TOKEN_BASELINE);
  });

  it('基线没有松到失去意义（瘦身后要同步下调）', async () => {
    const total = (await collectCoreSchemas()).reduce((sum, s) => sum + s.token, 0);
    // 留 5% 余量给正常措辞调整；超过这个幅度说明瘦身成果没锁进基线
    expect(
      CORE_SCHEMA_TOKEN_BASELINE - total,
      `实际 ${total} 比基线 ${CORE_SCHEMA_TOKEN_BASELINE} 低太多，把基线降到实际值附近来锁住成果`,
    ).toBeLessThanOrEqual(Math.round(CORE_SCHEMA_TOKEN_BASELINE * 0.05));
  });
});
