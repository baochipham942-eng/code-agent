// ============================================================================
// Agent Registry - 自定义 Agent 注册中心（builtin + user + project 合并）
// ============================================================================
//
// 设计要点：
// 1. Double-buffer Map：所有热加载操作构造新 Map → 原子替换指针，
//    任何 in-flight spawn 都不可能看到半填充状态。
// 2. 合并优先级：project > user > builtin（同 id 后者覆盖前者）。
// 3. 内部仍保留 CORE_AGENTS 作为 builtin 真理源（getBuiltinAgent 回退入口）。
// 4. chokidar 监听 user / project 两个目录，debounce 200ms 后全量重扫。
// 5. 启动时由 initAgentRegistry(workingDir) 完成首次扫描，
//    退出时由 disposeAgentRegistry() 释放 watcher。
//
// 调用方：
// - agentDefinition.getPredefinedAgent → resolveAgent
// - spawnAgent / task 错误信息 → listAllAgents
// - CLI list-agents → listAllAgents
// - IPC agents:list / agents:changed → listAllAgents + onAgentRegistryChange
// ============================================================================

import { EventEmitter } from 'events';
import * as path from 'path';
import chokidar from 'chokidar';
import { getAgentsMdDir } from '../config/configPaths';
import { loadAgentMdFiles } from './hybrid/agentMdLoader';
import { CORE_AGENTS, CORE_AGENT_IDS, isCoreAgent } from './hybrid/coreAgents';
import type { CoreAgentConfig } from './hybrid/types';
import { createLogger } from '../services/infra/logger';
import type { AgentSource, AgentListEntry } from '../../shared/contract/agentRegistry';
import { listPersistentRoles } from '../services/roleAssets/roleAssetService';
import { getBuiltinRoleVisual } from '../services/roleAssets/builtinRoles';
import { isProjectConfigTrusted } from '../security/folderTrustService';

const logger = createLogger('AgentRegistry');

// ----------------------------------------------------------------------------
// 类型
// ----------------------------------------------------------------------------

export type { AgentSource, AgentListEntry };

export interface RegisteredAgent extends CoreAgentConfig {
  source: AgentSource;
}

// ----------------------------------------------------------------------------
// 内部状态
// ----------------------------------------------------------------------------

/**
 * Custom agent map（user + project 合并后的快照）。
 *
 * 关键：所有变更都是"构造新 Map → 一行赋值"——getter 拿到的指针要么完整旧，
 * 要么完整新，永远不可能是半填充状态。
 */
let customAgentMap: Map<string, RegisteredAgent> = new Map();

let watcher: ReturnType<typeof chokidar.watch> | null = null;
let reloadTimer: NodeJS.Timeout | null = null;
let currentWorkingDir: string | undefined;

const events = new EventEmitter();

// debounce 时长（ms）—— 文件保存后等一下，避免编辑器多次 flush 触发多次重扫
const RELOAD_DEBOUNCE_MS = 200;

// ----------------------------------------------------------------------------
// 内部 helpers
// ----------------------------------------------------------------------------

async function scanDir(
  dir: string | undefined,
  source: AgentSource,
): Promise<RegisteredAgent[]> {
  if (!dir) return [];
  try {
    const agents = await loadAgentMdFiles(dir);
    return agents.map((a) => ({ ...a, source }));
  } catch (err) {
    // 目录不存在或读取失败：静默返回空（首次启动时正常）
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('ENOENT')) {
      logger.warn(`Failed to scan agents dir ${dir}`, { error: msg });
    }
    return [];
  }
}

async function buildMap(workingDir: string | undefined): Promise<Map<string, RegisteredAgent>> {
  const next = new Map<string, RegisteredAgent>();
  const dirs = getAgentsMdDir(workingDir);

  // user 优先扫描，project 后扫描以保证覆盖
  const userAgents = await scanDir(dirs.user, 'user');
  for (const agent of userAgents) {
    next.set(agent.id, agent);
  }

  if (workingDir && dirs.project && await isProjectConfigTrusted(workingDir, 'project-agents')) {
    const projectAgents = await scanDir(dirs.project, 'project');
    for (const agent of projectAgents) {
      next.set(agent.id, agent);
    }
  }

  return next;
}

