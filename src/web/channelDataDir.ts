// ============================================================================
// 运行通道 → 数据目录解析（测试/开发包与生产包并存的核心）
// ============================================================================
// 生产包用 ~/.code-agent，测试/开发通道用 ~/.code-agent-dev（槽 1），槽 N（2..9）用
// ~/.code-agent-devN，各槽数据（DB、密钥、会话、缓存）物理隔离，互不污染。
// 本模块只负责"决定切不切、切到哪"，是纯函数，由 webEnvInit 在所有其他 import
// 之前应用到 process.env。槽位命名/端口规则单一真源在 src/shared/devSlot.ts，只引用不重算。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { MAX_DEV_SLOT, devSlotDataDirName, devSlotWebPort, parseDevSlot } from '../shared/devSlot';

/**
 * 槽位探测上下文 — 「当前是不是 git 工作树」「哪个槽空闲」由调用方（webEnvInit 经
 * devSlotRuntime 探测）注入，本模块保持纯函数、不读 fs / 不探端口，便于单测。
 */
export interface DevSlotProbeContext {
  /** 当前检出是否 git linked worktree（主检出为 false）。 */
  isGitWorktree: () => boolean;
  /** 槽位是否空闲：端口 8180+N 无人监听 且 数据目录无活进程持有。 */
  isSlotFree: (slot: number) => boolean;
  /** 槽位占用详情（pid/判据），拼进 fail-closed 报错里；可缺省。 */
  describeSlotOccupancy?: (slot: number) => string;
}

/** resolveChannelDataDir 的决策结果；字段缺省 = 不动 process.env。 */
export interface ChannelDataDirDecision {
  /** 要切到的数据目录；undefined = 已显式设置或生产通道，不覆盖。 */
  dataDir?: string;
  /** 命中的 dev 槽位号（1..MAX_DEV_SLOT）。 */
  slot?: number;
  /** 槽位决策来源：主检出默认 / 工作树自动选槽 / 显式 NEO_SLOT。 */
  reason?: 'main-checkout' | 'worktree-auto' | 'explicit-slot';
  /** 落到槽 1（爸的槽）时由调用方打醒目提示。 */
  slot1Notice?: boolean;
}

/** resolveChannelWebPort 的决策结果；字段缺省 = 不动 process.env 的端口。 */
export interface ChannelWebPortDecision {
  /** 要写入 WEB_PORT / CODE_AGENT_WEB_PORT 的槽位端口；undefined = 有显式端口或无槽位决策。 */
  port?: number;
  /** 显式端口与所选槽端口不一致时的一行提示（由调用方打出来）。 */
  explicitPortMismatch?: string;
}

/** 缺省探测上下文 = 主检出的语义：不是工作树（→ 槽 1），槽位恒视为空闲。 */
const MAIN_CHECKOUT_PROBE: DevSlotProbeContext = {
  isGitWorktree: () => false,
  isSlotFree: () => true,
};

/**
 * 决定当前 node 进程应把数据目录切到测试/开发通道的哪个槽。
 *
 * 优先级（显式永远优先；挑不到就 fail-closed，绝不静默回落槽 1）：
 *  1. 已显式设置 CODE_AGENT_DATA_DIR（如打包测试包由 Rust 注入）→ 不覆盖；若它恰好
 *     就是槽 1 目录，标记 slot1Notice 让调用方打醒目提示。
 *  2. 生产通道（NODE_ENV==='production' 且无 dev 标记）→ 不切（沿用 ~/.code-agent）。
 *  3. 显式 NEO_SLOT → 用该槽（非法值由 parseDevSlot 抛错）；槽被活实例占用则抛错
 *     拒绝启动（fail-closed，判据与 tauri-install-dev.sh 的 refuse_if_tauri_slot_in_use 同口径）。
 *  4. 主检出（非 git 工作树）→ 槽 1（历史行为，零迁移，爸的日常不受影响）。
 *  5. git 工作树 → 不许用槽 1（那是爸的槽），自动挑当前空闲的最小槽（2..9）；
 *     全占则抛错，提示显式指定 NEO_SLOT / CODE_AGENT_DATA_DIR。
 *
 * 纯函数，不读取/写入真实环境，便于单测。
 */
