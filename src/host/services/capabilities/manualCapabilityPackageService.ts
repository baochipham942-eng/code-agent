import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'acorn';
import { extractZipSafely } from '../../skills/marketplace/githubArchiveSecurity';
import { runScriptInSandbox, type RunSandboxOptions, type WorkerOutcome } from '../../agent/scriptRuntime/sandbox';
import { validateScript } from '../../agent/scriptRuntime/scriptValidator';
import { getPluginRegistry, type PluginRegistry } from '../../plugins/pluginRegistry';
import { getPluginsDir, PLUGIN_MANIFEST_FILES, readPluginManifest } from '../../plugins/pluginLoader';
import { validatePlugin } from '../../plugins/pluginValidator';
import { BUILTIN_PLUGIN_CATALOG, findBuiltinPlugin } from '../../plugins/builtin/catalog';
import {
  COMPUTER_USE_CAPABILITY_ID,
  isBuiltinCapabilityId,
  type BuiltinCapabilityId,
} from '../../plugins/builtin/builtinCapabilityIds';
import {
  readBuiltinCapabilityState,
  writeBuiltinCapabilityState,
} from '../../plugins/builtin/computerUse/installState';
import { getDefaultMCPServers } from '../../mcp/mcpDefaultServers';
import { getMCPClient } from '../../mcp/mcpClient';
import { CUA_DRIVER_SERVER_NAME, type MCPServerConfig } from '../../mcp/types';
import {
  hashPluginPackage,
  verifyPluginApprovalReceipt,
  writePluginApprovalReceipt,
} from '../../plugins/pluginApprovalReceipt';
import type { PluginManifest, PluginPermission } from '../../plugins/types';
import { validatePluginCapabilityDeclaration } from '../../plugins/pluginCapabilitySurface';
import type {
  CapabilityPackageInstallResult,
  CapabilityPackagePreview,
  InstalledCapabilityPackage,
} from '../../../shared/contract/capabilityPackage';
import { recordCapabilityPackageLifecycle } from './capabilityPackageLifecycle';

const STAGE_TTL_MS = 10 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_ENTRY_BYTES = 48 * 1024;
const MANUAL_PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;

interface StagedPackage {
  token: string;
  rootDir: string;
  ownedTempDir?: string;
  manifest: PluginManifest;
  packageHash: string;
  sourceKind: CapabilityPackagePreview['sourceKind'];
  sourceLabel: string;
  toolNames: string[];
  replacesInstalledVersion?: string;
  stagedAt: number;
  expiresAt: number;
}

interface StagedBundledPackage {
  token: string;
  pluginId: BuiltinCapabilityId;
  expiresAt: number;
}

type RegistryPort = Pick<PluginRegistry,
  'getPlugin' | 'getPlugins' | 'pauseWatching' | 'resumeWatching'
  | 'installPluginFromDirectory' | 'removePluginFromRegistry'
  | 'validatePluginCapabilityManifest'
  | 'installBuiltinCapability' | 'removeBuiltinCapability'>;

interface MCPClientPort {
  getServerState: (name: string) => unknown;
  addServer: (config: MCPServerConfig) => void;
  removeServer: (name: string) => Promise<void>;
}

type SandboxRunner = (options: RunSandboxOptions) => Promise<WorkerOutcome>;

interface ManualCapabilityPackageServiceDependencies {
  pluginsDir?: () => string;
  registry?: RegistryPort;
  runSandbox?: SandboxRunner;
  useOsSandbox?: boolean;
  now?: () => number;
  lifecycle?: typeof recordCapabilityPackageLifecycle;
  computerUseStateDir?: () => string | undefined;
  mcpClient?: MCPClientPort;
  resolveComputerUseMcpConfig?: () => MCPServerConfig | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasManifestFile(entries: readonly string[]): boolean {
  return PLUGIN_MANIFEST_FILES.some((filename) => entries.includes(filename));
}

async function locatePackageRoot(initialDir: string): Promise<string> {
  let current = initialDir;
  for (let depth = 0; depth < 4; depth += 1) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    if (hasManifestFile(entries.map((entry) => entry.name))) return current;
    const visibleDirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
    if (visibleDirs.length !== 1) break;
    current = path.join(current, visibleDirs[0].name);
  }
  throw new Error('插件里找不到 plugin.json、manifest.json 或 package.json');
}

