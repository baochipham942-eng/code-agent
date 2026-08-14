// ============================================================================
// SOUL.md 组合路径的工程层完整性（L8 N-L8-GHOSTRULES）
// ============================================================================
// loadSoul 有两条路：没有 SOUL.md/PROFILE.md 时直接返回 IDENTITY_PROMPT，有则
// 逐段重拼。重拼那条是**手抄的一份段落清单**，抄漏一段 = 用户一写 SOUL.md，某条
// 工程层规则就悄悄不下发了 —— OBJECTIVITY_RULES 真漏过（2026-08-14 在产品负责人
// 本机实测：有 SOUL.md，「敢反对用户」整段没进请求体）。
//
// 已有的 tests/unit/copaw/soulLoader.test.ts 把 identity 整个 mock 成 MOCK_* 字面量，
// 再逐个 `toContain('MOCK_XXX')` —— 那是一份**按名字枚举的清单**，新增/漏掉一段它
// 都不会红。这里改成从真实 identity 模块**推导**段落集合，不写名字。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as identity from '../../../src/host/prompts/identity';

/** 工程层段落 = identity 导出的所有字符串块，减去「会被 SOUL.md 顶掉的核心身份」与「整体成品」 */
function engineeringLayerBlocks(): string[] {
  const excluded = new Set(['IDENTITY', 'IDENTITY_PROMPT']);
  return Object.entries(identity)
    .filter(([name, value]) => !excluded.has(name) && typeof String(value) === 'string' && String(value).trim().length > 40)
    .map(([, value]) => String(value));
}

describe('loadSoul 组合路径不丢工程层段落', () => {
  let tmpDir: string;
  const originalDataDir = process.env.CODE_AGENT_DATA_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-soul-parity-'));
    fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), '我是用户自定义人格，替换掉内置身份核心。', 'utf-8');
    process.env.CODE_AGENT_DATA_DIR = tmpDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('锚点有效：确实推导出了多个工程层段落', () => {
    // 推导返回空还判「全都在」= 假绿
    expect(engineeringLayerBlocks().length).toBeGreaterThanOrEqual(5);
  });

  it('门自己的盲区要报出来：IDENTITY_PROMPT 里不许有推导不到的私有段落', () => {
    // 本门只看得见 identity 的**导出面**。OBJECTIVITY_RULES 当初正是 `const` 而非
    // `export const`（#1150 加的），soulLoader 想拼也 import 不到 —— 只要还有这种私有块，
    // 它从任何组合路径掉队本门都抓不到。所以先证明「导出面能拼回整块 IDENTITY_PROMPT」。
    let remainder = String(identity.IDENTITY_PROMPT);
    for (const block of [String(identity.IDENTITY), ...engineeringLayerBlocks()]) {
      remainder = remainder.replace(block, '');
    }
    expect(
      remainder.trim(),
      'IDENTITY_PROMPT 里有一段不在 identity 的导出面上 —— 本门推导不到它，' +
        '它从 soulLoader 之类的组合路径掉队时不会报红。把它改成 export const。\n' +
        `剩余片段：${remainder.trim().slice(0, 200)}`,
    ).toBe('');
  });

  it('用户写了 SOUL.md 之后，IDENTITY_PROMPT 里的每个工程层段落仍然下发', async () => {
    const { loadSoul } = await import('../../../src/host/prompts/soulLoader');
    const composed = loadSoul();

    expect(composed).toContain('我是用户自定义人格');

    const missing = engineeringLayerBlocks()
      .filter((block) => !composed.includes(block))
      .map((block) => block.split('\n')[0].slice(0, 60));

    expect(
      missing,
      `这些工程层段落在 SOUL.md 组合路径上丢了（默认路径有、写了 SOUL.md 就没了）：\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});