async function reloadAll(): Promise<void> {
  try {
    const nextMap = await buildMap(currentWorkingDir);
    // 原子替换：JS 引用赋值是原子的。
    customAgentMap = nextMap;
    logger.info('Agent registry reloaded', {
      customCount: nextMap.size,
      ids: Array.from(nextMap.keys()),
    });
    events.emit('changed');
  } catch (err) {
    logger.error('Agent registry reload failed', err);
  }
}

function scheduleReload(): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    void reloadAll();
  }, RELOAD_DEBOUNCE_MS);
}

// ----------------------------------------------------------------------------
// 公共 API
// ----------------------------------------------------------------------------

/**
 * 解析 agent：自定义优先 → builtin 回退。
 *
 * 注：调用方 spawn 期间应在入口处 capture 一次本函数的返回值，
 * 不要在 spawn 生命周期内重复调用，否则会受到中途热加载影响。
 */
export function resolveAgent(id: string): RegisteredAgent | undefined {
  // 取当前 Map 指针的快照——后续即使 customAgentMap 被替换也不影响本次。
  const snapshot = customAgentMap;
  const custom = snapshot.get(id);
  if (custom) return custom;
  if (isCoreAgent(id)) {
    return { ...CORE_AGENTS[id], source: 'builtin' };
  }
  return undefined;
}

/**
 * 获取 builtin agent（绕过自定义覆盖）。
 * 用于 agentLoop 主链路等内部流程，避免用户写一个 `coder.md` 覆盖了内置 coder
 * 导致整个 agent loop 崩盘。
 */
export function getBuiltinAgent(id: string): RegisteredAgent | undefined {
  if (!isCoreAgent(id)) return undefined;
  return { ...CORE_AGENTS[id], source: 'builtin' };
}

/**
 * 列出全部 agent（builtin + 自定义合并后的去重列表）。
 * 顺序：builtin 在前，自定义在后，自定义按 source 排序（user → project）。
 */
function toListEntry(
  agent: Pick<CoreAgentConfig, 'id' | 'name' | 'description' | 'model' | 'readonly' | 'tools' | 'inputs' | 'outputs' | 'visual'>,
  source: AgentSource,
): AgentListEntry {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    source,
    modelTier: agent.model,
    readonly: agent.readonly,
    tools: agent.tools,
    inputs: agent.inputs,
    outputs: agent.outputs,
    // 预设角色的 profession 在 BuiltinRoleVisual 里（不写进 agent.md frontmatter），
    // 自定义角色写在 frontmatter 由 agentMdLoader 解析进 visual
    profession: agent.visual?.profession ?? getBuiltinRoleVisual(agent.id)?.profession,
  };
}

export function listAllAgents(): AgentListEntry[] {
  const snapshot = customAgentMap;
  const entries: AgentListEntry[] = [];
  const seen = new Set<string>();

  // builtin
  for (const id of CORE_AGENT_IDS) {
    const cfg = CORE_AGENTS[id];
    const customOverride = snapshot.get(id);
    // 如果被自定义覆盖，自定义条目会在后面以 user/project source 出现
    if (!customOverride) {
      entries.push(toListEntry(cfg, 'builtin'));
      seen.add(id);
    }
  }

  // 自定义（user 先，project 后）
  const byUser: RegisteredAgent[] = [];
  const byProject: RegisteredAgent[] = [];
  for (const agent of snapshot.values()) {
    if (agent.source === 'project') byProject.push(agent);
    else byUser.push(agent);
  }

  for (const agent of [...byUser, ...byProject]) {
    if (seen.has(agent.id)) continue;
    entries.push(toListEntry(agent, agent.source));
    seen.add(agent.id);
  }

  return entries;
}

const agentRegistryGlobal = globalThis as typeof globalThis & {
  codeAgentAgentRegistry?: {
    listAllAgents: typeof listAllAgents;
    resolveAgent: typeof resolveAgent;
  };
};

