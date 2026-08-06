// ============================================================================
// Dev 槽位身份（多个测试包并存的单一真值源）
// ============================================================================
// 一台机器上要同时跑多个 worktree 打出来的测试包，就必须让它们在**四个维度**上
// 全部错开，少一个都会打架：
//   bundle identifier（LaunchServices/TCC 认这个）、productName（/Applications 安装槽）、
//   webServer 端口、数据目录。
//
// 全部由「identifier 的 .dev 后缀」派生：`.dev` = 槽 1（等于历史行为，零迁移），
// `.dev2`…`.dev9` = 槽 2…9。Rust 侧同源实现在 src-tauri/src/main.rs 的 dev_slot()，
// 两边必须一起改——它才是运行时真源（注入 CODE_AGENT_WEB_PORT / CODE_AGENT_DATA_DIR），
// 本模块用于构建期生成配置与运行期隔离自检。
//
// CUA helper 的 bundle id **不按槽位分**（只分 production / dev，见 cuaHelperChannel.ts）：
// 每个槽一份重签 .app 意味着每槽一次下载+Developer ID 重签，成本远大于「槽间 TCC 各授权
// 一次」的收益。
// ============================================================================

import { CONFIG_DIR_DEV } from './constants/configDir';

/** 生产通道 webServer 端口；槽 N 用 PROD_WEB_PORT + N。 */
export const PROD_WEB_PORT = 8180;

/** 生产 bundle identifier；dev 槽在其后缀 `.dev[N]`。 */
export const PROD_BUNDLE_ID = 'com.linchen.code-agent';

/** 生产产品名；dev 槽为 `Agent Neo Dev` / `Agent Neo Dev 2`… */
const PROD_PRODUCT_NAME = 'Agent Neo';

/**
 * 槽位上限 9。不是怕端口不够，是怕**误配的槽号静默变成一个新的空数据目录**——
 * 有界 + 拒绝越界，让写错的 NEO_SLOT 立刻报错而不是悄悄开一套新库。
 */
export const MAX_DEV_SLOT = 9;

/**
 * 从 bundle identifier 反推 dev 槽位号；不是 dev 包返回 null。
 *
 * 只接受严格形态 `<prefix>.dev` 或 `<prefix>.dev<N>`（N 为 2..MAX_DEV_SLOT 的十进制），
 * 避免 `.developer` / `.dev-old` / `.dev02` 之类被误判成 dev 通道——误判的代价是测试包
 * 直接写生产数据目录。
 */
export function devSlotFromBundleId(bundleId: string | undefined | null): number | null {
  if (!bundleId) return null;
  const match = /\.dev(\d*)$/.exec(bundleId);
  if (!match) return null;
  const digits = match[1];
  if (digits === '') return 1;
  if (!/^[1-9]\d*$/.test(digits)) return null; // 拒绝 `.dev0` / `.dev02`
  const slot = Number(digits);
  return slot >= 1 && slot <= MAX_DEV_SLOT ? slot : null;
}

/** 校验并归一化 NEO_SLOT；缺省=1。越界/非法一律抛错，不回退。 */
export function parseDevSlot(raw: string | undefined | null): number {
  const trimmed = raw?.trim();
  if (!trimmed) return 1;
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`Invalid NEO_SLOT=${raw} (expected an integer 1..${MAX_DEV_SLOT})`);
  }
  const slot = Number(trimmed);
  if (slot > MAX_DEV_SLOT) {
    throw new Error(`Invalid NEO_SLOT=${raw} (expected an integer 1..${MAX_DEV_SLOT})`);
  }
  return slot;
}

function assertSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_DEV_SLOT) {
    throw new Error(`Invalid dev slot ${slot} (expected an integer 1..${MAX_DEV_SLOT})`);
  }
}

/** 槽 1 沿用历史后缀 `.dev`，槽 N 用 `.devN`。 */
export function devSlotBundleId(slot: number): string {
  assertSlot(slot);
  return slot === 1 ? `${PROD_BUNDLE_ID}.dev` : `${PROD_BUNDLE_ID}.dev${slot}`;
}

/** /Applications 里的安装槽名，也是 install 脚本的 APP_NAME。 */
export function devSlotProductName(slot: number): string {
  assertSlot(slot);
  return slot === 1 ? `${PROD_PRODUCT_NAME} Dev` : `${PROD_PRODUCT_NAME} Dev ${slot}`;
}

/** 数据目录名（home 下）：槽 1 沿用 `.code-agent-dev`。 */
export function devSlotDataDirName(slot: number): string {
  assertSlot(slot);
  return slot === 1 ? CONFIG_DIR_DEV : `${CONFIG_DIR_DEV}${slot}`;
}

/** webServer 端口：8181、8182…（生产 8180）。 */
export function devSlotWebPort(slot: number): number {
  assertSlot(slot);
  return PROD_WEB_PORT + slot;
}

/** 从数据目录名反推槽位号（`devSlotDataDirName` 的逆），不是 dev 目录返回 null。 */
export function devSlotFromDataDirName(dirName: string): number | null {
  if (dirName === CONFIG_DIR_DEV) return 1;
  if (!dirName.startsWith(CONFIG_DIR_DEV)) return null;
  const digits = dirName.slice(CONFIG_DIR_DEV.length);
  if (!/^[1-9]\d*$/.test(digits)) return null;
  const slot = Number(digits);
  return slot >= 1 && slot <= MAX_DEV_SLOT ? slot : null;
}
