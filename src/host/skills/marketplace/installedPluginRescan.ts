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
import { SKILL_GUARD_VERSION, type SkillGuardFinding } from '../../security/skillContentGuard';
import { createLogger } from '../../services/infra/logger';
import { scanPluginRootContent, SkillContentScanBlockedError } from './skillInstallContentGuard';
import type { InstalledPluginRecord } from './types';

const logger = createLogger('InstalledPluginRescan');

/** 记录被扫描时的规则版本；缺 scanner 字段的老记录视为 0（版本化扫描上线前安装的）。 */
export function getInstalledPluginScannerVersion(record: InstalledPluginRecord): number {
  return record.scanner?.version ?? 0;
}

/** 需要重扫的判定：非 builtin 来源且 scanner 版本落后于当前规则版本。 */
function isInstalledPluginScanStale(record: InstalledPluginRecord): boolean {
  if (record.sourceTrust === 'builtin') return false;
  return getInstalledPluginScannerVersion(record) < SKILL_GUARD_VERSION;
}

interface InstalledPluginRescanOutcome {
  verdict: 'pass' | 'block';
  findings: SkillGuardFinding[];
  /** 命中阻断的相对文件路径（block 时存在） */
  file?: string;
  scannedAt: string;
}

/**
 * 对单个已安装记录按当前规则重扫。插件根目录已不存在时返回 null（没有可扫
 * 内容，记录保持原样）。扫描失败（文件不可读等）按 fail-closed 向上抛。
 */
async function rescanInstalledPlugin(
  pluginSpec: string,
  record: InstalledPluginRecord,
): Promise<InstalledPluginRescanOutcome | null> {
  const rootDir = record.pluginRoot || record.sourceMarketplacePath;
  if (!rootDir || !fsSync.existsSync(rootDir)) return null;
  const outcome = await scanPluginRootContent({
    pluginSpec,
    sourceTrust: record.sourceTrust ?? 'local-marketplace',
    rootDir,
  });
  return {
    verdict: outcome.verdict,
    findings: outcome.findings,
    ...(outcome.file ? { file: outcome.file } : {}),
    scannedAt: new Date().toISOString(),
  };
}

export interface StaleRescanSummary {
  rescanned: number;
  blocked: string[];
}

/**
 * 宿主启动重扫入口（skillDiscoveryService 装载已启用插件之前调用）：
 * 对 scanner 版本落后的已启用记录逐条重扫。block/扫不动 → isEnabled=false
 * 落盘并 warn；pass → 回写当前版本。单条失败不影响其他记录。
 * 注意：本函数在 discovery 初始化链路内运行，绝不能触发 discovery reload
 * （会撞上 initialize 的 initPromise 自等待死锁），所以不走 disablePlugin。
 */
export async function rescanStaleInstalledPlugins(): Promise<StaleRescanSummary> {
  const summary: StaleRescanSummary = { rescanned: 0, blocked: [] };
  const { loadInstalledPlugins, saveInstalledPlugins, deactivatePluginCommands } = await import('./installService');
  const state = await loadInstalledPlugins();
  let dirty = false;

  for (const [pluginSpec, record] of Object.entries(state)) {
    if (!record.isEnabled || !isInstalledPluginScanStale(record)) continue;

    let outcome: InstalledPluginRescanOutcome | null;
    try {
      outcome = await rescanInstalledPlugin(pluginSpec, record);
    } catch (error) {
      // 扫不动 ≠ 放行：fail-closed 禁用，warn 带出可区分原因（scan_failed）
      record.isEnabled = false;
      dirty = true;
      summary.rescanned += 1;
      summary.blocked.push(pluginSpec);
      logger.warn('Installed plugin disabled after skill guard rescan failure', {
        pluginSpec,
        reason: 'scan_failed',
        error: error instanceof Error ? error.message : String(error),
      });
      await deactivateBlockedPluginCommands(record, pluginSpec, deactivatePluginCommands);
      continue;
    }
    if (!outcome) continue;

    summary.rescanned += 1;
    dirty = true;
    if (outcome.verdict === 'block') {
      record.isEnabled = false;
      summary.blocked.push(pluginSpec);
      logger.warn('Installed plugin disabled by skill guard rescan', {
        pluginSpec,
        findings: outcome.findings.map((finding) => finding.kind),
        file: outcome.file,
      });
      await deactivateBlockedPluginCommands(record, pluginSpec, deactivatePluginCommands);
      continue;
    }
    record.scanner = {
      version: SKILL_GUARD_VERSION,
      verdict: 'pass',
      scannedAt: outcome.scannedAt,
    };
  }

  if (dirty) {
    await saveInstalledPlugins(state);
  }
  return summary;
}

/**
 * enablePlugin 前置重扫：过期记录按当前规则重扫，block 抛
 * SkillContentScanBlockedError 而不是静默启用；pass 回写 record.scanner
 * （由调用方随启用一并落盘）。扫描失败（文件不可读等）fail-closed 向上抛。
 */
export async function assertPluginRescanPassesForEnable(
  pluginSpec: string,
  record: InstalledPluginRecord,
): Promise<void> {
  if (!isInstalledPluginScanStale(record)) return;
  const rescan = await rescanInstalledPlugin(pluginSpec, record);
  if (rescan?.verdict === 'block') {
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
  if (rescan) {
    record.scanner = {
      version: SKILL_GUARD_VERSION,
      verdict: 'pass',
      scannedAt: rescan.scannedAt,
    };
  }
}

type DeactivateCommandsFn = (args: {
  scope: InstalledPluginRecord['scope'];
  projectPath?: string;
  commandNames: string[];
}) => Promise<string[]>;

/** 被禁用插件的 prompt commands 一并下架，与 disablePlugin 的语义保持一致。 */
async function deactivateBlockedPluginCommands(
  record: InstalledPluginRecord,
  pluginSpec: string,
  deactivatePluginCommands: DeactivateCommandsFn,
): Promise<void> {
  try {
    await deactivatePluginCommands({
      scope: record.scope,
      projectPath: record.projectPath,
      commandNames: record.commands || [],
    });
  } catch (error) {
    logger.warn('Failed to deactivate commands of rescan-disabled plugin', {
      pluginSpec,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
