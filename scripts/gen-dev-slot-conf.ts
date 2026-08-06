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
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  devSlotBundleId,
  devSlotDataDirName,
  devSlotProductName,
  devSlotWebPort,
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

function main(): void {
  const slot = parseDevSlot(process.env.NEO_SLOT);
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
