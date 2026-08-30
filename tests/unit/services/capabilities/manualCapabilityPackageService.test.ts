import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualCapabilityPackageService } from '../../../../src/host/services/capabilities/manualCapabilityPackageService';
import { PluginRegistry } from '../../../../src/host/plugins/pluginRegistry';
import { loadPlugin } from '../../../../src/host/plugins/pluginLoader';
import { hasProtocolTool } from '../../../../src/host/tools/protocolToolRegistration';
import { resetProtocolRegistry } from '../../../../src/host/tools/protocolRegistry';
import {
  readBuiltinCapabilityState,
} from '../../../../src/host/plugins/builtin/computerUse/installState';
import { COMPUTER_USE_CAPABILITY_ID } from '../../../../src/host/plugins/builtin/builtinCapabilityIds';
import type { MCPServerConfig } from '../../../../src/host/mcp/types';

interface LifecycleEntry {
  id: string;
  action: 'loaded' | 'unloaded' | 'rolled_back' | 'failed';
  detail?: string;
}

let tempRoot: string;
let pluginsDir: string;
let registry: PluginRegistry;
let lifecycle: LifecycleEntry[];

function manifest(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `能力 ${id}`,
    version: '1.0.0',
    description: '用于验证手动导入链路',
    main: 'index.js',
    permissions: [],
    surfaces: ['tools'],
    ...overrides,
  };
}

function entrySource(id: string, activationPrefix = ''): string {
  return `
module.exports = {
  async activate(api) {
    ${activationPrefix}
    api.registerTool({
      name: 'ping',
      description: '返回固定探针结果',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'string' },
      requiresPermission: false,
      permissionLevel: 'read',
      async execute() { return { success: true, output: '${id}:pong' }; }
    });
  }
};
`;
}

