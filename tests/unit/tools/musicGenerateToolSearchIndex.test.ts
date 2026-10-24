// ============================================================================
// music_generate ToolSearch 可发现性 tests — N-MEDIA-GEN-MUSIC-FALLBACK 返修
//
// music_generate 由 builtin.musicGeneration 插件经 registerToolModule →
// registerProtocolTool 注册。「注册即可发现」门（toolRegistrationDiscoverability）
// 只扫 registerMigratedTools，管不到插件通道：索引漏登时工具「已注册但模型够不着」
// ——真跑实测 select:music_generate 0 命中、模型被迫本地合成（r4a/r4b）。
// 本文件钉住补登后的到达路径：索引成员、select 命中自身并可加载、关键词可搜、
// <deferred-tools> 折叠索引 [media] 行向模型宣传它。
// ============================================================================

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { musicGenerateModule } from '../../../src/host/plugins/builtin/musicGeneration/musicGenerate';
import { registerProtocolTool, unregisterProtocolTool } from '../../../src/host/tools/protocolToolRegistration';
import { ToolSearchService } from '../../../src/host/services/toolSearch/toolSearchService';
import { getDeferredToolsSummary } from '../../../src/host/tools/dispatch/toolDefinitions';
import { DEFERRED_TOOLS_META } from '../../../src/host/services/toolSearch/deferredTools';

// 复刻 PluginAPI v2 registerToolModule(prefixWithPluginId:false) 的注册效果：
// schema 原名注册进 protocol registry（loader 首次解析时才调 createHandler）。
const TOOL_NAME = musicGenerateModule.schema.name;

describe('music_generate ToolSearch 可发现性', () => {
  beforeEach(() => {
    registerProtocolTool(musicGenerateModule.schema, async () => musicGenerateModule);
  });
  afterEach(() => {
    unregisterProtocolTool(TOOL_NAME);
  });

  it('在 DEFERRED_TOOLS_META 索引里（漏登即红——r4a/r4b 的病根）', () => {
    expect(DEFERRED_TOOLS_META.map((meta) => meta.name)).toContain(TOOL_NAME);
  });

  it('select:music_generate 命中它自己且可加载（loaded 进下一轮工具表）', () => {
    const service = new ToolSearchService();
    const result = service.selectTool(TOOL_NAME);
    expect(result.tools[0]?.name).toBe(TOOL_NAME);
    expect(result.tools[0]?.loadable).toBe(true);
    expect(result.loadedTools).toContain(TOOL_NAME);
  });

  it('关键词搜索 music / 音乐 能搜到它', async () => {
    const service = new ToolSearchService();
    for (const query of ['music', 'music generate', '音乐 生成']) {
      const result = await service.searchTools(query, { maxResults: 10 });
      expect(
        result.tools.map((tool) => tool.name),
        `query=${query}`,
      ).toContain(TOOL_NAME);
    }
  });

  it('<deferred-tools> 折叠索引 [media] 行宣传 music_generate', () => {
    // 默认 token 预算下 [media] 行是 nameLines 形态（名字列表，不带描述）
    const summary = getDeferredToolsSummary();
    expect(summary).toContain('[media]');
    expect(summary).toMatch(new RegExp(`\\[media\\][^\\n]*\\b${TOOL_NAME}\\b`));
  });
});
