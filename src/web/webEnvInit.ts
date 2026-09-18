// ============================================================================
// Web 环境初始化 — 必须在所有其他 import 之前加载
// ============================================================================
// secureStorage.ts 在模块加载时检查 CODE_AGENT_CLI_MODE 来决定是否 require('keytar')
// keytar 是 Electron native 模块，在系统 Node.js 下 require 会 SIGSEGV（exit 139）
// 所以必须在 secureStorage 模块初始化之前设置这个环境变量
// ============================================================================

// channelDataDir 只依赖 devSlot/configPaths（无 keytar 等 native 副作用），安全前置。
import * as os from 'os';
import { resolveChannelDataDir, resolveChannelWebPort, expandDataDirLongPath } from './channelDataDir';
import { detectDevSlotRuntime } from './devSlotRuntime';
import { devSlotDataDirName, devSlotWebPort } from '../shared/devSlot';

process.env.CODE_AGENT_CLI_MODE = 'true';
process.env.CODE_AGENT_WEB_MODE = 'true';

// 测试/开发通道：在任何模块读取数据目录（含 getUserConfigDir 的 module-level const）之前，
// 把 CODE_AGENT_DATA_DIR 切到对应 dev 槽，确保调试不污染生产包的 ~/.code-agent。
// 槽位规则见 channelDataDir.ts：主检出 → 槽 1；git 工作树 → 空闲最小槽（2..9），
// 全占 fail-closed 退出，绝不静默回落槽 1（爸的槽，2026-09-18 拍板）。
// 打包测试包由 Rust 显式注入 CODE_AGENT_DATA_DIR，此处会因已设置而跳过。
// 端口同步注入 WEB_PORT / CODE_AGENT_WEB_PORT（webServer 绑定读 WEB_PORT，auth /
// desktopShellDiagnostics 兜底读 CODE_AGENT_WEB_PORT）：数据目录去了槽 N 而端口停在生产
// 8180 等于白换槽。显式端口照办不覆盖，仅与槽端口不一致时提示（口径同数据目录）。
try {
  const decision = resolveChannelDataDir(process.env, os.homedir(), detectDevSlotRuntime());
  if (decision.dataDir) {
    process.env.CODE_AGENT_DATA_DIR = decision.dataDir;
    console.log(`[dev-slot] ${decision.reason} → dev 槽 ${decision.slot}（${decision.dataDir}）`); // console-scan-allow 启动期槽位提示：本文件先于 logger 初始化执行，须直出终端
  }
  const webPort = resolveChannelWebPort(process.env, decision);
  if (webPort.port !== undefined) {
    process.env.WEB_PORT = String(webPort.port);
    process.env.CODE_AGENT_WEB_PORT = String(webPort.port);
    console.log(`[dev-slot] 端口 → ${webPort.port}（devSlotWebPort(槽 ${decision.slot})）`); // console-scan-allow 启动期端口提示：本文件先于 logger 初始化执行，须直出终端
  } else if (webPort.explicitPortMismatch) {
    console.warn(`⚠️  ${webPort.explicitPortMismatch}`);
  }
  // 显式要槽 1（NEO_SLOT=1 / CODE_AGENT_DATA_DIR 指向槽 1 目录）照办，但打醒目提示让人
  // 当场看见。Tauri 托管的 spawn（有 boot token，槽位由 Rust 真源注入）不打扰。
  if (decision.slot1Notice && !process.env.CODE_AGENT_TAURI_BOOT_TOKEN) {
    console.warn(
      `⚠️  [dev-slot] 你正在使用槽 1（爸的槽 ~/${devSlotDataDirName(1)}，端口 ${devSlotWebPort(1)}）——确认这是你想要的。`,
    );
  }
} catch (error) {
  console.error(`\n${(error as Error).message}\n`);
  process.exit(1);
}

// 数据目录展开为真实长路径（Windows 8.3 短名会让 fs.watch 的 libuv 断言 abort，
// issue #1072）。必须在任何消费方（configPaths.getUserConfigDir / appPaths.getUserDataPath
// 及其派生的 skillWatcher/soulLoader 等 fs.watch）读到之前做，一处归一化全链路生效。
// 未设置时沿用 <home>/.code-agent 惰性默认，不在此显式落 env（保持 CODE_AGENT_HOME 语义）。
const explicitDataDir = process.env.CODE_AGENT_DATA_DIR?.trim();
if (explicitDataDir) {
  process.env.CODE_AGENT_DATA_DIR = expandDataDirLongPath(explicitDataDir);
}
