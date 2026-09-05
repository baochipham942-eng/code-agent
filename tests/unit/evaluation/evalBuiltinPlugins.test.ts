// ============================================================================
// eval 跑级 builtin 插件开关（--builtin-plugins）
// ============================================================================
// 这套断言守的是 N-SELFVALIDATE-NUDGE #1634 验收① 被判「物理上不可达」的那条链：
// eval 进程从不起插件系统 ⇒ validate_html_in_app 在评测里永远「不可直接调用」⇒
// 「模型会不会自检」这道题根本测不了。开关打开后这条链必须真的通。
//
// 数据目录在 import 任何产品模块之前就钉到 mktemp——插件系统会建库、写日志、
// 落 .secure-key，绝不能落到真实 ~/.code-agent。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// 第三方插件发现走 pluginLoader.discoverPlugins。开关只该装点名的 builtin，
// 绝不该顺手把 <dataDir>/plugins 里的第三方插件也激活——那些工具照样进 protocol registry，
// 而 stamp 只记 builtin，两臂对比就被污染了。这里直接盯「有没有去扫」。
vi.mock('../../../src/host/plugins/pluginLoader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/plugins/pluginLoader')>();
  return { ...actual, discoverPlugins: vi.fn(actual.discoverPlugins) };
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-builtin-plugins-'));
process.env.CODE_AGENT_DATA_DIR = dataDir;

type PluginsModule = typeof import('../../../packages/internal/evaluation-center/scripts/lib/eval-builtin-plugins');
type RegistryModule = typeof import('../../../src/host/plugins/pluginRegistry');
type ProtocolModule = typeof import('../../../src/host/tools/protocolRegistry');
type ToolSearchModule = typeof import('../../../src/host/services/toolSearch/toolSearchService');

let plugins: PluginsModule;
let registry: RegistryModule;
let toolSearch: ToolSearchModule;

// 故意不在 beforeAll 里 import：protocolRegistry 的 import 副作用会装上 protocol 注册端口，
// 提前装好就等于替被测代码把 initializeWebPluginSystem 的那半步做了，
// 「先 protocolRegistry 再 initPluginSystem」这个顺序错了也测不出来。
const protocolRegistry = (): Promise<ProtocolModule> => import('../../../src/host/tools/protocolRegistry');

const PLUGIN_TOOL = 'validate_html_in_app';

beforeAll(async () => {
  plugins = await import('../../../packages/internal/evaluation-center/scripts/lib/eval-builtin-plugins');
  registry = await import('../../../src/host/plugins/pluginRegistry');
  toolSearch = await import('../../../src/host/services/toolSearch/toolSearchService');
});

afterAll(async () => {
  await plugins.shutdownEvalBuiltinPlugins();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('--builtin-plugins 解析', () => {
  it('all / none 是原样透传的两个字面量', () => {
    expect(plugins.parseBuiltinPluginsArg('all')).toBe('all');
    expect(plugins.parseBuiltinPluginsArg(' none ')).toBe('none');
  });

  it('id 可省 builtin. 前缀', () => {
    expect(plugins.parseBuiltinPluginsArg('browserControl,builtin.computerUse'))
      .toEqual(['builtin.browserControl', 'builtin.computerUse']);
  });

  it('未知 id fail-loud，不静默忽略', () => {
    // 静默忽略 = 「我明明点名了却零分差」，事后没人能解释那次跑
    expect(() => plugins.parseBuiltinPluginsArg('browserControl,nope')).toThrow(/未知插件 id.*nope/s);
    expect(() => plugins.parseBuiltinPluginsArg(' , ')).toThrow(/需要 all \/ none/);
  });
});

describe('插件面开关', () => {
  it('none：不起插件系统，工具面与存量跑法一致', async () => {
    const activation = await plugins.activateEvalBuiltinPlugins('none');

    expect(activation.active).toEqual([]);
    expect(activation.failures).toEqual([]);
    // stamp 的 shape.plugins 取的就是这里
    expect(registry.getActiveBuiltinPluginIds()).toEqual([]);

    const selected = toolSearch.getToolSearchService().selectTool(PLUGIN_TOOL);
    expect(selected.tools[0]?.loadable).toBe(false);
    expect(selected.tools[0]?.notCallableReason)
      .toBe('searchable metadata has no registered protocol tool');
    expect(selected.loadedTools).toEqual([]);
  });

  it('all：builtin 真激活，且 stamp 读到的是实际激活集', async () => {
    const activation = await plugins.activateEvalBuiltinPlugins('all');

    expect(activation.active.length).toBeGreaterThan(0);
    expect(activation.active).toContain('builtin.browserControl');
    expect(registry.getActiveBuiltinPluginIds()).toEqual(activation.active);
    for (const id of activation.active) {
      expect(registry.getPluginRegistry().getPlugin(id)?.state).toBe('active');
    }
  }, 60_000);

  it('all：只装 builtin，从不扫磁盘找第三方插件（真阴）', async () => {
    const { discoverPlugins } = await import('../../../src/host/plugins/pluginLoader');
    expect(vi.mocked(discoverPlugins)).not.toHaveBeenCalled();

    // registry 里除了 builtin 不该有别人
    for (const plugin of registry.getPluginRegistry().getPlugins()) {
      expect(plugin.rootPath.startsWith('builtin:'), plugin.manifest.id).toBe(true);
    }
  });

  it('all：验收③——validate_html_in_app 在评测环境里可加载、可被 tool_called 记到', async () => {
    const protocol = await protocolRegistry();
    expect(protocol.isProtocolToolName(PLUGIN_TOOL)).toBe(true);

    const selected = toolSearch.getToolSearchService().selectTool(PLUGIN_TOOL);
    expect(selected.tools[0]?.loadable).toBe(true);
    expect(selected.tools[0]?.notCallableReason).toBeUndefined();
    expect(selected.loadedTools).toEqual([PLUGIN_TOOL]);
  });

  it('显式子集：只留点名的那些，其余摘掉', async () => {
    const activation = await plugins.activateEvalBuiltinPlugins(['builtin.browserControl']);

    expect(activation.active).toEqual(['builtin.browserControl']);
    expect(activation.failures).toEqual([]);
    expect(registry.getActiveBuiltinPluginIds()).toEqual(['builtin.browserControl']);
    const protocol = await protocolRegistry();
    expect(protocol.isProtocolToolName(PLUGIN_TOOL)).toBe(true);
    // 被摘掉的插件，它注册的工具也必须一起下线
    expect(protocol.isProtocolToolName('image_process')).toBe(false);
  }, 60_000);

  it('描述行说的是「激活了谁」，不是「请求了谁」', () => {
    expect(plugins.describeBuiltinPluginActivation('none', { active: [], failures: [] }))
      .toContain('请求=none');
    const line = plugins.describeBuiltinPluginActivation(
      ['builtin.computerUse'],
      { active: [], failures: [{ id: 'builtin.computerUse', reason: '未安装' }] },
    );
    expect(line).toContain('未激活');
    expect(line).toContain('builtin.computerUse');
  });
});