async function readRawManifest(rootDir: string): Promise<Record<string, unknown>> {
  for (const filename of PLUGIN_MANIFEST_FILES) {
    try {
      const value = JSON.parse(await fs.readFile(path.join(rootDir, filename), 'utf8')) as unknown;
      if (!isRecord(value)) throw new Error('清单内容必须是 JSON 对象');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if (error instanceof SyntaxError) {
        throw new Error(`插件清单 ${filename} 不是合法 JSON`, { cause: error });
      }
      throw error;
    }
  }
  throw new Error('插件缺少清单文件');
}

function requireString(manifest: Record<string, unknown>, field: string, label: string): string {
  const value = manifest[field];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`插件清单缺少${label}（${field}）`);
  return value.trim();
}

function validateStrictManifest(raw: Record<string, unknown>): void {
  const id = requireString(raw, 'id', '能力 ID');
  requireString(raw, 'name', '能力名称');
  requireString(raw, 'description', '能力说明');
  const version = requireString(raw, 'version', '版本号');
  requireString(raw, 'main', '入口文件');
  if (!MANUAL_PLUGIN_ID.test(id)) {
    throw new Error('能力 ID 只能用小写字母、数字、点、下划线和短横线，最长 64 个字符');
  }
  if (!SEMVER.test(version)) throw new Error('版本号需使用 1.2.3 这样的格式');
  const capabilityIssue = validatePluginCapabilityDeclaration(raw)[0];
  if (capabilityIssue) {
    const label = capabilityIssue.field === 'depends' ? '依赖声明' : '能力声明';
    throw new Error(`${label}不合规：${capabilityIssue.message}`);
  }
  if (!Array.isArray(raw.permissions)) throw new Error('插件清单必须声明 permissions 权限列表，可以是空数组');
  if (!Array.isArray(raw.surfaces) || raw.surfaces.length !== 1) {
    throw new Error('插件只能声明一个 surface');
  }
  if (raw.surfaces[0] === 'internal-feature') {
    if (raw.distribution !== 'internal' || raw.adminOnly !== true) {
      throw new Error('内部插件必须声明 distribution=internal 且 adminOnly=true');
    }
    return;
  }
  if (raw.surfaces[0] !== 'tools') {
    throw new Error('可执行插件的 surfaces 只能声明 tools；内部包可声明 internal-feature');
  }
}

function describeValidationError(field: string, message: string): string {
  if (field === 'main') return `入口文件不合规：${message}`;
  if (field === 'permissions') return `权限声明不合规：${message}`;
  if (field === 'surfaces') return `能力类型声明不合规：${message}`;
  return `${field} 不合规：${message}`;
}

