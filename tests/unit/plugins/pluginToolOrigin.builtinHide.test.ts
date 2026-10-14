// ============================================================================
// builtin 插件工具的用户可见 plugin origin 隐藏
// ----------------------------------------------------------------------------
// builtin 能力（browser / 图像 / 音视频…）与第三方插件共用同一注册通道，但
// 「来自插件《X》」标签只该在第三方插件行动时出现：
// - builtin 工具：getPluginOriginForTool → undefined（工具行 metadata.pluginOrigin
//   与审批卡 details 都不再带 origin）；getPluginIdForTool 保留 pluginId
//   （审计 metadata + 决策 trace plugin_origin 步骤不变）
// - 第三方插件（非 `builtin:` rootPath）：origin 照常携带 {pluginId, pluginName}
// builtin 侧全部走公开入口：真实 catalog 经 PluginRegistry.installBuiltinCapability
// 激活，不手改 pluginToolOrigin 内部状态。
// ============================================================================

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PluginRegistry } from '../../../src/host/plugins/pluginRegistry';
import { resetProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import {
  getPluginIdForTool,
  getPluginOriginForTool,
} from '../../../src/host/plugins/pluginToolOrigin';
import { sanitizeToolResultForObservation } from '../../../src/host/agent/runtime/toolObservationSanitizers';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { PermissionRequestData } from '../../../src/host/tools/types';
import type { AgentMessageOrigin } from '../../../src/host/agent/messageOrigin';
import type {
  LoadedPlugin,
  PluginAPI,
  PluginEntry,
  PluginManifest,
} from '../../../src/host/plugins/types';
import type { Tool } from '../../../src/host/tools/types';
import type { ToolModule } from '../../../src/host/protocol/tools';

const PEER: AgentMessageOrigin = { senderKind: 'peer-agent', senderAgentId: 'agent-b', sessionId: 's', runId: 'r' };

function makeTool(name: string): Tool {
  return {
    name,
    description: 'test tool',
    outputSchema: { type: 'string' as const },
    inputSchema: { type: 'object', properties: {} },
    requiresPermission: false,
    permissionLevel: 'read',
    execute: async () => ({ success: true, output: 'ok' }),
  };
}

function makeToolModule(name: string): ToolModule {
  const schema = {
    name,
    description: 'test module',
    outputSchema: { type: 'string' as const },
    inputSchema: { type: 'object' as const, properties: {} },
    category: 'fs' as const,
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

/** 注入第三方 fake plugin（磁盘 rootPath，非 `builtin:`）并激活，捕获 PluginAPI */
async function getThirdPartyApi(
  reg: PluginRegistry,
  pluginId: string,
  manifestOverrides: Partial<PluginManifest> = {},
): Promise<PluginAPI> {
  let captured: PluginAPI | undefined;
  const entry: PluginEntry = {
    activate: async (api) => {
      captured = api;
    },
  };
  const loadedPlugin: LoadedPlugin = {
    manifest: {
      id: pluginId,
      name: pluginId,
      version: '1.0.0',
      main: 'index.js',
      // 第三方插件注册 fs 类工具必须声明 filesystem 权限(pluginRegistry.assertPermission)
      permissions: ['filesystem'],
      ...manifestOverrides,
    },
    rootPath: `/plugins/${pluginId}`,
    state: 'inactive',
    entry,
    registeredTools: [],
  };
  (reg as unknown as { plugins: Map<string, LoadedPlugin> }).plugins.set(pluginId, loadedPlugin);
  const ok = await reg.activatePlugin(pluginId);
  if (!ok || !captured) throw new Error('plugin failed to activate');
  return captured;
}

describe('builtin 插件工具的用户可见 origin 隐藏', () => {
  let testDataDir: string;
  let reg: PluginRegistry;

  beforeEach(async () => {
    testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-plugin-origin-hide-'));
    process.env.CODE_AGENT_DATA_DIR = testDataDir;
    resetProtocolRegistry();
    reg = new PluginRegistry();
  });

  afterEach(async () => {
    await reg.shutdown();
    delete process.env.CODE_AGENT_DATA_DIR;
    await fs.rm(testDataDir, { recursive: true, force: true });
  });

  it('真实 builtin（browserControl / imageCreation）：pluginId 保留，用户可见 origin 隐藏', async () => {
    expect(await reg.installBuiltinCapability('builtin.browserControl')).toBe(true);
    expect(await reg.installBuiltinCapability('builtin.imageCreation')).toBe(true);

    // 审计 metadata / 决策 trace plugin_origin 的 pluginId 语义不变
    expect(getPluginIdForTool('browser_action')).toBe('builtin.browserControl');
    expect(getPluginIdForTool('image_generate')).toBe('builtin.imageCreation');

    // 用户可见 origin（工具行 metadata.pluginOrigin + 审批卡 details）隐藏
    expect(getPluginOriginForTool('browser_action')).toBeUndefined();
    expect(getPluginOriginForTool('image_generate')).toBeUndefined();
  });

  it('sanitizeToolResultForObservation：builtin 工具结果不带 pluginOrigin（browser_action / image_generate）', async () => {
    expect(await reg.installBuiltinCapability('builtin.browserControl')).toBe(true);
    expect(await reg.installBuiltinCapability('builtin.imageCreation')).toBe(true);

    for (const toolName of ['browser_action', 'image_generate']) {
      const observed = sanitizeToolResultForObservation(
        { name: toolName, arguments: {} },
        { success: true, output: 'ok', toolCallId: 'origin-hide-call' },
      );
      expect(observed.metadata ?? {}).not.toHaveProperty('pluginOrigin');
    }
  });

  it('builtin 工具自报的假 pluginOrigin 仍被剥掉（不回显、其余 metadata 保留）', async () => {
    expect(await reg.installBuiltinCapability('builtin.browserControl')).toBe(true);

    const observed = sanitizeToolResultForObservation(
      { name: 'browser_action', arguments: {} },
      {
        success: true,
        output: 'ok',
        toolCallId: 'origin-hide-call',
        metadata: {
          pluginOrigin: { pluginId: 'fake.origin', pluginName: 'Fake' },
          keepMe: 'yes',
        },
      },
    );
    expect(observed.metadata ?? {}).not.toHaveProperty('pluginOrigin');
    expect(observed.metadata).toMatchObject({ keepMe: 'yes' });
  });

  it('第三方插件（磁盘 rootPath）工具仍带 {pluginId, pluginName}（注册与观测两级）', async () => {
    const api = await getThirdPartyApi(reg, 'p-third', { displayName: 'Third Party' });
    api.registerTool(makeTool('legacy'));
    api.registerToolModule(makeToolModule('mod'));

    expect(getPluginOriginForTool('p-third:legacy')).toEqual({
      pluginId: 'p-third',
      pluginName: 'Third Party',
    });
    expect(getPluginOriginForTool('p-third:mod')).toEqual({
      pluginId: 'p-third',
      pluginName: 'Third Party',
    });

    const observed = sanitizeToolResultForObservation(
      { name: 'p-third:mod', arguments: {} },
      { success: true, output: 'ok', toolCallId: 'origin-keep-call' },
    );
    expect(observed.metadata?.pluginOrigin).toEqual({
      pluginId: 'p-third',
      pluginName: 'Third Party',
    });
  });

  it('toolExecutor 审批卡：builtin 工具 details 不带 pluginId/pluginName', async () => {
    expect(await reg.installBuiltinCapability('builtin.browserControl')).toBe(true);

    const permissionRequests: PermissionRequestData[] = [];
    const executor = new ToolExecutor({
      workingDirectory: testDataDir,
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return false; // 拒绝 → 不真正执行 browser 工具，只截审批卡
      },
    });
    executor.setAuditEnabled(false);
    // peer 起源 + execute 级工具 → ADR-067 D3 forceConfirm，稳定落入审批分支
    const result = await executor.execute(
      'browser_action',
      { action: 'navigate', url: 'https://example.com' },
      { sessionId: 'builtin-origin-hide', turnOrigin: [PEER] },
    );

    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].forceConfirm).toBe(true);
    expect(permissionRequests[0].details).not.toHaveProperty('pluginId');
    expect(permissionRequests[0].details).not.toHaveProperty('pluginName');
    expect(result.success).toBe(false);
  });
});
