// ============================================================================
// 懒开目录的落盘收口（N-DELIVERABLE-WORKDIR-LAZY）
// ============================================================================
// 无文件夹会话的工作目录首轮只规划不落盘（sessionWorkDirectory.planSessionWorkDirectory），
// 纯问答会话不产生任何目录。真正要写的那一刻在这里补 mkdir：工具引擎在派发首个
// 非 readOnly 工具前调用；外部引擎（codex/claude 等要把目录当子进程 cwd，缺失会被
// assertWorkspaceCwd 硬拒）在 web 路由 preflight 调用。
//
// 边界：只对 getDefaultWorkDirectory() 之内且当前不存在的路径出手——默认根之外的
// 目录不属于懒开机制的承诺，绝不自动创建。每路径每进程只尝试一次（并发共享同一次
// 尝试）；失败留 warn 不向调用方抛错，让工具自己带出真实错误（降级必须留痕）。
//
// 撞名残留（rework r2）：目录已存在且非空、又被其它会话行同时记下时，说明规划期
// 竞态已经让两个会话拿到了同一路径。此刻运行 cwd 已不可变（run-scoped
// ToolExecutor），本轮写入必然会混入对方产物——改道只能在运行开始前的 agent
// preflight 做（maybeDivertCollidingSessionWorkDirectory），这里至少留 warn 让混写
// 有迹可循，下一轮 preflight 会切走。
//
// 注意：这里只建目录，不做项目认领。会话的项目归属在首条消息落库后就不可变
//（PROJECT_BOUNDARY_IMMUTABLE），而懒开目录总在消息之后才落盘——懒开会话因此
// 停留在未分类，目录只作为磁盘上的产出夹存在，不铸造对应 Project 行。
// ============================================================================
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { getDefaultWorkDirectory } from '../../config/configPaths';
import { materializeSessionWorkDirectory } from '../../config/sessionWorkDirectory';
import { listSessionWorkDirectoryReservations } from '../../config/sessionWorkDirectoryReservations';
import { isPathWithinRoot } from '../../runtime/workspaceScope';
import { hasUnclearedStreamSnapshots } from '../../session/streamSnapshot';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('WorkDirectoryMaterializer');

const attempts = new Map<string, Promise<void>>();
/** 本进程在 stat ENOENT 之后 mkdir 成功的目录。已存在的目录不记入。 */
const createdByThisProcess = new Set<string>();
/** 仍在执行的 run 数。同一目录要等最后一个 run 结束才考虑回收。 */
const activeRuns = new Map<string, number>();

async function warnIfForeignClaimed(dir: string, sessionId?: string): Promise<void> {
  if (!sessionId) return;
  try {
    if ((await fs.readdir(dir)).length === 0) return;
    const claimedByOthers = (await listSessionWorkDirectoryReservations({ exceptSessionId: sessionId }))
      .some((reserved) => path.resolve(reserved) === dir);
    if (claimedByOthers) {
      logger.warn(`[WorkDirectoryMaterializer] Session work dir ${dir} is also recorded by another session; this turn's writes will mix — next turn's preflight diverts`);
    }
  } catch (error) {
    logger.warn(`[WorkDirectoryMaterializer] Cannot check ownership of session work dir ${dir}:`, error);
  }
}

async function attemptMaterialization(dir: string, sessionId?: string): Promise<void> {
  if (!isPathWithinRoot(dir, getDefaultWorkDirectory())) return;
  try {
    const stats = await fs.stat(dir);
    // 已存在：不重复建。存在但不是目录更不能动——让后续写入自己撞出真实错误。
    if (!stats.isDirectory()) {
      logger.warn(`[WorkDirectoryMaterializer] Planned session work dir exists but is not a directory: ${dir}`);
      return;
    }
    await warnIfForeignClaimed(dir, sessionId);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`[WorkDirectoryMaterializer] Cannot inspect planned session work dir ${dir}:`, error);
      return;
    }
  }
  try {
    await materializeSessionWorkDirectory(dir);
    createdByThisProcess.add(dir);
    logger.info(`[WorkDirectoryMaterializer] Materialized planned session work dir: ${dir}`);
  } catch (error) {
    logger.warn(`[WorkDirectoryMaterializer] Failed to materialize session work dir ${dir}:`, error);
  }
}

/**
 * 工作目录不存在且在默认工作根之内时把它建出来；幂等（每路径每进程一次），绝不抛错。
 */
export function materializeRunWorkDirectoryOnce(
  workingDirectory: string | undefined,
  context?: { sessionId?: string },
): Promise<void> {
  const trimmed = workingDirectory?.trim();
  if (!trimmed) return Promise.resolve();
  const dir = path.resolve(trimmed);
  const existing = attempts.get(dir);
  if (existing) return existing;
  const attempt = attemptMaterialization(dir, context?.sessionId);
  attempts.set(dir, attempt);
  return attempt;
}

