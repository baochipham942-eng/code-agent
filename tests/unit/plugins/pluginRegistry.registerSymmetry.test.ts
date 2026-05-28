// ============================================================================
// PluginRegistry registerTool / registerToolModule symmetry (E4)
// ============================================================================
// Pi ⑤ E4:`registerTool` 原本静默走底层 ToolRegistry 的 idempotent overwrite,
// `registerToolModule` 抛错。语义不对称 + 数组重复 push 是 bug。本次让
// `registerTool` 对称化抛错(底层 ToolRegistry 仍保留 idempotent 给测试用)。
//
// 调研结论:仓库内部 0 个调用方用 registerTool v1 API。热重载路径走
// reloadPlugin → deactivate(清空 registeredTools)→ activate,不依赖 silent
// overwrite。第三方插件如果偶然依赖 overwrite,改抛错后会立刻看见错误而不是
// 被 bug 静默吃掉,更安全。
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { PluginRegistry } from '../../../src/main/plugins/pluginRegistry';
import { resetProtocolRegistry } from '../../../src/main/tools/protocolRegistry';
import type {
  LoadedPlugin,
  PluginAPI,
  PluginEntry,
  PluginManifest,
} from '../../../src/main/plugins/types';
import type { Tool } from '../../../src/main/tools/types';
import type { ToolModule } from '../../../src/main/protocol/tools';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeManifest(id: string): PluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    main: 'index.js',
  };
}

function makeTool(name: string): Tool {
  return {
    name,
    description: 'test tool',
    inputSchema: { type: 'object', properties: {} },
    requiresPermission: false,
    permissionLevel: 'read',
    execute: async () => ({ output: 'ok' }),
  };
}

function makeToolModule(name: string): ToolModule {
  const schema = {
    name,
    description: 'test module',
    inputSchema: { type: 'object' as const, properties: {} },
    category: 'file' as const,
    permissionLevel: 'read' as const,
  };
  return {
    schema,
    createHandler: () =>
      ({
        schema,
        execute: async () => ({ ok: true }),
      } as unknown as ReturnType<ToolModule['createHandler']>),
  };
}

/** 注入 fake plugin + 走 activatePlugin lifecycle,捕获 PluginAPI 供测试调用 */
async function getPluginApi(reg: PluginRegistry, pluginId: string): Promise<PluginAPI> {
  let captured: PluginAPI | undefined;
  const entry: PluginEntry = {
    activate: async (api) => {
      captured = api;
    },
  };
  const loadedPlugin: LoadedPlugin = {
    manifest: makeManifest(pluginId),
    rootPath: `builtin:${pluginId}`,
    state: 'inactive',
    entry,
    registeredTools: [],
    registeredHooks: [],
  };
  // Bracket-access private map 仅为单测,生产代码绝不应这么用
  (reg as unknown as { plugins: Map<string, LoadedPlugin> }).plugins.set(pluginId, loadedPlugin);
  const ok = await reg.activatePlugin(pluginId);
  if (!ok || !captured) throw new Error('plugin failed to activate');
  return captured;
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('PluginRegistry registerTool / registerToolModule symmetry', () => {
  beforeEach(() => {
    resetProtocolRegistry();
  });

  it('registerTool 重复同名 → 第二次抛 "already registered"', async () => {
    const reg = new PluginRegistry();
    const api = await getPluginApi(reg, 'p1');
    api.registerTool(makeTool('foo'));
    expect(() => api.registerTool(makeTool('foo'))).toThrowError(/already registered/);
  });

  it('registerToolModule 重复同名 → 第二次抛错(baseline 不变)', async () => {
    const reg = new PluginRegistry();
    const api = await getPluginApi(reg, 'p2');
    api.registerToolModule(makeToolModule('bar'));
    expect(() => api.registerToolModule(makeToolModule('bar'))).toThrowError(/already registered/);
  });

  it('双通道撞名:先 registerTool 再 registerToolModule 同名 → 抛错', async () => {
    const reg = new PluginRegistry();
    const api = await getPluginApi(reg, 'p3');
    api.registerTool(makeTool('shared'));
    // registerToolModule 默认 prefixWithPluginId=true → finalName = p3:shared
    expect(() => api.registerToolModule(makeToolModule('shared'))).toThrowError(/already registered/);
  });

  it('双通道撞名:先 registerToolModule 再 registerTool 同名 → 抛错', async () => {
    const reg = new PluginRegistry();
    const api = await getPluginApi(reg, 'p4');
    api.registerToolModule(makeToolModule('shared'));
    expect(() => api.registerTool(makeTool('shared'))).toThrowError(/already registered/);
  });

  it('unregisterTool 后 re-register 同名 → 成功(走 lifecycle 仍可重注册)', async () => {
    const reg = new PluginRegistry();
    const api = await getPluginApi(reg, 'p5');
    api.registerTool(makeTool('qux'));
    api.unregisterTool('qux');
    expect(() => api.registerTool(makeTool('qux'))).not.toThrow();
  });

  it('错误信息形式一致:两个 API 都用 "Tool ${pluginId}:${name} already registered"', async () => {
    const reg = new PluginRegistry();

    const api1 = await getPluginApi(reg, 'p6');
    api1.registerTool(makeTool('zzz'));
    let toolErr: unknown;
    try {
      api1.registerTool(makeTool('zzz'));
    } catch (e) {
      toolErr = e;
    }
    expect((toolErr as Error).message).toBe('Tool p6:zzz already registered');

    const api2 = await getPluginApi(reg, 'p7');
    api2.registerToolModule(makeToolModule('zzz'));
    let modErr: unknown;
    try {
      api2.registerToolModule(makeToolModule('zzz'));
    } catch (e) {
      modErr = e;
    }
    expect((modErr as Error).message).toBe('Tool p7:zzz already registered');
  });

  it('registerTool 抛错后 plugin.registeredTools 不应留 stale 条目', async () => {
    const reg = new PluginRegistry();
    const api = await getPluginApi(reg, 'p8');
    api.registerTool(makeTool('once'));
    expect(() => api.registerTool(makeTool('once'))).toThrow();
    // 通过 plugin 实例读 registeredTools 验证只有一条
    const plugin = (reg as unknown as { plugins: Map<string, LoadedPlugin> }).plugins.get('p8');
    expect(plugin?.registeredTools.filter((n) => n === 'p8:once')).toHaveLength(1);
  });
});