agentRegistryGlobal.codeAgentAgentRegistry = {
  listAllAgents,
  resolveAgent,
};

/**
 * listAllAgents + 角色标记：agents/<id>.md 同名存在 roles/<id>/ 资产目录的条目
 * 视为角色（isRole），供面板与 agent 分组显示。角色目录读取失败时静默降级为不标记。
 */
export async function listAllAgentsWithRoleFlag(): Promise<AgentListEntry[]> {
  const entries = listAllAgents();
  try {
    const roleIds = new Set(await listPersistentRoles());
    return entries.map((entry) => (roleIds.has(entry.id) ? { ...entry, isRole: true } : entry));
  } catch {
    return entries;
  }
}

/**
 * 检查 id 是否能解析到一个已知 agent（builtin 或 custom）。
 */
export function isKnownAgent(id: string): boolean {
  return resolveAgent(id) !== undefined;
}

/**
 * 获取 custom map 的引用（仅供测试 / IPC 订阅使用）。
 * 注意：直接 mutate 这个 Map 会破坏 double-buffer 不变量。
 */
export function getCustomAgentMapSnapshot(): ReadonlyMap<string, RegisteredAgent> {
  return customAgentMap;
}

/**
 * 订阅 registry 变化事件。
 * @returns unsubscribe 函数
 */
export function onAgentRegistryChange(handler: () => void): () => void {
  events.on('changed', handler);
  return () => events.off('changed', handler);
}

/**
 * 初始化注册中心：首次扫描 + 启动 chokidar watcher。
 *
 * - 启动调用：initBackgroundServices.ts Phase 2
 * - 多次调用：先 dispose 再重建（适用于 workingDir 切换）
 */
export async function initAgentRegistry(workingDir?: string): Promise<void> {
  // 重入时清理旧 watcher
  if (watcher) {
    await disposeAgentRegistry();
  }

  currentWorkingDir = workingDir;
  await reloadAll();

  const dirs = getAgentsMdDir(workingDir);
  const watchPaths = [dirs.user];
  if (workingDir && dirs.project && await isProjectConfigTrusted(workingDir, 'project-agents')) {
    watchPaths.push(dirs.project);
  }

  try {
    watcher = chokidar.watch(watchPaths, {
      ignoreInitial: true,
      persistent: true,
      depth: 1,
      // 只关心 .md 文件
      ignored: (filePath: string) => {
        // 顶层目录本身不忽略
        if (watchPaths.some((p) => path.resolve(p) === path.resolve(filePath))) {
          return false;
        }
        // 其它路径：只接受 .md
        return !filePath.endsWith('.md');
      },
    });

    watcher
      .on('add', scheduleReload)
      .on('change', scheduleReload)
      .on('unlink', scheduleReload)
      .on('error', (err) => {
        logger.warn('Agent watcher error (non-fatal)', { error: String(err) });
      });

    logger.info('Agent registry initialized', {
      workingDir,
      watchPaths,
      customCount: customAgentMap.size,
    });
  } catch (err) {
    logger.warn('Agent watcher init failed (non-blocking)', { error: String(err) });
  }
}

/**
 * 释放 watcher + 重置状态。
 */
export async function disposeAgentRegistry(): Promise<void> {
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
  if (watcher) {
    try {
      await watcher.close();
    } catch (err) {
      logger.debug('Failed to close agent watcher', { error: String(err) });
    }
    watcher = null;
  }
  customAgentMap = new Map();
  currentWorkingDir = undefined;
}

/**
 * 测试 hook：手动触发一次重扫（绕过 debounce）。
 */
export async function forceReloadAgentRegistryForTest(): Promise<void> {
  await reloadAll();
}

/**
 * 测试 hook：手动注入 custom agent map（绕过文件系统）。
 */
export function setCustomAgentMapForTest(map: Map<string, RegisteredAgent>): void {
  customAgentMap = map;
  events.emit('changed');
}
