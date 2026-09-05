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
//
// 为什么不用 initPluginSystem()：它起的是**完整**插件系统——除了 builtin 还会
// discoverPlugins 扫 `<dataDir>/plugins` 装第三方插件、再 loadInstalled() 拉内部功能插件。
// 那些插件注册的工具照样进 protocol registry，而本开关只按 builtin 过滤、stamp 也只记 builtin
// ⇒ 数据目录里有第三方工具插件时，实际工具面比声明的大，两臂对比的结论就被污染了。
// 「调用者记得用 mktemp 数据目录」不算隔离——开关自己得只装它声明的那些。
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

/** 本进程已装上的 builtin，退出时对称卸掉 */
let installed: BuiltinCapabilityId[] = [];

/**
 * 按开关装 builtin 插件。`none` 直接返回空结果且**不 import 插件系统**，保证缺省跑法与 main 一致。
 *
 * 只走 `installBuiltinCapability`（单个激活、不扫磁盘），不碰 `initPluginSystem`——
 * 见文件头「为什么不用 initPluginSystem()」。重复调用是幂等的：已 active 的直接返回 true。
 */
export async function activateEvalBuiltinPlugins(
  selection: BuiltinPluginSelection,
): Promise<BuiltinPluginActivation> {
  if (selection === 'none') return { active: [], failures: [] };

  // 顺序不能反：protocol registry 的注册端口是 protocolRegistry 模块的 import 副作用，
  // 先激活插件会让每个 builtin 撞「Protocol tool registry is not initialized」而全部转 error
  // ——报告上写着请求了 all，工具面却一个没多。
  const { getProtocolRegistry } = await import('@host/tools/protocolRegistry');
  getProtocolRegistry();

  const { getPluginRegistry, getActiveBuiltinPluginIds } = await import('@host/plugins/pluginRegistry');
  const { getDefaultInstalledBuiltinPluginIds } = await import('@host/agent/agentRuntimeDefaults');

  // `all` = 所有默认已装的（computerUse 的安装状态判定要求显式点名，所以它不在里面）；
  // 显式子集则以点名为准，安装状态不再过滤——点名就是要它。
  const defaultInstalled = new Set(getDefaultInstalledBuiltinPluginIds());
  const requested: readonly BuiltinCapabilityId[] = selection === 'all'
    ? BUILTIN_PLUGIN_IDS.filter((id) => defaultInstalled.has(id))
    : selection;

  const wanted = new Set<string>(requested);
  const registry = getPluginRegistry();
  for (const id of BUILTIN_PLUGIN_IDS) {
    if (wanted.has(id)) await registry.installBuiltinCapability(id);
    else if (registry.getPlugin(id)) await registry.removeBuiltinCapability(id);
  }
  installed = [...requested];

  const active = getActiveBuiltinPluginIds();
  const activeSet = new Set(active);
  const failures = requested
    .filter((id) => !activeSet.has(id))
    .map((id) => ({ id, reason: registry.getPlugin(id)?.error ?? '激活失败' }));
  return { active, failures };
}

export async function shutdownEvalBuiltinPlugins(): Promise<void> {
  if (installed.length === 0) return;
  const targets = installed;
  installed = [];
  const { getPluginRegistry } = await import('@host/plugins/pluginRegistry');
  const registry = getPluginRegistry();
  for (const id of targets) await registry.removeBuiltinCapability(id);
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
