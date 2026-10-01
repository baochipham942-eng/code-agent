// ============================================================================
// installedPluginRescan — 扫描规则版本升级后对存量已安装插件的重扫
// （N-SKILL-SCAN-VERSION-RESCAN）
// 背景：安装时扫描只在入库那一刻跑（installService.performInstall →
// scanInstallContent）；SKILL_GUARD_VERSION 提升后，老技能不重扫就永远停在
// 旧规则的判定上。这里对 scanner.version 落后的已启用记录逐条重扫：
// block → 自动禁用并 warn（带 pluginSpec 与 finding kinds）；pass → 回写新版本。
// builtin 来源跳过，与 scanInstallContent 的 sourceTrust==='builtin' 分支一致。
// ============================================================================

import fsSync from 'fs';
import path from 'path';
import { SKILL_GUARD_VERSION, type SkillGuardFinding } from '../../security/skillContentGuard';
import { createLogger } from '../../services/infra/logger';
import { scanPluginRootContent, SkillContentScanBlockedError, SkillContentScanFailedError } from './skillInstallContentGuard';
import { getSkillsDir } from './pathUtils';
import {
  getInstalledPluginsStateVersion,
  saveInstalledPluginsIfVersionUnchanged,
} from './installedPluginsStateStore';
import type { InstalledPluginRecord, InstalledPluginsFile } from './types';

const logger = createLogger('InstalledPluginRescan');

/** 记录被扫描时的规则版本；缺 scanner 字段的老记录视为 0（版本化扫描上线前安装的）。 */
function getInstalledPluginScannerVersion(record: InstalledPluginRecord): number {
  return record.scanner?.version ?? 0;
}

/**
 * 需要重扫的判定：非 builtin 来源且 scanner 版本不等于当前规则版本。
 * 高于当前版本的记录同样重扫（ai-review R4 Nit）：未来版本意味着记录出自更新的
 * 扫描规则，当前进程无法证明其判定覆盖本版规则，按未知版本收敛——用当前规则
 * 重扫并把版本回写到当前值，顺带自愈版本漂移。
 */
function isInstalledPluginScanStale(record: InstalledPluginRecord): boolean {
  if (record.sourceTrust === 'builtin') return false;
  return getInstalledPluginScannerVersion(record) !== SKILL_GUARD_VERSION;
}

interface InstalledPluginRescanOutcome {
  verdict: 'pass' | 'block';
  findings: SkillGuardFinding[];
  /** 命中阻断的相对文件路径（block 时存在） */
  file?: string;
  scannedAt: string;
}

/**
 * 重扫目标目录：与 enabledSkillDescriptors 的装载真源对齐（ai-review R5 Nit2）——
 * 有 pluginRoot/skillPaths 的记录装载自插件根，扫插件根；缺 pluginRoot 的旧记录
 * 实际装载的是 skillsDir 下的复制目录，必须扫复制目录本身，不扫
 * sourceMarketplacePath（可能与复制内容漂移）。拿不到可靠路径返回空数组。
 */
function resolveRescanTargetDirs(record: InstalledPluginRecord): string[] {
  // pluginRoot 有效就始终扫插件根（ai-review R6 Nit1：commands-only 插件
  // skillPaths 为空也要扫，插件根含共享命令模板）
  if (record.pluginRoot && fsSync.existsSync(record.pluginRoot)) {
    return [record.pluginRoot];
  }
  const pluginRoot = record.sourceMarketplacePath;
  if (pluginRoot && record.skillPaths?.length && fsSync.existsSync(pluginRoot)) {
    return [pluginRoot];
  }
  const skillsDir = getSkillsDir(record.scope, record.projectPath);
  return (record.skills || [])
    .map((skillName) => path.join(skillsDir, skillName))
    .filter((dir) => fsSync.existsSync(dir));
}

/**
 * 对单个已安装记录按当前规则重扫（逐目录，任一目录 block 即 block）。
 * 拿不到可靠扫描目标时返回 null 并 warn 留痕（ai-review R5 Nit2：不许猜路径，
 * 记录保持原样，下次启动再试）。扫描失败（文件不可读等）按 fail-closed 向上抛。
 */
