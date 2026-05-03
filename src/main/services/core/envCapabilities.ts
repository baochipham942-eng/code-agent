// ============================================================================
// envCapabilities — 启动时探测本地 CLI 能力，给模型注入 <env-capabilities> 提示
// ============================================================================
//
// 设计目的：让 agent 自主发现环境装了什么 CLI，而不是把工具清单硬编码进 prompt。
// 探针在 webServer/CLI 启动时跑一次，结果缓存在内存（不持久化）。新装 CLI 重启
// 即生效。检测失败的 CLI 直接不出现在清单里，不报错。
//
// 候选清单见 src/shared/constants/tools.ts: PROBED_CLI_CANDIDATES。
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../infra/logger';
import {
  PROBED_CLI_CANDIDATES,
  ENV_PROBE_TIMEOUT_MS,
} from '../../../shared/constants/tools';

const execAsync = promisify(exec);
const logger = createLogger('EnvCapabilities');

export interface EnvCapability {
  name: string;
  path: string;
}

let cached: EnvCapability[] | null = null;
let probePromise: Promise<EnvCapability[]> | null = null;

async function probeOne(cli: string): Promise<EnvCapability | null> {
  try {
    const { stdout } = await execAsync(`command -v ${cli}`, {
      timeout: ENV_PROBE_TIMEOUT_MS,
      env: process.env,
    });
    const path = stdout.trim();
    if (!path) return null;
    return { name: cli, path };
  } catch {
    return null;
  }
}

/**
 * 启动时调用一次（idempotent，重复调用复用同一个 promise）。
 * 不阻塞主流程；失败的 CLI 静默跳过。
 */
export async function probeEnvCapabilities(): Promise<EnvCapability[]> {
  if (cached) return cached;
  if (probePromise) return probePromise;

  probePromise = (async () => {
    const start = Date.now();
    const results = await Promise.all(PROBED_CLI_CANDIDATES.map(probeOne));
    const found = results.filter((x): x is EnvCapability => x !== null);
    cached = found;
    logger.info(
      `[EnvCapabilities] probed ${PROBED_CLI_CANDIDATES.length} candidates in ${Date.now() - start}ms, found ${found.length}: ${found.map((c) => c.name).join(', ')}`,
    );
    return found;
  })();

  return probePromise;
}

/**
 * 同步读取已探测结果。如果探针未跑完返回 null，调用方应优雅降级
 * （system prompt 不注入 <env-capabilities> 块即可）。
 */
export function getEnvCapabilities(): EnvCapability[] | null {
  return cached;
}

/** 测试 / 重置用（仅供测试） */
export function _resetEnvCapabilitiesForTesting(): void {
  cached = null;
  probePromise = null;
}