function assertNoAmbientAuthority(source: string): void {
  let ast: unknown;
  try {
    ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: false });
  } catch (error) {
    throw new Error(`入口代码无法按 CommonJS 解析：${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const blocked = new Set(['require', 'process', 'global', 'globalThis', 'fetch', 'WebSocket', 'eval', 'Function', 'console']);
  const visit = (node: unknown, parent?: Record<string, unknown>, parentKey?: string): void => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record.type === 'ImportExpression' || record.type === 'ImportDeclaration') {
      throw new Error('入口代码不能直接加载模块；请只使用宿主提供的能力 API');
    }
    if (record.type === 'Identifier' && typeof record.name === 'string' && blocked.has(record.name)) {
      const isPropertyName = parent?.type === 'MemberExpression' && parentKey === 'property' && parent.computed === false;
      const isObjectKey = parent?.type === 'Property' && parentKey === 'key' && parent.computed === false;
      if (!isPropertyName && !isObjectKey) {
        throw new Error(`入口代码使用了未授权的全局对象 ${record.name}`);
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === 'type') continue;
      if (Array.isArray(value)) value.forEach((item) => visit(item, record, key));
      else visit(value, record, key);
    }
  };
  visit(ast);
}

function sandboxProbeScript(
  source: string,
  permissions: readonly PluginPermission[],
  requireTool: boolean,
): string {
  const prefix = `
const module = { exports: {} };
const exports = module.exports;
`;
  const suffix = `
const entry = module.exports && module.exports.default ? module.exports.default : module.exports;
if (!entry || typeof entry.activate !== 'function') throw new Error('入口必须导出 activate(api)');
const declared = new Set(${JSON.stringify(permissions)});
const toolNames = [];
const requirePermission = (permission, operation) => {
  if (!declared.has(permission)) throw new Error(operation + ' 需要在 permissions 声明 ' + permission);
};
const checkLegacyTool = (tool) => {
  if (!tool || typeof tool.name !== 'string' || !tool.name.trim()) throw new Error('registerTool 缺少工具名');
  if (typeof tool.execute !== 'function') throw new Error('工具 ' + tool.name + ' 缺少 execute');
  if (tool.permissionLevel === 'write') requirePermission('filesystem', '工具 ' + tool.name);
  if (tool.permissionLevel === 'execute') requirePermission('shell', '工具 ' + tool.name);
  if (tool.permissionLevel === 'network') requirePermission('network', '工具 ' + tool.name);
  toolNames.push(tool.name);
};
const checkToolModule = (toolModule) => {
  const schema = toolModule && toolModule.schema;
  if (!schema || typeof schema.name !== 'string' || !schema.name.trim()) throw new Error('registerToolModule 缺少工具名');
  if (typeof toolModule.createHandler !== 'function') throw new Error('工具 ' + schema.name + ' 缺少 createHandler');
  if (schema.category === 'fs') requirePermission('filesystem', '工具 ' + schema.name);
  if (schema.category === 'shell') requirePermission('shell', '工具 ' + schema.name);
  if (schema.category === 'network') requirePermission('network', '工具 ' + schema.name);
  toolNames.push(schema.name);
};
const storage = new Map();
const api = Object.freeze({
  metadata: Object.freeze({}),
  pluginApiVersion: 2,
  registerTool: checkLegacyTool,
  unregisterTool: () => undefined,
  registerToolModule: checkToolModule,
  log: () => undefined,
  getStorage: () => {
    requirePermission('storage', '本地存储');
    return {
      get: async (key) => storage.get(key),
      set: async (key, value) => { storage.set(key, value); },
      delete: async (key) => { storage.delete(key); },
      clear: async () => { storage.clear(); },
    };
  },
  showNotification: () => requirePermission('notification', '系统通知'),
  getApiKey: async () => { requirePermission('network', '读取服务凭据'); return undefined; },
  getCurrentUser: () => null,
  getConstants: () => Object.freeze({}),
});
await entry.activate(api);
if (${JSON.stringify(requireTool)} && toolNames.length === 0) throw new Error('插件没有注册任何工具');
return { toolNames: [...new Set(toolNames)].sort() };
`;
  return `${prefix}${source}\n${suffix}`;
}

async function copyPackage(sourceDir: string, destinationDir: string): Promise<void> {
  await hashPluginPackage(sourceDir);
  await fs.cp(sourceDir, destinationDir, { recursive: true, errorOnExist: true, force: false });
}

export class ManualCapabilityPackageService {
  private readonly staged = new Map<string, StagedPackage>();
  private readonly stagedBundled = new Map<string, StagedBundledPackage>();
  private readonly getPluginsDir: () => string;
  private readonly registry: RegistryPort;
  private readonly runSandbox: SandboxRunner;
  private readonly useOsSandbox: boolean | undefined;
  private readonly now: () => number;
  private readonly lifecycle: typeof recordCapabilityPackageLifecycle;
  private readonly builtinStateDir: () => string | undefined;
  private readonly mcpClient: MCPClientPort;
  private readonly resolveComputerUseMcpConfig: () => MCPServerConfig | undefined;

  constructor(dependencies: ManualCapabilityPackageServiceDependencies = {}) {
    this.getPluginsDir = dependencies.pluginsDir ?? getPluginsDir;
    this.registry = dependencies.registry ?? getPluginRegistry();
    this.runSandbox = dependencies.runSandbox ?? runScriptInSandbox;
    this.useOsSandbox = dependencies.useOsSandbox;
    this.now = dependencies.now ?? Date.now;
    this.lifecycle = dependencies.lifecycle ?? recordCapabilityPackageLifecycle;
    this.builtinStateDir = dependencies.computerUseStateDir ?? (() => undefined);
    this.mcpClient = dependencies.mcpClient ?? getMCPClient();
    this.resolveComputerUseMcpConfig = dependencies.resolveComputerUseMcpConfig ?? (() => (
      getDefaultMCPServers().find((server) => server.name === CUA_DRIVER_SERVER_NAME)
    ));
  }

  async stageBundled(pluginId: string): Promise<CapabilityPackagePreview> {
    await this.pruneExpired();
    const descriptor = findBuiltinPlugin(pluginId);
    if (!descriptor) throw new Error('找不到可安装的内置插件');
    if (pluginId === COMPUTER_USE_CAPABILITY_ID && process.platform !== 'darwin') {
      throw new Error('Computer Use 插件当前只支持 macOS');
    }
    if (this.registry.getPlugin(pluginId)) throw new Error(`${descriptor.manifest.name} 插件已经安装`);

    const token = randomUUID();
    const expiresAt = this.now() + STAGE_TTL_MS;
    this.stagedBundled.set(token, { token, pluginId: descriptor.manifest.id, expiresAt });
    return {
      token,
      id: descriptor.manifest.id,
      name: descriptor.manifest.name,
      version: descriptor.manifest.version,
      description: descriptor.manifest.description ?? '',
      permissions: descriptor.manifest.permissions ?? [],
      toolNames: [...descriptor.previewToolNames],
      surface: 'tools',
      sourceKind: 'bundled',
      sourceLabel: 'Agent Neo',
      sandbox: { passed: true, summary: '随 Neo 签名发货的内置能力已通过完整性校验' },
      expiresAt,
    };
  }

  async stage(selectedPath: string): Promise<CapabilityPackagePreview> {
    await this.pruneExpired();
    const selectedStat = await fs.stat(selectedPath).catch(() => null);
    if (!selectedStat) throw new Error('选择的插件已经不存在');
    let rootDir: string;
    let ownedTempDir: string | undefined;
    let sourceKind: CapabilityPackagePreview['sourceKind'];
    if (selectedStat.isDirectory()) {
      rootDir = selectedPath;
      sourceKind = 'directory';
    } else if (PLUGIN_MANIFEST_FILES.includes(path.basename(selectedPath) as (typeof PLUGIN_MANIFEST_FILES)[number])) {
      rootDir = path.dirname(selectedPath);
      sourceKind = 'manifest';
    } else if (path.extname(selectedPath).toLowerCase() === '.zip') {
      const archive = await fs.readFile(selectedPath);
      if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error('插件超过 50 MB，已拒绝');
      ownedTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-capability-stage-'));
      try {
        await extractZipSafely(archive, ownedTempDir);
        rootDir = await locatePackageRoot(ownedTempDir);
      } catch (error) {
        await fs.rm(ownedTempDir, { recursive: true, force: true });
        throw error;
      }
      sourceKind = 'zip';
    } else {
      throw new Error('请选择插件目录、清单文件或 .zip 文件');
    }

    try {
      rootDir = await locatePackageRoot(rootDir);
      const raw = await readRawManifest(rootDir);
      validateStrictManifest(raw);
      const manifestValidation = await validatePlugin(rootDir, raw);
      if (!manifestValidation.valid) {
        throw new Error(manifestValidation.errors.map((item) => describeValidationError(item.field, item.message)).join('；'));
      }
      const manifest = await readPluginManifest(rootDir);
      if (!manifest) throw new Error('插件清单无法读取');
      try {
        this.registry.validatePluginCapabilityManifest(manifest);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.lifecycle(manifest.id, 'failed', detail);
        throw new Error(`插件依赖校验没通过：${detail}`, { cause: error });
      }
      const entryPath = path.join(rootDir, manifest.main);
      const source = await fs.readFile(entryPath, 'utf8');
      if (Buffer.byteLength(source, 'utf8') > MAX_ENTRY_BYTES) throw new Error('入口代码超过 48 KB，已拒绝');
      if (!/module\s*\.\s*exports/.test(source)) throw new Error('当前只支持 CommonJS 插件，入口需使用 module.exports');
      assertNoAmbientAuthority(source);
      const surface = manifest.surfaces?.[0] === 'internal-feature' ? 'internal-feature' : 'tools';
      const probeScript = sandboxProbeScript(source, manifest.permissions ?? [], surface === 'tools');
      const validation = validateScript(probeScript);
      if (!validation.ok) throw new Error(`沙箱校验没通过：${validation.error}`);
      const probe = await this.runSandbox({
        script: probeScript,
        signal: new AbortController().signal,
        timeoutMs: 3_000,
        cpuTimeLimitMs: 1_000,
        cpuPollIntervalMs: 100,
        maxOldGenMb: 64,
        useOsSandbox: this.useOsSandbox,
        onRpc: async (request) => ({ id: request.id, ok: false, error: '插件探针不允许调用宿主原语' }),
      });
      if (!probe.ok || !isRecord(probe.result) || !Array.isArray(probe.result.toolNames)) {
        throw new Error(`沙箱校验没通过：${probe.error ?? '入口探针没有返回工具清单'}`);
      }
      const toolNames = probe.result.toolNames.filter((item): item is string => typeof item === 'string');
      if (surface === 'tools' && toolNames.length === 0) throw new Error('沙箱校验没通过：插件没有注册工具');
      const packageHash = await hashPluginPackage(rootDir);
      const token = randomUUID();
      const stagedAt = this.now();
      const expiresAt = stagedAt + STAGE_TTL_MS;
      const existing = this.registry.getPlugin(manifest.id);
      const staged: StagedPackage = {
        token,
        rootDir,
        ownedTempDir,
        manifest,
        packageHash,
        sourceKind,
        sourceLabel: path.basename(selectedPath),
        toolNames,
        ...(existing && !existing.rootPath.startsWith('builtin:')
          ? { replacesInstalledVersion: existing.manifest.version }
          : {}),
        stagedAt,
        expiresAt,
      };
      this.staged.set(token, staged);
      return {
        token,
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description ?? '',
        permissions: manifest.permissions ?? [],
        toolNames,
        surface,
        sourceKind,
        sourceLabel: staged.sourceLabel,
        ...(staged.replacesInstalledVersion ? { replacesInstalledVersion: staged.replacesInstalledVersion } : {}),
        sandbox: {
          passed: true,
          summary: surface === 'internal-feature'
            ? '隔离进程试跑通过，内部界面声明有效'
            : `隔离进程试跑通过，发现 ${toolNames.length} 个工具`,
        },
        expiresAt,
      };
    } catch (error) {
      if (ownedTempDir) await fs.rm(ownedTempDir, { recursive: true, force: true });
      throw error;
    }
  }

  async getStagedPackageSource(token: string): Promise<'bundled' | 'local' | null> {
    await this.pruneExpired();
    if (this.stagedBundled.has(token)) return 'bundled';
    if (this.staged.has(token)) return 'local';
    return null;
  }

  async getInstalledPackageSource(pluginId: string): Promise<'bundled' | 'local' | null> {
    if (isBuiltinCapabilityId(pluginId)) return 'bundled';
    const plugin = this.registry.getPlugin(pluginId);
    if (!plugin || plugin.rootPath.startsWith('builtin:')) return null;
    try {
      await verifyPluginApprovalReceipt(plugin.rootPath, plugin.manifest.id, plugin.manifest.permissions ?? []);
      return 'local';
    } catch {
      return null;
    }
  }

  async confirm(token: string): Promise<CapabilityPackageInstallResult> {
    await this.pruneExpired();
    const bundled = this.stagedBundled.get(token);
    if (bundled) return this.confirmBundled(bundled);
    const staged = this.staged.get(token);
    if (!staged) throw new Error('导入确认已过期，请重新选择插件');
    const pluginsDir = this.getPluginsDir();
    await fs.mkdir(pluginsDir, { recursive: true });
    const installTemp = path.join(pluginsDir, `.install-${staged.manifest.id}-${token}`);
    const targetDir = path.join(pluginsDir, staged.manifest.id);
    const backupDir = path.join(pluginsDir, `.backup-${staged.manifest.id}-${token}`);
    let hadBackup = false;
    const watcherWasActive = this.registry.pauseWatching();
    try {
      await copyPackage(staged.rootDir, installTemp);
      const copiedHash = await hashPluginPackage(installTemp);
      if (copiedHash !== staged.packageHash) throw new Error('插件在确认前发生变化，请重新导入');
      await writePluginApprovalReceipt(installTemp, {
        pluginId: staged.manifest.id,
        packageHash: copiedHash,
        permissions: staged.manifest.permissions ?? [],
        sandboxValidatedAt: staged.stagedAt,
        approvedAt: this.now(),
      });
      try {
        await fs.rename(targetDir, backupDir);
        hadBackup = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await fs.rename(installTemp, targetDir);
      const installed = await this.registry.installPluginFromDirectory(targetDir);
      if (!installed.success) throw new Error(installed.error ?? '插件激活失败');
      if (hadBackup) await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
      this.lifecycle(staged.manifest.id, 'loaded', `version=${staged.manifest.version}; tools=${staged.toolNames.join(',')}`);
      return {
        id: staged.manifest.id,
        version: staged.manifest.version,
        toolNames: staged.toolNames.map((name) => `${staged.manifest.id}:${name}`),
        surface: staged.manifest.surfaces?.[0] === 'internal-feature' ? 'internal-feature' : 'tools',
        ...(staged.replacesInstalledVersion ? { replacedVersion: staged.replacesInstalledVersion } : {}),
      };
    } catch (error) {
      await fs.rm(targetDir, { recursive: true, force: true });
      if (hadBackup) await fs.rename(backupDir, targetDir).catch(() => undefined);
      await fs.rm(installTemp, { recursive: true, force: true });
      const detail = error instanceof Error ? error.message : String(error);
      this.lifecycle(staged.manifest.id, 'failed', detail);
      this.lifecycle(staged.manifest.id, 'rolled_back', hadBackup ? 'restored previous package' : 'removed rejected package');
      throw error;
    } finally {
      if (watcherWasActive) this.registry.resumeWatching();
      await this.discard(token);
    }
  }

  private async confirmBundled(staged: StagedBundledPackage): Promise<CapabilityPackageInstallResult> {
    const descriptor = findBuiltinPlugin(staged.pluginId);
    if (!descriptor) throw new Error('找不到可安装的内置插件');
    const dataDir = this.builtinStateDir();
    const previousState = await readBuiltinCapabilityState(staged.pluginId, dataDir);
    let mcpAdded = false;
    try {
      await writeBuiltinCapabilityState(staged.pluginId, 'installed', { dataDir });
      if (!await this.registry.installBuiltinCapability(staged.pluginId)) {
        throw new Error(`${descriptor.manifest.name} 插件激活失败`);
      }
      if (staged.pluginId === COMPUTER_USE_CAPABILITY_ID) {
        const mcpConfig = this.resolveComputerUseMcpConfig();
        if (!mcpConfig?.enabled) throw new Error('cua-driver 在当前平台不可用');
        if (!this.mcpClient.getServerState(CUA_DRIVER_SERVER_NAME)) {
          this.mcpClient.addServer({ ...mcpConfig, scope: 'builtin' });
          mcpAdded = true;
        }
      }
      const plugin = this.registry.getPlugin(staged.pluginId);
      const toolNames = [
        ...(staged.pluginId === COMPUTER_USE_CAPABILITY_ID ? [CUA_DRIVER_SERVER_NAME] : []),
        ...(plugin?.registeredTools ?? []),
      ];
      this.lifecycle(staged.pluginId, 'loaded', `version=${descriptor.manifest.version}`);
      return { id: staged.pluginId, version: descriptor.manifest.version, toolNames, surface: 'tools' };
    } catch (error) {
      if (mcpAdded) await this.mcpClient.removeServer(CUA_DRIVER_SERVER_NAME).catch(() => undefined);
      await this.registry.removeBuiltinCapability(staged.pluginId).catch(() => false);
      const rollbackState = previousState === 'installed' ? 'installed'
        : previousState === 'missing' ? 'missing' : 'removed';
      await writeBuiltinCapabilityState(staged.pluginId, rollbackState, { dataDir }).catch(() => undefined);
      const detail = error instanceof Error ? error.message : String(error);
      this.lifecycle(staged.pluginId, 'failed', detail);
      this.lifecycle(staged.pluginId, 'rolled_back', 'removed rejected bundled capability');
      throw error;
    } finally {
      await this.discard(staged.token);
    }
  }

  async list(): Promise<InstalledCapabilityPackage[]> {
    const result: InstalledCapabilityPackage[] = BUILTIN_PLUGIN_CATALOG.map((descriptor) => {
      const plugin = this.registry.getPlugin(descriptor.manifest.id);
      return {
        id: descriptor.manifest.id,
        name: descriptor.manifest.name,
        version: descriptor.manifest.version,
        description: descriptor.manifest.description ?? '',
        permissions: descriptor.manifest.permissions ?? [],
        state: plugin?.state ?? 'available',
        surface: 'tools',
        toolNames: plugin
          ? [
            ...(descriptor.manifest.id === COMPUTER_USE_CAPABILITY_ID ? [CUA_DRIVER_SERVER_NAME] : []),
            ...plugin.registeredTools,
          ]
          : [],
        ...(plugin?.error ? { error: plugin.error } : {}),
      };
    });
    for (const plugin of this.registry.getPlugins()) {
      if (plugin.rootPath.startsWith('builtin:')) continue;
      try {
        await verifyPluginApprovalReceipt(plugin.rootPath, plugin.manifest.id, plugin.manifest.permissions ?? []);
      } catch {
        continue;
      }
      result.push({
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        description: plugin.manifest.description ?? '',
        permissions: plugin.manifest.permissions ?? [],
        state: plugin.state,
        toolNames: [...plugin.registeredTools],
        surface: plugin.manifest.surfaces?.[0] === 'internal-feature' ? 'internal-feature' : 'tools',
        ...(plugin.manifest.internalFeature ? { internalFeature: plugin.manifest.internalFeature } : {}),
        ...(plugin.error ? { error: plugin.error } : {}),
      });
    }
    return result.sort((left, right) => left.name.localeCompare(right.name));
  }

  async uninstall(pluginId: string): Promise<void> {
    if (isBuiltinCapabilityId(pluginId)) {
      await this.uninstallBundledCapability(pluginId);
      return;
    }
    const plugin = this.registry.getPlugin(pluginId);
    if (!plugin || plugin.rootPath.startsWith('builtin:')) throw new Error('找不到可卸载的手动插件');
    await verifyPluginApprovalReceipt(plugin.rootPath, plugin.manifest.id, plugin.manifest.permissions ?? []);
    const backupDir = path.join(this.getPluginsDir(), `.uninstall-${pluginId}-${randomUUID()}`);
    const watcherWasActive = this.registry.pauseWatching();
    try {
      if (!await this.registry.removePluginFromRegistry(pluginId)) throw new Error('插件运行时卸载失败');
      await fs.rename(plugin.rootPath, backupDir);
      this.lifecycle(pluginId, 'unloaded', `version=${plugin.manifest.version}`);
      await fs.rm(backupDir, { recursive: true, force: true });
    } catch (error) {
      const targetExists = await fs.stat(plugin.rootPath).then(() => true, () => false);
      if (!targetExists) await fs.rename(backupDir, plugin.rootPath).catch(() => undefined);
      await this.registry.installPluginFromDirectory(plugin.rootPath).catch(() => undefined);
      this.lifecycle(pluginId, 'failed', error instanceof Error ? error.message : String(error));
      this.lifecycle(pluginId, 'rolled_back', 'uninstall failed; restored package');
      throw error;
    } finally {
      if (watcherWasActive) this.registry.resumeWatching();
    }
  }

  private async uninstallBundledCapability(pluginId: BuiltinCapabilityId): Promise<void> {
    const descriptor = findBuiltinPlugin(pluginId);
    if (!descriptor) throw new Error('找不到可卸载的内置插件');
    const plugin = this.registry.getPlugin(pluginId);
    if (plugin?.rootPath !== `builtin:${pluginId}`) {
      throw new Error(`${descriptor.manifest.name} 插件尚未安装`);
    }
    const dataDir = this.builtinStateDir();
    const previousState = await readBuiltinCapabilityState(pluginId, dataDir);
    const mcpConfig = this.resolveComputerUseMcpConfig();
    const hadMcp = pluginId === COMPUTER_USE_CAPABILITY_ID
      && Boolean(this.mcpClient.getServerState(CUA_DRIVER_SERVER_NAME));
    try {
      if (hadMcp) await this.mcpClient.removeServer(CUA_DRIVER_SERVER_NAME);
      if (!await this.registry.removeBuiltinCapability(pluginId)) {
        throw new Error(`${descriptor.manifest.name} 插件运行时卸载失败`);
      }
      await writeBuiltinCapabilityState(pluginId, 'removed', { dataDir });
      this.lifecycle(pluginId, 'unloaded', `version=${descriptor.manifest.version}`);
    } catch (error) {
      await writeBuiltinCapabilityState(
        pluginId,
        previousState === 'missing' ? 'missing' : previousState === 'installed' ? 'installed' : 'removed',
        { dataDir },
      ).catch(() => undefined);
      await this.registry.installBuiltinCapability(pluginId).catch(() => false);
      if (hadMcp && mcpConfig && !this.mcpClient.getServerState(CUA_DRIVER_SERVER_NAME)) {
        this.mcpClient.addServer({ ...mcpConfig, enabled: true, scope: 'builtin' });
      }
      this.lifecycle(pluginId, 'rolled_back', 'uninstall failed; restored bundled capability');
      throw error;
    }
  }

  async discard(token: string): Promise<void> {
    const staged = this.staged.get(token);
    this.staged.delete(token);
    this.stagedBundled.delete(token);
    if (staged?.ownedTempDir) await fs.rm(staged.ownedTempDir, { recursive: true, force: true });
  }

  private async pruneExpired(): Promise<void> {
    const now = this.now();
    for (const staged of [...this.staged.values()]) {
      if (staged.expiresAt <= now) await this.discard(staged.token);
    }
    for (const staged of [...this.stagedBundled.values()]) {
      if (staged.expiresAt <= now) await this.discard(staged.token);
    }
  }
}

let service: ManualCapabilityPackageService | null = null;

export function getManualCapabilityPackageService(): ManualCapabilityPackageService {
  service ??= new ManualCapabilityPackageService();
  return service;
}
