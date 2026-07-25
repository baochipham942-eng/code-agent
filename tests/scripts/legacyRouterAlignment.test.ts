// ============================================================================
// legacy modelRouter 对齐点结构门（2026-07-25 费曼审计 P2-3）
//
// legacy 直连 Provider 路径与 aiSdk 路径有两个此前「靠注释同步」的对齐点：
//   ① baseUrl 判定 —— 已抽共享（providerResolution.getSettingsProviderBaseUrl），
//      本门断言 modelRouter 真在用共享函数、且没再长出 inline settings 查询；
//   ② Anthropic 缓存断点 —— 两侧数据形状不同（raw requestBody vs AI SDK 消息），
//      不硬抽共享，本门锚定两侧 ephemeral 断点都存在（谁删了/改名了立刻红）。
// 另钉 kill date：legacy 路径必须带日期注释（到期该退役而不是永远过渡）。
// ============================================================================
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');

describe('legacy modelRouter 对齐点', () => {
  const router = read('src/host/model/modelRouter.ts');

  it('baseUrl 判定走共享函数，不再 inline 查 settings baseUrl', () => {
    expect(router).toContain('getSettingsProviderBaseUrl(');
    expect(
      /providerConfig\?\.baseUrl/.test(router),
      'modelRouter 又长出了 inline 的 providerConfig?.baseUrl 查询——用 providerResolution.getSettingsProviderBaseUrl',
    ).toBe(false);
  });

  it('legacy 路径带 kill date 注释（过渡不能无限期）', () => {
    expect(router).toMatch(/kill date \d{4}-\d{2}-\d{2}/);
  });

  it('两侧 Anthropic 缓存断点锚点都在（删除/改名须同步更新本门=执行 kill）', () => {
    expect(read('src/host/model/providers/claudeProvider.ts')).toContain("cache_control: { type: 'ephemeral' }");
    expect(read('src/host/model/adapters/aiSdkAdapter.ts')).toContain("cacheControl: { type: 'ephemeral' }");
  });
});