async function rescanInstalledPlugin(
  pluginSpec: string,
  record: InstalledPluginRecord,
): Promise<InstalledPluginRescanOutcome | null> {
  const targetDirs = resolveRescanTargetDirs(record);
  if (targetDirs.length === 0) {
    logger.warn('Skipped rescan: no reliable scan target for installed record', { pluginSpec });
    return null;
  }
  const scannedAt = new Date().toISOString();
  for (const rootDir of targetDirs) {
    const outcome = await scanPluginRootContent({
      pluginSpec,
      sourceTrust: record.sourceTrust ?? 'local-marketplace',
      rootDir,
    });
    if (outcome.verdict === 'block') {
      return {
        verdict: 'block',
        findings: outcome.findings,
        ...(outcome.file ? { file: outcome.file } : {}),
        scannedAt,
      };
    }
  }
  return { verdict: 'pass', findings: [], scannedAt };
}

export interface StaleRescanSummary {
  rescanned: number;
  /** 判定需禁用的 pluginSpec（含 scan_failed），无论落盘成败——调用方用它做内存级装载过滤 */
  blocked: string[];
}

/** 扫描期只读收集的结论；合写期先核对安装指纹（installedAt + 根目录）再应用。 */
interface RescanDecision {
  pluginSpec: string;
  installedAt: string;
  rootDir: string;
  outcome:
    | { kind: 'pass'; scannedAt: string }
    | { kind: 'block'; findings: SkillGuardFinding[]; file?: string }
    | { kind: 'scan_failed'; error: string };
}

/** 状态 IO 依赖注入形状：生产走动态 import 的真实实现，测试注入包装版模拟并发写。 */
interface RescanStateIO {
  loadInstalledPlugins: () => Promise<InstalledPluginsFile>;
  saveInstalledPlugins: (state: InstalledPluginsFile) => Promise<void>;
  deactivatePluginCommands: (args: {
    scope: InstalledPluginRecord['scope'];
    projectPath?: string;
    commandNames: string[];
    verifyOwnership?: { sourceRootDir: string; commandPaths: string[] };
  }) => Promise<string[]>;
  getInstalledPluginsStateVersion: () => number;
  saveInstalledPluginsIfVersionUnchanged: (state: InstalledPluginsFile, expectedVersion: number) => Promise<boolean> | boolean;
}

/** CAS 冲突重试上限：耗尽按 fail-loud 留痕、本次结论丢弃（内存阻断集仍兜底） */
const MAX_SAVE_ATTEMPTS = 3;

/**
 * 宿主启动重扫入口（skillDiscoveryService 装载已启用插件之前调用）：
 * 对 scanner 版本落后的已启用记录逐条重扫。block/扫不动 → isEnabled=false
 * 落盘并 warn；pass → 回写当前版本。单条失败不影响其他记录。
 *
 * 读改写形态（ai-review R2/R4/R5 Important 1）：扫描期只读；合写期先在 fresh
 * 快照上做命令下架等带 await 的副作用；保存走「重读 → 记内存状态版本 → 最小
 * 合并 → CAS 保存」，版本漂移就重读重合并重试（有界 MAX_SAVE_ATTEMPTS，耗尽
 * fail-loud 留痕、结论丢弃）——合并只动本单负责的字段（scanner / isEnabled），
 * 扫描与合写窗口里的并发安装/禁用/卸载一律保留。仓内安装状态没有共享互斥
 * （enable/disable 同样是无锁读改写），不新造锁，用版本校验收口。
 * 注意：本函数在 discovery 初始化链路内运行，绝不能触发 discovery reload
 * （会撞上 initialize 的 initPromise 自等待死锁），所以不走 disablePlugin。
 */
