// ============================================================================
// CLI Config Service - 兼容性入口
// ============================================================================
//
// 历史背景：
// 在 4c8b5d7d 之前，CLI/webServer 走本文件的 CLIConfigService 类，Tauri main
// 走 src/main/services/core/configService.ts 的 ConfigService。两个类各自维护
// read 路径与 fallback，导致"UI 选了 A、推理走 B"事故（UI 显示 MiMo v2.5 Pro，
// webServer 实际把请求路由到 zhipu/glm-5）。
//
// 4c8b5d7d 仅对齐了文件路径（同读 ~/.code-agent/config.json），但两个类还在 —
// 任何加新 getter / 新 fallback 的修改都得手动同步两边，故障会换姿势复发。
//
// P0-2 重构：CLIConfigService 类删除，CLI/webServer 直接复用 main ConfigService
// 单例。CLI 模式下 keytar 不加载（CODE_AGENT_CLI_MODE 守卫，见 secureStorage.ts），
// app.getPath('userData') 通过 electronMock 解析到 ~/.code-agent，因此 main
// ConfigService.initialize() 自然跳过 keychain 路径、读取同一份 config.json。
//
// 本文件保留：
//   - .env 加载（CLI 入口最早执行的副作用，保持向后兼容）
//   - getCLIConfigService() 工厂函数 — 返回 main ConfigService 实例（窄成
//     IReadConfigService 视图，避免 CLI 路径误用 write 方法）
//   - CLIConfigService type alias —  外部 import { type CLIConfigService } 兼容
//
// Refs: 4c8b5d7d
// ============================================================================

import path from 'path';
import fs from 'fs';
import os from 'os';
import * as dotenv from 'dotenv';
import type { IReadConfigService } from '../shared/contract/configService';
import { getConfigService as getMainConfigService } from '../host/services/core/configService';

// 加载 .env 文件（CLI 模式专用：从 process.cwd() 或 ~/.code-agent/.env 读取）
function loadEnvFile(): void {
  const possiblePaths = [
    path.join(process.cwd(), '.env'),
    path.join(os.homedir(), '.code-agent', '.env'),
  ];

  for (const envPath of possiblePaths) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath, quiet: true });
      break;
    }
  }
}

// 初始化时加载 .env
loadEnvFile();

/**
 * CLI 模式下的配置服务类型
 *
 * 实际是 main ConfigService 的 read-only 视图。保留这个 type alias 是为了
 * 外部 import { type CLIConfigService } 不至于断（cli/bootstrap.ts 等）。
 */
export type CLIConfigService = IReadConfigService;

/**
 * 获取 CLI 配置服务（主进程 ConfigService 单例的 read-only 视图）
 *
 * 调用方应在调用之前确保 main ConfigService 已 initialize（CLI bootstrap 与
 * webServer 入口都已经走过 initConfigService + initialize 流程）。
 */
export function getCLIConfigService(): CLIConfigService {
  return getMainConfigService();
}