export function resolveChannelDataDir(
  env: NodeJS.ProcessEnv,
  homedir: string,
  ctx: DevSlotProbeContext = MAIN_CHECKOUT_PROBE,
): ChannelDataDirDecision {
  const explicit = env.CODE_AGENT_DATA_DIR?.trim();
  if (explicit) {
    // 已显式指定，不覆盖。显式要槽 1 照办，但标记出来让人当场看见。
    const slot1Dir = path.join(homedir, devSlotDataDirName(1));
    const isSlot1 = path.resolve(explicit) === path.resolve(slot1Dir);
    return isSlot1 ? { slot: 1, slot1Notice: true } : {};
  }

  const channel = env.CODE_AGENT_CHANNEL?.trim().toLowerCase();
  const isDevChannel = channel === 'dev' || (env.NODE_ENV ?? '').trim() !== 'production';
  if (!isDevChannel) return {};

  const rawSlot = env.NEO_SLOT?.trim();
  if (rawSlot) {
    const slot = parseDevSlot(rawSlot); // 非法/越界直接抛错，不回退
    if (!ctx.isSlotFree(slot)) {
      throw new Error(
        `[dev-slot] 拒绝启动：显式指定的 dev 槽 ${slot}（~/${devSlotDataDirName(slot)}，端口 ${devSlotWebPort(
          slot,
        )}）正有实例占用，起服务会跟它抢同一套数据目录。\n` +
          `${ctx.describeSlotOccupancy?.(slot) ?? ''}\n` +
          `  → 换一个槽（NEO_SLOT=<n>）或等占用者退出。`,
      );
    }
    return {
      dataDir: path.join(homedir, devSlotDataDirName(slot)),
      slot,
      reason: 'explicit-slot',
      slot1Notice: slot === 1,
    };
  }

  if (!ctx.isGitWorktree()) {
    // 主检出：历史行为原样保留（槽 1，不打扰爸的日常）。
    return { dataDir: path.join(homedir, devSlotDataDirName(1)), slot: 1, reason: 'main-checkout' };
  }

  // git 工作树：槽 1 是爸的（Agent Neo Dev.app / 8181 / ~/.code-agent-dev），
  // 从 2 起挑当前空闲的最小槽；挑不到 fail-closed，不静默回落。
  const busyDetail: string[] = [];
  for (let slot = 2; slot <= MAX_DEV_SLOT; slot++) {
    if (ctx.isSlotFree(slot)) {
      return { dataDir: path.join(homedir, devSlotDataDirName(slot)), slot, reason: 'worktree-auto' };
    }
    busyDetail.push(
      ctx.describeSlotOccupancy?.(slot) ?? `  槽 ${slot}（~/${devSlotDataDirName(slot)}）：占用详情不可用`,
    );
  }
  throw new Error(
    `[dev-slot] 拒绝启动：本检出是 git 工作树，不许用槽 1（爸的槽 ~/${devSlotDataDirName(1)}），` +
      `槽 2..${MAX_DEV_SLOT} 又全被占用：\n${busyDetail.join('\n')}\n` +
      `  → 显式指定 NEO_SLOT=<n> 或 CODE_AGENT_DATA_DIR=<path> 再跑。`,
  );
}

/**
 * 决定当前 node 进程的 webServer 端口要不要跟着槽位决策走。
 *
 * 数据目录切到了槽 N 而端口还停在生产默认 8180 等于白换槽：照样和生产包抢 8180、
 * 两个工作树撞同一端口、tauri-slot-process-guard 与 isSlotFree 的「本槽端口 8180+N
 * 有没有 LISTEN」判据永远探不到本进程（守卫空转）。与 CODE_AGENT_DATA_DIR 同口径：
 *  1. 无槽位决策（生产通道 / 显式数据目录未指向槽 1）→ 不动端口；
 *  2. 已显式设置 WEB_PORT（webServer 的绑定读法）或 CODE_AGENT_WEB_PORT（Rust
 *     apply_channel_env 的注入口径）→ 照办不覆盖，但与所选槽端口不一致时给一行提示；
 *  3. 其余 → 注入 devSlotWebPort(slot)，不在消费方重算 8180+N（单一真源，两处各算
 *     一遍就会在换槽时错开）。
 *
 * 纯函数，不读写真实环境，便于单测。
 */
export function resolveChannelWebPort(
  env: NodeJS.ProcessEnv,
  decision: ChannelDataDirDecision,
): ChannelWebPortDecision {
  if (decision.slot === undefined) return {};
  const slotPort = devSlotWebPort(decision.slot);
  const explicitRaw = env.WEB_PORT?.trim() || env.CODE_AGENT_WEB_PORT?.trim() || '';
  if (!explicitRaw) return { port: slotPort };
  const explicitPort = parseInt(explicitRaw, 10);
  if (Number.isFinite(explicitPort) && explicitPort !== slotPort) {
    return {
      explicitPortMismatch:
        `[dev-slot] 显式端口 ${explicitRaw} 与槽 ${decision.slot} 的端口 ${slotPort} 不一致，` +
        `按显式值照办——若非有意指定，去掉显式端口让槽位端口接管。`,
    };
  }
  return {};
}

/**
 * 把数据目录展开为真实长路径。Windows 8.3 短名（RUNNER~1、长用户名机器的
 * TEMP/AppData）会让 webServer 内 fs.watch 的 libuv 断言直接 abort 进程
 * （src/win/fs-event.c:72，0xC0000409，issue #1072）；Rust 侧 compile-cache
 * warmup 更是把 env::temp_dir() 原样注入 CODE_AGENT_DATA_DIR。目录可能尚不
 * 存在（首启），先建再解析；解析失败返回原值——宁可维持旧行为也不能把数据
 * 目录改坏。macOS 上仅解析 /var→/private/var 一类 symlink，前后一致使用无
 * 行为差异（同 scripts/acceptance/_helpers.ts 的 mkdtempLongPath）。
 */
export function expandDataDirLongPath(dir: string): string {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return fs.realpathSync.native(dir);
  } catch (error) {
    console.warn(`[channelDataDir] data dir realpath normalization failed, keeping as-is: ${dir}`, error);
    return dir;
  }
}
