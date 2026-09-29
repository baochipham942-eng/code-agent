import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * 自清临时沙箱（N-GATES-TMP-SELFCLEAN）。
 *
 * 背景：一次 gates:local 被打断会留下 ~3G 的 `vitest*` / `code-agent-*` 临时目录——脚本只在自己
 * 的 finally 里 rmSync，SIGTERM/SIGKILL 之前那条路径根本走不到。09-05 晚磁盘剩 7.6G 被手动清理。
 *
 * 用法：把「自己建的那轮临时根」从 `fs.mkdtempSync(...)` 换成 `createOwnedTmp(prefix)`。目录会被
 * 登记进模块内的 Set，进程退出（正常 exit / SIGINT / SIGTERM / SIGHUP）时**只删自己登记的路径**，
 * 绝不碰别人的目录（08-18 教训：只删自己记下的路径，禁止通配符删别人正在跑的 run 根）。
 *
 * 排障：`--keep-tmp` 参数或 `CODE_AGENT_KEEP_TMP=1` 让本轮保留所有登记目录并打印路径。
 *
 * 信号共存：信号钩子清完后，只有当本模块是该信号唯一的监听者时才 `process.exit(130)`——宿主脚本
 * （如 gates-fast 的命令中断协议、gates-local 的 releaseLock）先注册的处理器会先收到信号，把
 * 「怎么退」的决定权留给它们；它们最终调 `process.exit` 时 exit 钩子会再兜底清一次（幂等）。
 */

const KEEP_TMP_ENV = 'CODE_AGENT_KEEP_TMP';
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const ownedPaths = new Set();
let hooksInstalled = false;
let keepTmpOverride;

function keepTmpRequested() {
  // 显式传过 keepTmp 的就以它为准（后续钩子/释放沿用同一决定，避免 create 与 exit 时判不一致）。
  if (keepTmpOverride !== undefined) return keepTmpOverride;
  return process.argv.includes('--keep-tmp') || process.env[KEEP_TMP_ENV] === '1';
}

function cleanupAll(trigger) {
  if (!ownedPaths.size) return;
  const keep = keepTmpRequested();
  for (const dir of ownedPaths) {
    if (keep) {
      console.error(`[tmp-sandbox] keep-tmp：保留 ${dir}（${trigger}）`);
    } else {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        // 清不掉不能让进程死在钩子里，但必须留下可判因的痕迹。
        console.error(`[tmp-sandbox] 清理失败 ${dir}（${trigger}）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  ownedPaths.clear();
}

function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on('exit', () => cleanupAll('exit'));
  for (const signal of SIGNALS) {
    process.on(signal, () => {
      cleanupAll(signal);
      // 此刻自己仍被计入 listenerCount；<=1 说明没有别人接管退出，才代替默认终止动作。
      if (process.listenerCount(signal) <= 1) process.exit(130);
    });
  }
}

/**
 * 建一个登记在册的临时目录并返回路径。prefix 沿用 mkdtemp 语义（会被追加随机后缀）。
 * parentDir 缺省 os.tmpdir()；eval 的 case 级目录建在自己的数据根下面，不是系统 tmp。
 */
export function createOwnedTmp(prefix, { parentDir = os.tmpdir(), keepTmp } = {}) {
  installHooks();
  if (keepTmp !== undefined) keepTmpOverride = keepTmp;
  const dir = fs.mkdtempSync(path.join(parentDir, prefix));
  ownedPaths.add(dir);
  if (keepTmpRequested()) console.error(`[tmp-sandbox] keep-tmp：本轮将保留 ${dir}`);
  return dir;
}

/**
 * 正常路径的主动释放：从登记表摘掉并删除。keepTmp 生效时只保留并打印路径（排障用）。
 * 信号/退出钩子仍然兜底——这里删过之后 Set 里已没有它，钩子不会重复处理。
 */
export function releaseOwnedTmp(dir, { keepTmp } = {}) {
  if (keepTmp !== undefined) keepTmpOverride = keepTmp;
  if (!ownedPaths.has(dir) && !fs.existsSync(dir)) return;
  ownedPaths.delete(dir);
  if (keepTmpRequested()) {
    console.error(`[tmp-sandbox] keep-tmp：保留 ${dir}（release）`);
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
