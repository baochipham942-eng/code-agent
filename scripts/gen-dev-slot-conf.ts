// ============================================================================
// 按 NEO_SLOT 生成 dev 测试包的 Tauri 配置
// ============================================================================
// 一台机器要同时跑多个 worktree 打出来的测试包，四个维度必须全部错开：
// identifier / productName（安装槽）/ webServer 端口 / 数据目录。前两个在这份配置里，
// 后两个由 Rust 从 identifier 的 `.dev[N]` 后缀推导（src-tauri/src/main.rs 的 dev_slot）。
//
// 模板 = 已提交的 src-tauri/tauri.dev.conf.json（即槽 1 的成品，可直接 review）；
// 本脚本只改三个叶子，输出到同目录的 tauri.dev.slot.conf.json（gitignore）。
// 输出与模板同目录是硬要求——配置里 bundle.resources 用的是相对路径。
//
// 用法：NEO_SLOT=2 npm run tauri:build:dev
// ============================================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  devSlotBundleId,
  devSlotDataDirName,
  devSlotProductName,
  devSlotWebPort,
  MAX_DEV_SLOT,
  parseDevSlot,
} from '../src/shared/devSlot';

const MODULE_PATH = fileURLToPath(import.meta.url);
const TAURI_DIR = path.resolve(path.dirname(MODULE_PATH), '..', 'src-tauri');
const TEMPLATE_PATH = path.join(TAURI_DIR, 'tauri.dev.conf.json');
const OUTPUT_PATH = path.join(TAURI_DIR, 'tauri.dev.slot.conf.json');
/**
 * 槽位元数据旁路文件。Tauri 配置里塞不下端口/数据目录这些非 Tauri 字段，而安装与验证
 * 脚本（bash）又需要它们——写在这里，让 shell 侧「读」而不是各自再实现一遍后缀规则。
 */
const METADATA_PATH = path.join(TAURI_DIR, '.dev-slot.json');
/** 模板（槽 1）CSP 里的端口字面量；替换成本槽端口。 */
const TEMPLATE_PORT_TOKEN = 'localhost:8181';

export function buildSlotConfig(template: Record<string, unknown>, slot: number): Record<string, unknown> {
  const port = devSlotWebPort(slot);
  const app = template.app as { security?: { csp?: string } } | undefined;
  const csp = app?.security?.csp;
  if (typeof csp !== 'string' || !csp.includes(TEMPLATE_PORT_TOKEN)) {
    // 模板 CSP 与槽 1 端口脱钩了就停下：静默生成一份 CSP 指向别的端口的配置，
    // 表现是打出来的包白屏，且看不出跟这里有关。
    throw new Error(
      `${TEMPLATE_PATH} 的 app.security.csp 里找不到 "${TEMPLATE_PORT_TOKEN}"，无法派生槽 ${slot} 的 CSP`,
    );
  }

  return {
    ...template,
    productName: devSlotProductName(slot),
    identifier: devSlotBundleId(slot),
    app: {
      ...(app ?? {}),
      security: {
        ...(app?.security ?? {}),
        csp: csp.replaceAll(TEMPLATE_PORT_TOKEN, `localhost:${port}`),
      },
    },
  };
}

/** macOS 安装目录；`Agent Neo Dev [N].app` 装在这里。 */
const APPLICATIONS_DIR = '/Applications';

/**
 * 这台机器已经认识的 dev 槽 = 槽池成员：**已装 app 或存在数据目录，两者取并集**。
 *
 * 取并集是因为两条痕迹各自都会缺席，而缺席都不代表「这是个新槽」：
 *   - 数据目录会被反复抹掉——抹它正是拿到干净状态的正确做法，不能因此把槽判成新的；
 *   - app 会被卸载或换槽重装，但 TCC 记录按 bundle id 留在系统里，重装不用重新授权。
 * 只有两条痕迹都没有，才是真的没在这台机器上出现过。
 */
export function knownDevSlots(
  homeDir: string,
  appsDir: string = APPLICATIONS_DIR,
  exists: (p: string) => boolean = fs.existsSync,
): number[] {
  const slots: number[] = [];
  for (let slot = 1; slot <= MAX_DEV_SLOT; slot += 1) {
    const installed = exists(path.join(appsDir, `${devSlotProductName(slot)}.app`));
    const hasData = exists(path.join(homeDir, devSlotDataDirName(slot)));
    if (installed || hasData) slots.push(slot);
  }
  return slots;
}

/**
 * 扩池必须显式。
 *
 * 每个槽是一个独立 bundle identifier，macOS TCC 按 bundle id + 签名记账，**新槽 = 零授权**，
 * 要重新手工点一遍辅助功能/屏幕录制/输入监控。2026-08-08 实测：有人只是想要「干净状态验更新
 * 链路」就新开了槽 3，于是弹出一串写着「Agent Neo Dev 3 要接收按键」的框——跟他正在做的事
 * 毫无关系，还得停下来点。那次本该抹掉某个空闲槽的数据目录，成本为零。
 *
 * 所以这里把两件被混淆的事分开：
 *   要干净状态 → 抹数据目录（bundle id 不变，授权原样保留）
 *   要并发跑多个包 → 才需要一个新槽（并接受一次新授权）
 *
 * 池是空的（全新机器）时放行——没有可复用的槽，拦下来只会挡住第一次构建。
 */
export function assertSlotInPool(slot: number, poolSlots: number[], allowNew: boolean): void {
  if (poolSlots.includes(slot) || poolSlots.length === 0 || allowNew) return;

  const pool = poolSlots
    .map((s) => `    槽 ${s}：${devSlotProductName(s)}.app，干净状态用 rm -rf ~/${devSlotDataDirName(s)}`)
    .join('\n');
  throw new Error(
    `NEO_SLOT=${slot} 是一个尚未安装的新槽，而池里已有可复用的槽：\n${pool}\n`
      + '  「要干净状态」不是开新槽的理由——抹掉上面任一槽的数据目录即可，'
      + 'bundle id 不变，TCC 授权原样保留。\n'
      + '  只有需要同时跑多个测试包（各自独立端口与数据目录）才要扩池。\n'
      + `  确实要扩池就显式声明：NEO_SLOT=${slot} NEO_SLOT_NEW=1 npm run tauri:build:dev\n`
      + '  （扩池意味着这台机器上多一个 app 身份，要重新走一遍系统授权。）',
  );
}

function main(): void {
  const slot = parseDevSlot(process.env.NEO_SLOT);
  assertSlotInPool(slot, knownDevSlots(os.homedir()), process.env.NEO_SLOT_NEW === '1');
  const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8')) as Record<string, unknown>;
  const config = buildSlotConfig(template, slot);
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(
    METADATA_PATH,
    `${JSON.stringify(
      {
        slot,
        productName: devSlotProductName(slot),
        identifier: devSlotBundleId(slot),
        webPort: devSlotWebPort(slot),
        dataDirName: devSlotDataDirName(slot),
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `[gen-dev-slot-conf] slot ${slot} → ${config.productName as string} `
      + `(${config.identifier as string}, port ${devSlotWebPort(slot)}) → ${OUTPUT_PATH}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  main();
}