export async function rescanStaleInstalledPlugins(
  io?: RescanStateIO,
): Promise<StaleRescanSummary> {
  const summary: StaleRescanSummary = { rescanned: 0, blocked: [] };
  // 依赖注入入口（ai-review R4）：vi.mock 模块图在混合真实调用时不可靠，测试注入包装 IO
  const svc: RescanStateIO = io ?? {
    ...(await import('./installService')),
    getInstalledPluginsStateVersion,
    saveInstalledPluginsIfVersionUnchanged,
  };

  // 扫描期：只读
  const state = await svc.loadInstalledPlugins();
  const decisions: RescanDecision[] = [];
  for (const [pluginSpec, record] of Object.entries(state)) {
    if (!record.isEnabled || !isInstalledPluginScanStale(record)) continue;
    const rootDir = record.pluginRoot || record.sourceMarketplacePath;
    let outcome: RescanDecision['outcome'];
    try {
      const rescan = await rescanInstalledPlugin(pluginSpec, record);
      if (!rescan) continue;
      outcome = rescan.verdict === 'block'
        ? { kind: 'block', findings: rescan.findings, ...(rescan.file ? { file: rescan.file } : {}) }
        : { kind: 'pass', scannedAt: rescan.scannedAt };
    } catch (error) {
      outcome = { kind: 'scan_failed', error: error instanceof Error ? error.message : String(error) };
    }
    summary.rescanned += 1;
    decisions.push({ pluginSpec, installedAt: record.installedAt, rootDir, outcome });
  }
  if (decisions.length === 0) return summary;

  // block / scan_failed 结论落 summary.blocked 并 warn（与落盘成败无关，供内存级装载过滤）
  for (const decision of decisions) {
    if (decision.outcome.kind === 'pass') continue;
    summary.blocked.push(decision.pluginSpec);
    if (decision.outcome.kind === 'block') {
      logger.warn('Installed plugin disabled by skill guard rescan', {
        pluginSpec: decision.pluginSpec,
        findings: decision.outcome.findings.map((finding) => finding.kind),
        file: decision.outcome.file,
      });
    } else {
      // 扫不动 ≠ 放行：fail-closed 禁用，warn 带出可区分原因（scan_failed）
      logger.warn('Installed plugin disabled after skill guard rescan failure', {
        pluginSpec: decision.pluginSpec,
        reason: 'scan_failed',
        error: decision.outcome.error,
      });
    }
  }

  // CAS 合并 + 冲突重试（ai-review R5/R6）：每次循环重读最新状态、记录内存状态
  // 版本、做最小合并（只动本单负责的字段 scanner / isEnabled），版本不变才落盘，
  // 版本漂移重试，耗尽 fail-loud 留痕、本次结论丢弃（内存阻断集仍兜底）。
  // 命令下架副作用挪到状态提交之后（ai-review R6 Important 2）：指纹核对在合并
  // 前完成，并发重装的记录整条跳过、连下架都不做，不会误删新安装的命令副本。
  const disabledRecords: Array<{ pluginSpec: string; record: InstalledPluginRecord }> = [];
  let persisted = false;
  let persistError: unknown;
  for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS && !persisted; attempt += 1) {
    const latest = await svc.loadInstalledPlugins();
    const stateVersion = svc.getInstalledPluginsStateVersion();
    let dirty = false;
    disabledRecords.length = 0;
    for (const decision of decisions) {
      const record = latest[decision.pluginSpec];
      if (record?.installedAt !== decision.installedAt
        || (record.pluginRoot || record.sourceMarketplacePath) !== decision.rootDir) {
        if (attempt === 1) {
          logger.warn('Skipped rescan result: plugin record changed during rescan', {
            pluginSpec: decision.pluginSpec,
          });
        }
        continue;
      }
      if (decision.outcome.kind === 'pass') {
        record.scanner = {
          version: SKILL_GUARD_VERSION,
          verdict: 'pass',
          scannedAt: decision.outcome.scannedAt,
        };
        dirty = true;
        continue;
      }
      if (record.isEnabled) {
        record.isEnabled = false;
        dirty = true;
        disabledRecords.push({ pluginSpec: decision.pluginSpec, record });
      }
    }
    if (!dirty) {
      persisted = true; // 没有需要落盘的结论（全部被并发变化消化）
      break;
    }
    try {
      persisted = await svc.saveInstalledPluginsIfVersionUnchanged(latest, stateVersion);
    } catch (error) {
      persistError = error; // IO 错误不是版本冲突，重试无意义
      break;
    }
  }
  if (!persisted) {
    if (persistError) {
      logger.error('Failed to persist skill guard rescan results', {
        error: persistError instanceof Error ? persistError.message : String(persistError),
      });
    } else {
      logger.error('Skill guard rescan results discarded after repeated state conflicts', {
        attempts: MAX_SAVE_ATTEMPTS,
      });
    }
    return summary;
  }

  // 状态已提交：对本次实际禁用的记录下架 prompt commands。下架前再读一次状态
  // 核对安装指纹（ai-review R7）——CAS 提交到下架之间并发 force-reinstall 会换掉
  // 记录与命令副本，只有指纹仍与被禁用那条一致（且仍处禁用态）的记录才执行下架，
  // 指纹变了整条跳过 + warn，新安装的命令文件零删除。归属校验（R4/R5）只删内容
  // 仍与插件源一致的副本；下架失败 fail-loud 留痕（R2 Nit2）。
  if (disabledRecords.length > 0) {
    const beforeDeactivate = await svc.loadInstalledPlugins();
    for (const { pluginSpec, record } of disabledRecords) {
      const current = beforeDeactivate[pluginSpec];
      if (current?.installedAt !== record.installedAt
        || (current.pluginRoot || current.sourceMarketplacePath) !== (record.pluginRoot || record.sourceMarketplacePath)
        || current.isEnabled) {
        logger.warn('Skipped command deactivation: plugin record changed after rescan commit', {
          pluginSpec,
        });
        continue;
      }
      try {
        await svc.deactivatePluginCommands({
          scope: record.scope,
          projectPath: record.projectPath,
          commandNames: record.commands || [],
          verifyOwnership: {
            sourceRootDir: record.sourceMarketplacePath,
            commandPaths: record.commandPaths || [],
          },
        });
      } catch (error) {
        logger.error('Failed to deactivate commands of rescan-disabled plugin', {
          pluginSpec,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return summary;
}

/**
 * enablePlugin 前置重扫：过期记录按当前规则重扫，block 抛
 * SkillContentScanBlockedError 而不是静默启用；pass 回写 record.scanner
 * （由调用方随启用一并落盘）。扫描失败（文件不可读等）fail-closed 向上抛。
 * 该扫而扫不了（拿不到可靠扫描目标）同样 fail-closed（ai-review R6 Nit2）——
 * 与免扫路径区分开：builtin 在 isInstalledPluginScanStale 已放行，走不到这里。
 */
export async function assertPluginRescanPassesForEnable(
  pluginSpec: string,
  record: InstalledPluginRecord,
): Promise<void> {
  if (!isInstalledPluginScanStale(record)) return;
  const rescan = await rescanInstalledPlugin(pluginSpec, record);
  if (!rescan) {
    logger.error('Plugin enable blocked: no reliable scan target for stale record', { pluginSpec });
    throw new SkillContentScanFailedError(
      pluginSpec,
      record.sourceTrust ?? 'local-marketplace',
      record.pluginRoot ?? record.sourceMarketplacePath,
    );
  }
  if (rescan.verdict === 'block') {
    logger.warn('Plugin enable blocked by skill guard rescan', {
      pluginSpec,
      findings: rescan.findings.map((finding) => finding.kind),
      file: rescan.file,
    });
    throw new SkillContentScanBlockedError(
      pluginSpec,
      record.sourceTrust ?? 'local-marketplace',
      rescan.file ?? record.pluginRoot ?? record.sourceMarketplacePath,
    );
  }
  record.scanner = {
    version: SKILL_GUARD_VERSION,
    verdict: 'pass',
    scannedAt: rescan.scannedAt,
  };
}