/**
 * 懒开落盘判定（N-DELIVERABLE-WORKDIR-LAZY-FU1）：工具定义已注册、未声明只读、
 * 且未显式声明「不碰工作目录」时才落盘。readOnly 覆盖面太粗——AskUserQuestion /
 * confirm_action / MemoryWrite / memory_amend 都不是只读，但 handler 全都不碰 cwd，
 * 此前会在 ~/Neo 留下空任务夹。精化是 schema 上的显式 opt-out（单一真源），
 * 这里不枚举工具名；缺省保持落盘（fail-safe：cwd 缺失会让 Bash/Process 派发失败）。
 *
 * Bash 决策（N-DELIVERABLE-WORKDIR-LAZY-FU1-FU1，刻意保持永远落盘、不做逐调用豁免）：
 * ① Bash 以会话目录为 spawn cwd，目录缺失 = ENOENT，无法事后补救；② 现成的
 * isReadOnlyShellCommand（agent/antiPattern/detector.ts）只是文件读取启发式，拿它当
 * 豁免门会把 `pwd`（依赖 cwd 存在）与 `echo x > f`（看似无害实则写盘）这类形状
 * 误分类；③ schema 标志是按工具粒度、不是按调用粒度——Bash 单工具内读写混合，
 * 唯一安全档就是全部落盘，也不在此枚举工具名单。
 */
export function shouldMaterializeWorkDirectoryForTool(
  definition: { readOnly?: boolean; touchesWorkDirectory?: false } | undefined,
): boolean {
  return definition !== undefined
    && definition.readOnly !== true
    && definition.touchesWorkDirectory !== false;
}

function resolveTrackedDir(workingDirectory: string | undefined): string | undefined {
  const trimmed = workingDirectory?.trim();
  if (!trimmed) return undefined;
  return path.resolve(trimmed);
}

/**
 * run 开始。前台与后台 auxiliary 都从 AgentLoop.run 进来，按目录计数。
 * 目录此刻可以还不存在——落盘发生在后续会写 cwd 的工具派发时。
 */
export function beginWorkDirectoryRun(workingDirectory: string | undefined): void {
  const dir = resolveTrackedDir(workingDirectory);
  if (!dir) return;
  activeRuns.set(dir, (activeRuns.get(dir) ?? 0) + 1);
}

/**
 * 最后一个占用该目录的 run 结束时，仅当本进程新建且内容只剩 `.code-agent`
 * （其中至多空的 `stream-snapshots` 脚手架 / owner 标记）才删除。其它任何文件
 * 或目录都留下；stream-snapshots 里还有未清除的 run 快照（断流恢复证据）时也
 * 不删——证据要活到用户重进会话被 loadStreamSnapshot 读回（rework r1）。
 * 删掉之后清掉 attempts，否则下一次 Write 会命中已完成的 promise、不再 mkdir。
 */
export function endWorkDirectoryRun(workingDirectory: string | undefined): void {
  const dir = resolveTrackedDir(workingDirectory);
  if (!dir) return;
  const current = activeRuns.get(dir) ?? 0;
  if (current <= 0) return;
  if (current > 1) {
    activeRuns.set(dir, current - 1);
    return;
  }
  activeRuns.delete(dir);
  recycleCreatedMetadataDir(dir);
}

function recycleCreatedMetadataDir(dir: string): void {
  if (!createdByThisProcess.has(dir)) return;
  if ((activeRuns.get(dir) ?? 0) > 0) return;
  if (!fsSync.existsSync(dir)) {
    createdByThisProcess.delete(dir);
    attempts.delete(dir);
    return;
  }
  if (!isOnlyCodeAgentMetadata(dir)) return;
  if ((activeRuns.get(dir) ?? 0) > 0) return;
  try {
    fsSync.rmSync(dir, { recursive: true, force: false });
  } catch (error) {
    logger.warn(`[WorkDirectoryMaterializer] Failed to recycle empty session work dir ${dir}:`, error);
    return;
  }
  createdByThisProcess.delete(dir);
  attempts.delete(dir);
}

/**
 * 空目录，或仅有 `.code-agent` 且其中至多空的 `stream-snapshots` 脚手架。
 * 快照 run 文件是断流恢复证据，存在即不回收（判据单一真源在
 * hasUnclearedStreamSnapshots）。任何其它名字、符号链接、非常规文件都算
 * 用户内容，返回 false。
 */
function isOnlyCodeAgentMetadata(dir: string): boolean {
  let rootStat: fsSync.Stats;
  try {
    rootStat = fsSync.lstatSync(dir);
  } catch {
    return false;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
  const top = readDirents(dir);
  if (!top) return false;
  if (top.length === 0) return true;
  if (top.length !== 1 || top[0].name !== '.code-agent') return false;
  if (!isRealDirectory(top[0])) return false;
  const codeAgentEntries = readDirents(path.join(dir, '.code-agent'));
  if (!codeAgentEntries) return false;
  if (codeAgentEntries.length === 0) return true;
  if (codeAgentEntries.length !== 1 || codeAgentEntries[0].name !== 'stream-snapshots') return false;
  if (!isRealDirectory(codeAgentEntries[0])) return false;
  return !hasUnclearedStreamSnapshots(dir);
}

function isRealDirectory(entry: fsSync.Dirent): boolean {
  return entry.isDirectory() && !entry.isSymbolicLink();
}

function readDirents(dir: string): fsSync.Dirent[] | undefined {
  try {
    return fsSync.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
}