async function writePackage(
  id: string,
  options: { manifest?: Record<string, unknown>; source?: string } = {},
): Promise<string> {
  const root = path.join(tempRoot, `source-${id}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'plugin.json'), JSON.stringify(options.manifest ?? manifest(id)), 'utf8');
  await fs.writeFile(path.join(root, 'index.js'), options.source ?? entrySource(id), 'utf8');
  return root;
}

type ServiceDependencies = NonNullable<ConstructorParameters<typeof ManualCapabilityPackageService>[0]>;

function createService(overrides: ServiceDependencies = {}): ManualCapabilityPackageService {
  return new ManualCapabilityPackageService({
    pluginsDir: () => pluginsDir,
    registry,
    useOsSandbox: false,
    lifecycle: (id, action, detail) => { lifecycle.push({ id, action, detail }); },
    ...overrides,
  });
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-capability-package-test-'));
  pluginsDir = path.join(tempRoot, 'plugins');
  await fs.mkdir(pluginsDir, { recursive: true });
  resetProtocolRegistry();
  registry = new PluginRegistry();
  lifecycle = [];
});

afterEach(async () => {
  registry.pauseWatching();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('ManualCapabilityPackageService', () => {
  it('lists all eight builtin plugins and hot installs or removes a default-installed builtin', async () => {
    const service = createService({ computerUseStateDir: () => tempRoot });
    const builtinPackages = (await service.list()).filter((item) => item.id.startsWith('builtin.'));
    expect(builtinPackages).toHaveLength(8);
    expect(builtinPackages.find((item) => item.id === 'builtin.computerUse')).toMatchObject({ state: 'available' });

    const preview = await service.stageBundled('builtin.imageProcess');
    expect(preview).toMatchObject({
      id: 'builtin.imageProcess',
      sourceKind: 'bundled',
      toolNames: ['image_process'],
    });
    await service.confirm(preview.token);

    expect(registry.getPlugin('builtin.imageProcess')?.state).toBe('active');
    expect(hasProtocolTool('image_process')).toBe(true);
    expect(await readBuiltinCapabilityState('builtin.imageProcess', tempRoot)).toBe('installed');

    await service.uninstall('builtin.imageProcess');
    expect(registry.getPlugin('builtin.imageProcess')).toBeUndefined();
    expect(hasProtocolTool('image_process')).toBe(false);
    expect(await readBuiltinCapabilityState('builtin.imageProcess', tempRoot)).toBe('removed');
    expect(lifecycle.map((entry) => entry.action)).toEqual(['loaded', 'unloaded']);
  });

  it('accepts both a directory and its manifest file without writing before confirmation', async () => {
    const service = createService();
    const source = await writePackage('directory-cap');

    const directoryPreview = await service.stage(source);
    expect(directoryPreview.sourceKind).toBe('directory');
    expect(directoryPreview.sandbox.passed).toBe(true);
    expect(directoryPreview.toolNames).toEqual(['ping']);
    await expect(fs.stat(path.join(pluginsDir, 'directory-cap'))).rejects.toMatchObject({ code: 'ENOENT' });
    await service.discard(directoryPreview.token);

    const manifestPreview = await service.stage(path.join(source, 'plugin.json'));
    expect(manifestPreview.sourceKind).toBe('manifest');
    await service.discard(manifestPreview.token);
  });

  it('accepts an admin-only internal feature package and rejects an adminOnly mutation', async () => {
    const service = createService();
    const internalManifest = manifest('evaluation-center', {
      distribution: 'internal',
      adminOnly: true,
      surfaces: ['internal-feature'],
      internalFeature: {
        id: 'evaluation-center',
        label: '评测中心',
        rendererEntry: 'renderer/index.js',
      },
    });
    const source = await writePackage('evaluation-center', {
      manifest: internalManifest,
      source: 'module.exports = { async activate() {} };',
    });
    await fs.mkdir(path.join(source, 'renderer'), { recursive: true });
    await fs.writeFile(path.join(source, 'renderer', 'index.js'), 'export {};', 'utf8');

    const preview = await service.stage(source);
    expect(preview).toMatchObject({
      id: 'evaluation-center',
      surface: 'internal-feature',
      toolNames: [],
    });
    const installed = await service.confirm(preview.token);
    expect(installed).toMatchObject({ id: 'evaluation-center', surface: 'internal-feature' });
    const listed = (await service.list()).find((item) => item.id === 'evaluation-center');
    expect(listed).toMatchObject({
      id: 'evaluation-center',
      surface: 'internal-feature',
      internalFeature: { id: 'evaluation-center', label: '评测中心' },
    });

    const mutated = await writePackage('evaluation-center-mutated', {
      manifest: { ...internalManifest, id: 'evaluation-center-mutated', adminOnly: false },
      source: 'module.exports = { async activate() {} };',
    });
    await expect(service.stage(mutated)).rejects.toThrow(/adminOnly=true/);
  });

  it('rejects missing manifest fields in plain language and leaves the plugins directory untouched', async () => {
    const service = createService();
    const source = await writePackage('missing-field', {
      manifest: manifest('missing-field', { description: undefined }),
    });

    await expect(service.stage(source)).rejects.toThrow('能力包清单缺少能力说明（description）');
    expect(await fs.readdir(pluginsDir)).toEqual([]);
  });

  it('rejects a package whose activation probe cannot run in scriptRuntime', async () => {
    const service = createService();
    const source = await writePackage('broken-probe', {
      source: entrySource('broken-probe', `throw new Error('探针故障');`),
    });

    await expect(service.stage(source)).rejects.toThrow(/沙箱校验没通过.*探针故障/);
    expect(await fs.readdir(pluginsDir)).toEqual([]);
  });

  it('enforces declared permissions during the sandbox probe', async () => {
    const service = createService();
    const source = await writePackage('permission-gap', {
      source: entrySource('permission-gap').replace(
        "permissionLevel: 'read'",
        "permissionLevel: 'network'",
      ),
    });

    await expect(service.stage(source)).rejects.toThrow(/需要在 permissions 声明 network/);
  });

  it('enforces permissions again in the live registry even if a probe result is forged', async () => {
    const service = createService({
      runSandbox: async () => ({ ok: true, result: { toolNames: ['ping'] } }),
    });
    const source = await writePackage('runtime-permission-gap', {
      source: entrySource('runtime-permission-gap').replace(
        "permissionLevel: 'read'",
        "permissionLevel: 'network'",
      ),
    });

    const preview = await service.stage(source);
    await expect(service.confirm(preview.token)).rejects.toThrow(/必须声明 'network' 权限/);
    expect(hasProtocolTool('runtime-permission-gap:ping')).toBe(false);
    expect(lifecycle.map((entry) => entry.action)).toEqual(['failed', 'rolled_back']);
  });

  it('installs only with a validated stage token, records load/unload, and exposes the tool next turn', async () => {
    const service = createService();
    const source = await writePackage('approved-cap');

    await expect(service.confirm('bypass-without-stage')).rejects.toThrow('导入确认已过期');
    const preview = await service.stage(source);
    const installed = await service.confirm(preview.token);

    expect(installed.toolNames).toEqual(['approved-cap:ping']);
    expect(hasProtocolTool('approved-cap:ping')).toBe(true);
    expect(lifecycle.map((entry) => entry.action)).toEqual(['loaded']);
    expect((await service.list()).find((item) => item.id === 'approved-cap')).toMatchObject({
      id: 'approved-cap',
      state: 'active',
    });

    await service.uninstall('approved-cap');
    expect(hasProtocolTool('approved-cap:ping')).toBe(false);
    expect(lifecycle.map((entry) => entry.action)).toEqual(['loaded', 'unloaded']);
  });

  it('restores the prior version and records the rollback when replacement activation fails', async () => {
    const service = createService();
    const firstSource = await writePackage('rollback-cap');
    const firstPreview = await service.stage(firstSource);
    await service.confirm(firstPreview.token);

    const replacementSource = await writePackage('rollback-cap', {
      manifest: manifest('rollback-cap', { version: '2.0.0' }),
      source: entrySource('rollback-cap', `
        if (api.metadata.version === '2.0.0') throw new Error('真实激活失败');
      `),
    });
    const preview = await service.stage(replacementSource);

    expect(preview.replacesInstalledVersion).toBe('1.0.0');
    await expect(service.confirm(preview.token)).rejects.toThrow('真实激活失败');
    expect(hasProtocolTool('rollback-cap:ping')).toBe(true);
    expect((await service.list()).find((item) => item.id === 'rollback-cap')).toMatchObject({
      id: 'rollback-cap',
      version: '1.0.0',
      state: 'active',
    });
    expect(JSON.parse(await fs.readFile(path.join(pluginsDir, 'rollback-cap', 'plugin.json'), 'utf8')))
      .toMatchObject({ version: '1.0.0' });
    expect(lifecycle.map((entry) => entry.action)).toEqual(['loaded', 'failed', 'rolled_back']);
  });

  it('rejects a direct filesystem install that bypasses validation and approval', async () => {
    const direct = await writePackage('direct-bypass');
    const target = path.join(pluginsDir, 'direct-bypass');
    await fs.cp(direct, target, { recursive: true });

    const result = await loadPlugin(target);
    expect(result.success).toBe(false);
    expect(result.error).toContain('缺少安装审批凭据');
    expect(hasProtocolTool('direct-bypass:ping')).toBe(false);
  });

  it('installs and uninstalls bundled Computer Use through the disclosure lifecycle', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const serverStates = new Map<string, MCPServerConfig>();
    const mcpConfig: MCPServerConfig = {
      name: 'cua-driver',
      type: 'stdio',
      command: 'cua-driver',
      args: ['mcp'],
      enabled: true,
    };
    const service = createService({
      computerUseStateDir: () => tempRoot,
      mcpClient: {
        getServerState: (name) => serverStates.get(name),
        addServer: (config) => { serverStates.set(config.name, config); },
        removeServer: async (name) => { serverStates.delete(name); },
      },
      resolveComputerUseMcpConfig: () => mcpConfig,
    });
    try {
      const available = (await service.list()).find((item) => item.id === 'builtin.computerUse');
      expect(available).toMatchObject({ state: 'available' });

      const preview = await service.stageBundled('builtin.computerUse');
      expect(preview).toMatchObject({
        sourceKind: 'bundled',
        permissions: expect.arrayContaining(['accessibility', 'screen-recording']),
      });
      await service.confirm(preview.token);

      expect(registry.getPlugin('builtin.computerUse')?.state).toBe('active');
      expect(serverStates.has('cua-driver')).toBe(true);
      expect(await readBuiltinCapabilityState(COMPUTER_USE_CAPABILITY_ID, tempRoot)).toBe('installed');
      expect(lifecycle.map((entry) => entry.action)).toEqual(['loaded']);

      await service.uninstall('builtin.computerUse');
      expect(registry.getPlugin('builtin.computerUse')).toBeUndefined();
      expect(serverStates.has('cua-driver')).toBe(false);
      expect(await readBuiltinCapabilityState(COMPUTER_USE_CAPABILITY_ID, tempRoot)).toBe('removed');
      expect(lifecycle.map((entry) => entry.action)).toEqual(['loaded', 'unloaded']);
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('rolls back bundled Computer Use when cua-driver cannot be registered', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const service = createService({
      computerUseStateDir: () => tempRoot,
      mcpClient: {
        getServerState: () => undefined,
        addServer: () => undefined,
        removeServer: async () => undefined,
      },
      resolveComputerUseMcpConfig: () => undefined,
    });
    try {
      const preview = await service.stageBundled('builtin.computerUse');
      await expect(service.confirm(preview.token)).rejects.toThrow('cua-driver 在当前平台不可用');
      expect(registry.getPlugin('builtin.computerUse')).toBeUndefined();
      expect(await readBuiltinCapabilityState(COMPUTER_USE_CAPABILITY_ID, tempRoot)).toBe('missing');
      expect(lifecycle.map((entry) => entry.action)).toEqual(['failed', 'rolled_back']);
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });
});
