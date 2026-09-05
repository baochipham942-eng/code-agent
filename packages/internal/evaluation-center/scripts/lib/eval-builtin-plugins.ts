// ============================================================================
// eval-builtin-plugins.ts — 评测跑级的 builtin 插件开关（`--builtin-plugins`）
// ============================================================================
//
// 为什么需要它：eval 进程从来不调 initPluginSystem()，所以 8 个 builtin 插件注册的
// 工具在评测里全部「不可直接调用」——ToolSearch 对 validate_html_in_app / Browser
// 一律返回 `searchable metadata has no registered protocol tool`。也就是说评测一直
// 在考一个能力残缺的 Neo，而报告上看不出这件事。
//
// 为什么是跑级开关而不是 compare 的一条臂：PluginRegistry 与 protocol registry 都是
// 进程单例，同一进程里没法同时存在「装了」和「没装」两种工具面。所以「装 vs 不装」
// 只能做成两次跑 + delta 报告逐题对比。
//
// 为什么不写安装状态文件：显式子集用 PluginRegistry 的 install/remove 走内存态即可，
// 不碰 `<dataDir>/capabilities/*.json`——评测不该在用户真实数据目录里留安装痕迹。
// ============================================================================

import chalk from 'chalk';
import { BUILTIN_PLUGIN_CATALOG } from '@host/plugins/builtin/catalog';
import type { BuiltinCapabilityId } from '@host/plugins/builtin/builtinCapabilityIds';

/** `none` = 存量行为（不起插件系统）；`all` = 按安装状态起全部默认已装的 builtin。 */
export type BuiltinPluginSelection = 'none' | 'all' | readonly BuiltinCapabilityId[];

export const BUILTIN_PLUGIN_IDS: readonly BuiltinCapabilityId[] =
  BUILTIN_PLUGIN_CATALOG.map(({ manifest }) => manifest.id);

/**
 * `--builtin-plugins <all|none|id1,id2>`。
 *
 * fail-loud：拼错的 id 不静默忽略——静默忽略会让「我明明点名了却没生效」变成一次
 * 无法解释的零分差。id 可省 `builtin.` 前缀（`browserControl` == `builtin.browserControl`）。
 */
export function parseBuiltinPluginsArg(raw: string): BuiltinPluginSelection {
  const value = raw.trim();
  if (value === 'none') return 'none';
  if (value === 'all') return 'all';

  const requested = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (requested.length === 0) {
    throw new Error('--builtin-plugins 需要 all / none / 逗号分隔的插件 id。');
  }
  const resolved: BuiltinCapabilityId[] = [];
  const unknown: string[] = [];
  for (const item of requested) {
    const candidate = item.startsWith('builtin.') ? item : `builtin.${item}`;
    const match = BUILTIN_PLUGIN_IDS.find((id) => id === candidate);
    if (match) resolved.push(match);
    else unknown.push(item);
  }
  if (unknown.length > 0) {
    throw new Error(
      `--builtin-plugins 里有未知插件 id：${unknown.join(', ')}。`
      + `可用：${BUILTIN_PLUGIN_IDS.join(', ')}`,
    );
  }
  return resolved;
}

export interface BuiltinPluginActivation {
  /** 真正 active 的 id（不是请求值）——run stamp 的 shape.plugins 用这个 */
  active: string[];
  /** 装不上的原因，逐条人话，进 stderr 一行 */
  failures: Array<{ id: string; reason: string }>;
}

let started = false;

/**
 * 按开关起插件系统。`none` 直接返回空结果且**不 import 插件系统**，保证缺省跑法与 main 一致。
 */
export async function activateEvalBuiltinPlugins(
  selection: BuiltinPluginSelection,
): Promise<BuiltinPluginActivation> {
  if (selection === 'none') return { active: [], failures: [] };

  const {
    initPluginSystem,
    getPluginRegistry,
    getActiveBuiltinPluginIds,
  } = await import('@host/plugins/pluginRegistry');

  await initPluginSystem();
  started = true;

  if (selection !== 'all') {
    const wanted = new Set<string>(selection);
    const registry = getPluginRegistry();
    for (const id of BUILTIN_PLUGIN_IDS) {
      const loaded = registry.getPlugin(id);
      if (wanted.has(id)) {
        if (!loaded || loaded.state !== 'active') await registry.installBuiltinCapability(id);
      } else if (loaded) {
        await registry.removeBuiltinCapability(id);
      }
    }
  }

  const active = getActiveBuiltinPluginIds();
  const activeSet = new Set(active);
  const requested = selection === 'all' ? BUILTIN_PLUGIN_IDS : selection;
  const failures = requested
    .filter((id) => !activeSet.has(id))
    .map((id) => ({
      id,
      reason: getPluginRegistry().getPlugin(id)?.error
        ?? (selection === 'all' ? '未安装（安装状态为 removed，或 computerUse 需显式点名）' : '激活失败'),
    }));
  return { active, failures };
}

export async function shutdownEvalBuiltinPlugins(): Promise<void> {
  if (!started) return;
  started = false;
  const { shutdownPluginSystem } = await import('@host/plugins/pluginRegistry');
  // startWatching 起了文件监听，进程退出前必须收；不收就是又给 N-EVAL-CI-NOEXIT 添一个句柄。
  await shutdownPluginSystem();
}

/** stderr 一行人话：谁装上了、谁没装上、为什么。 */
export function describeBuiltinPluginActivation(
  selection: BuiltinPluginSelection,
  activation: BuiltinPluginActivation,
): string {
  const requested = selection === 'none'
    ? 'none'
    : selection === 'all' ? 'all' : selection.join(',');
  const head = `  Builtin plugins: 请求=${requested}；激活=${
    activation.active.length ? activation.active.join('、') : '无（工具面与存量跑法一致）'
  }`;
  if (activation.failures.length === 0) return chalk.cyan(head);
  const tail = activation.failures.map(({ id, reason }) => `${id}（${reason}）`).join('；');
  return `${chalk.cyan(head)}\n${chalk.yellow(`  未激活：${tail}`)}`;
}
