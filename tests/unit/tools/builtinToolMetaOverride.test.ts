// ============================================================================
// 内置 toolMeta 不许顶掉 schema description
// ----------------------------------------------------------------------------
// `schemaToDefinition`（tools/dispatch/toolDefinitions.ts）合并顺序是
//   cloud?.description || schema.dynamicDescription?.() || schema.description
// —— cloud meta 优先级最高。这个设计是为了让运营能远端下发更新后的描述。
//
// 但 `builtinConfig.BUILTIN_TOOL_META` 是**本地兜底**，写的是一句话的占位描述
// （"创建子任务"这种）。它一旦用上与某个 schema **大小写完全一致**的键，就会把那个工具
// 整份 description 顶成那一句——而工具 description 正是模型判断「这个工具怎么用、
// 什么时候别用」的唯一来源，顶掉等于那些规则从来没发过，且**没有任何报错**。
//
// 2026-08-14（L8 N-L8-RULES-SINK）实测抓到一例：`Task: '创建子任务'` 命中 Task 的
// schema 名，把整段委派路由规则 + renderAgentCatalogSection() 动态渲染的子代理目录
// 换成了那五个字。其余条目（bash / read_file / glob …）都是历史小写名，查不中所以无害。
//
// 本门只管**内置兜底**这一份：远端真下发同名 override 是运营的显式动作，不在管辖范围。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolSchema } from '../../../src/host/protocol/tools';
import { getBuiltinConfig } from '../../../src/host/services/cloud/builtinConfig';

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

async function collectSchemaNames(): Promise<string[]> {
  const names = new Set<string>();
  for (const file of walkSchemaFiles(MODULES_DIR)) {
    let mod: Record<string, unknown>;
    try { mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>; } catch { continue; }
    for (const value of Object.values(mod)) {
      const schema = value as Partial<ToolSchema>;
      if (!schema || typeof schema !== 'object') continue;
      if (typeof schema.name !== 'string' || !schema.inputSchema) continue;
      names.add(schema.name);
    }
  }
  return [...names];
}

describe('内置 toolMeta 兜底', () => {
  it('不与任何工具 schema 名同名（同名会静默顶掉整份 description）', async () => {
    const schemaNames = await collectSchemaNames();
    // 防零目标假绿：扫不到 schema 时下面的交集必然为空，会天然"通过"
    expect(schemaNames.length).toBeGreaterThan(50);

    const collisions = Object.keys(getBuiltinConfig().toolMeta)
      .filter((key) => schemaNames.includes(key));

    expect(
      collisions,
      `builtinConfig.BUILTIN_TOOL_META 这些键与工具 schema 同名：${collisions.join(', ')}。`
      + 'cloud meta 优先级高于 schema.description，这些工具的 description 会被替换成一句话占位符，'
      + '模型再也看不到它们真正的使用规则。要么改键名（用历史小写名），要么删掉这条兜底。',
    ).toEqual([]);
  });
});
